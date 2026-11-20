"""Validated, versioned shopping-requirement state.

The model may propose entities, but this module owns evidence validation,
normalisation, deterministic fallbacks, state merging and legacy adapters.
"""

from __future__ import annotations

import copy
import json
import math
import re
from pathlib import Path


SCHEMA_VERSION = 1
ENTITY_TYPES = ("category", "brand", "color", "size", "material")
SOURCE_CAPABILITIES = {
    "category": ["query", "post_filter"],
    "brand": ["query", "post_filter"],
    "color": ["query", "ranking"],
    "size": ["query", "ranking"],
    "price": ["api_filter", "post_filter", "ranking"],
    "material": ["query", "ranking"],
    "otherAttributes": ["query", "ranking"],
}

_GENERIC_PRODUCTS = ("好物", "东西", "商品", "随便", "给我看看", "给我")
_BUY_VERBS = r"我要买|我想买|想买|想找|想要|帮我找|推荐|看看|找|换成|改成"
_CLASSIFIERS = r"一个|一条|一件|一双|一把|一张|一台|一套|一款|一些"
_COLORS = ("黑色", "白色", "米白色", "红色", "蓝色", "绿色", "灰色", "粉色", "紫色", "黄色", "棕色")
_MATERIALS = ("实木", "原木", "不锈钢", "316L不锈钢", "304不锈钢", "玻璃", "金属", "竹", "陶瓷", "棉", "羊毛", "真皮")
_KNOWN_BRANDS = ("苏泊尔", "美的", "小米", "华为", "苹果", "格力", "海尔", "九阳", "飞利浦", "戴森", "松下", "耐克", "阿迪达斯")


def empty_requirement(raw_text: str = "") -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "intent": "search_product",
        "rawText": raw_text,
        "category": None,
        "brands": {"include": [], "exclude": []},
        "colors": {"include": [], "exclude": []},
        "sizes": [],
        "price": None,
        "materials": {"include": [], "exclude": []},
        "otherAttributes": {},
        "scenes": [],
        "freeTextRequirements": [],
        "hardConstraints": [],
        "softPreferences": [],
        "missingImportantFields": [],
        "nextAction": "search",
        "parseWarnings": [],
    }

class AliasResolver:
    """Resolve approved aliases without letting model output mutate the catalog."""

    def __init__(self, path: str | Path | None = None):
        path = Path(path) if path else Path(__file__).with_name("data") / "entity_aliases.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = {}
        self.version = int(payload.get("version") or 1)
        self._groups = payload.get("entities") if isinstance(payload.get("entities"), list) else []

    def resolve(self, entity_type: str, raw: str) -> tuple[str, list[str], str]:
        value = re.sub(r"\s+", "", str(raw or "").strip())
        if not value:
            return "", [], "unresolved"
        folded = value.casefold()
        for row in self._groups:
            if not isinstance(row, dict) or row.get("entityType") != entity_type:
                continue
            aliases = [str(item).strip() for item in row.get("aliases", []) if str(item).strip()]
            canonical = str(row.get("canonical") or "").strip()
            if folded in {item.casefold() for item in [canonical, *aliases]}:
                values = list(dict.fromkeys([canonical, *aliases]))
                return canonical, values, str(row.get("relation") or "equivalent")
        return value, [value], "unresolved"


DEFAULT_ALIAS_RESOLVER = AliasResolver()


def _entity(raw, text: str, entity_type: str, *, default_hard: bool = True) -> dict | None:
    if isinstance(raw, str):
        raw = {"raw": raw, "evidence": raw, "source": "explicit", "confidence": 1.0}
    if not isinstance(raw, dict):
        return None
    value = str(raw.get("raw") or raw.get("value") or raw.get("canonical") or "").strip()
    evidence = str(raw.get("evidence") or "").strip()
    source = str(raw.get("source") or "explicit")
    confidence = raw.get("confidence", 1.0)
    if not value or len(value) > 40 or source not in {"explicit", "derived", "remembered", "unknown"}:
        return None
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.0
    if source == "explicit" and (not evidence or evidence not in text):
        return None
    canonical, aliases, relation = DEFAULT_ALIAS_RESOLVER.resolve(entity_type, value)
    return {
        "raw": value,
        "canonical": canonical,
        "aliases": aliases,
        "relation": relation,
        "confidence": confidence,
        "source": source,
        "evidence": evidence or None,
        "hard": bool(raw.get("hard", default_hard and source == "explicit")),
    }


def _entity_changes(value, text: str, entity_type: str) -> dict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for operation in ("addInclude", "replaceInclude", "addExclude", "replaceExclude"):
        rows = value.get(operation)
        if not isinstance(rows, list):
            continue
        parsed = [_entity(row, text, entity_type, default_hard=operation.endswith("Exclude")) for row in rows]
        parsed = [row for row in parsed if row]
        if parsed:
            result[operation] = parsed
    if value.get("clear") is True:
        result["clear"] = True
    return result


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _price(raw, text: str) -> dict | None:
    if not isinstance(raw, dict):
        return None
    minimum, maximum = _number(raw.get("min")), _number(raw.get("max"))
    evidence = str(raw.get("evidence") or "").strip()
    source = str(raw.get("source") or "explicit")
    if minimum is None and maximum is None:
        return None
    if minimum is not None and minimum < 0 or maximum is not None and maximum <= 0:
        return None
    if minimum is not None and maximum is not None and minimum > maximum:
        return None
    if source == "explicit" and (not evidence or evidence not in text):
        return None
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 1.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    return {"min": minimum, "max": maximum, "currency": "CNY",
            "hard": bool(raw.get("hard", source == "explicit")),
            "confidence": confidence, "source": source,
            "evidence": evidence or None}


def _legacy_to_changes(raw: dict, text: str) -> dict:
    query = raw.get("query") if isinstance(raw.get("query"), dict) else {}
    changes = {}
    if query.get("category"):
        changes["category"] = {"set": {"raw": query["category"], "evidence": str(query["category"]), "source": "explicit"}}
    for legacy, target, plural in (("brand", "brands", "brand"), ("color", "colors", "color"), ("material", "materials", "material")):
        if query.get(legacy):
            changes[target] = {"addInclude": [{"raw": query[legacy], "evidence": str(query[legacy]), "source": "explicit"}]}
    if query.get("maxPrice") is not None:
        match = re.search(r"(?:\d+(?:\.\d+)?\s*(?:元)?\s*(?:以内|以下)|(?:预算|不超过|低于|少于|最多|控制在)[^，。]*?\d+(?:\.\d+)?)", text)
        if match:
            changes["price"] = {"set": {"max": query["maxPrice"], "evidence": match.group(0), "source": "explicit", "hard": True}}
    if query.get("scene"):
        changes["scenes"] = {"add": [{"raw": query["scene"], "evidence": str(query["scene"]), "source": "explicit"}]}
    return changes


def validate_requirement_delta(raw: dict, text: str, has_current: bool = False) -> dict:
    """Validate model output and enforce the evidence gate."""
    raw = raw if isinstance(raw, dict) else {}
    changes = raw.get("changes") if isinstance(raw.get("changes"), dict) else _legacy_to_changes(raw, text)
    result = {"intent": str(raw.get("intent") or "search_product"), "changes": {}, "parseWarnings": []}
    allowed_intents = {"search_product", "refine_search", "compare_current", "current_detail", "explore", "stop_selling", "recall", "clarify"}
    if result["intent"] not in allowed_intents:
        result["intent"] = "search_product"
    if result["intent"] in {"compare_current", "current_detail"} and not has_current:
        result["intent"] = "clarify"

    category = changes.get("category")
    if isinstance(category, dict):
        if category.get("clear") is True:
            result["changes"]["category"] = {"clear": True}
        elif category.get("set") is not None:
            parsed = _entity(category.get("set"), text, "category")
            if parsed and not any(word in parsed["canonical"] for word in _GENERIC_PRODUCTS):
                result["changes"]["category"] = {"set": parsed}
            else:
                result["parseWarnings"].append("category_failed_evidence_gate")
    for key, entity_type in (("brands", "brand"), ("colors", "color"), ("materials", "material")):
        parsed = _entity_changes(changes.get(key), text, entity_type)
        if parsed:
            result["changes"][key] = parsed
    sizes = changes.get("sizes")
    if isinstance(sizes, dict):
        parsed = _entity_changes(sizes, text, "size")
        if parsed:
            result["changes"]["sizes"] = parsed
    price = changes.get("price")
    if isinstance(price, dict):
        if price.get("clear") is True:
            result["changes"]["price"] = {"clear": True}
        elif price.get("set") is not None:
            parsed = _price(price["set"], text)
            if parsed:
                result["changes"]["price"] = {"set": parsed}
            else:
                result["parseWarnings"].append("price_failed_evidence_gate")
    other = changes.get("otherAttributes")
    if isinstance(other, dict):
        safe_set = {}
        for key, value in (other.get("set") or {}).items():
            if not isinstance(value, dict):
                continue
            source = str(value.get("source") or "explicit")
            evidence = str(value.get("evidence") or "").strip()
            if source == "explicit" and (not evidence or evidence not in text):
                result["parseWarnings"].append(f"other_attribute_failed_evidence_gate:{str(key)[:30]}")
                continue
            safe_set[str(key)[:50]] = {**copy.deepcopy(value), "source": source,
                                      "evidence": evidence or None,
                                      "hard": bool(value.get("hard", False)) if source == "explicit" else False}
        safe_clear = [str(key)[:50] for key in other.get("clear", []) if isinstance(key, str)]
        if safe_set or safe_clear:
            result["changes"]["otherAttributes"] = {"set": safe_set, "clear": safe_clear}
    return result


def _arabic_number(text: str) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def extract_high_confidence_fallbacks(text: str) -> dict:
    """Small deterministic parser used only when it can cite exact evidence."""
    changes = {}
    current_reference = bool(re.search(
        r"第一款|第二款|第三款|上一轮|刚才那|这几款|那几款|这款|那款|这个商品|这盏|那盏|这个|那个|它(?:的|是|有|呢)",
        text,
    )) and not bool(re.search(r"想买|我要买|换成|改成|重新找", text))
    if current_reference:
        return {"intent": "current_detail", "changes": {}, "parseWarnings": []}
    price_range = re.search(r"(\d+(?:\.\d+)?)\s*(?:元)?\s*(?:到|至|[-~—])\s*(\d+(?:\.\d+)?)\s*元?", text)
    price_max = re.search(r"(?:预算|不超过|低于|少于|最多|控制在)?\s*(\d+(?:\.\d+)?)\s*元?\s*(?:以内|以下)", text)
    if price_range:
        changes["price"] = {"set": {"min": float(price_range[1]), "max": float(price_range[2]), "evidence": price_range.group(0), "source": "explicit", "hard": True}}
    elif price_max:
        changes["price"] = {"set": {"max": float(price_max[1]), "evidence": price_max.group(0), "source": "explicit", "hard": True}}
    elif re.search(r"价格无所谓|不设预算|预算不限", text):
        changes["price"] = {"clear": True}

    negative = bool(re.search(r"不要|排除|不喜欢", text))
    for color in _COLORS:
        aliases = (color, color.removesuffix("色"))
        evidence = next((alias for alias in aliases if alias and alias in text), None)
        if evidence:
            bucket = "addExclude" if negative and re.search(rf"(?:不要|排除|不喜欢)[^，。]{{0,8}}{re.escape(evidence)}", text) else "addInclude"
            changes.setdefault("colors", {}).setdefault(bucket, []).append({"raw": color, "evidence": evidence, "source": "explicit", "hard": bucket == "addExclude"})
    for material in _MATERIALS:
        if material in text:
            bucket = "addExclude" if negative and re.search(rf"(?:不要|排除|不喜欢)[^，。]{{0,8}}{re.escape(material)}", text) else "addInclude"
            changes.setdefault("materials", {}).setdefault(bucket, []).append({"raw": material, "evidence": material, "source": "explicit", "hard": bucket == "addExclude"})

    mentioned_brands = [brand for brand in _KNOWN_BRANDS if brand in text]
    if mentioned_brands:
        include, exclude = [], []
        for brand in mentioned_brands:
            row = {"raw": brand, "evidence": brand, "source": "explicit", "hard": True}
            if re.search(rf"(?:不要|排除|不喜欢)[^，。]{{0,8}}{re.escape(brand)}", text):
                exclude.append(row)
            else:
                include.append(row)
        brand_changes = {}
        if include:
            brand_changes["replaceInclude" if re.search(r"换成|改成", text) else "addInclude"] = include
        if exclude:
            brand_changes["addExclude"] = exclude
        changes["brands"] = brand_changes

    # Prefer the final noun phrase, but strip known modifiers before accepting it.
    match = re.search(rf"(?:{_BUY_VERBS})\s*([^，。！？?]{{1,28}})", text)
    if match:
        phrase = match.group(1).strip()
        generic_phrase = any(word in phrase for word in _GENERIC_PRODUCTS)
        phrase = re.sub(rf"^(?:{_CLASSIFIERS})+", "", phrase)
        phrase = re.sub(r"\d+(?:\.\d+)?\s*元?\s*(?:以内|以下)?", "", phrase)
        phrase = re.sub(r"^(?:的)+|(?:的|商品|东西|有吗)$", "", phrase).strip()
        for token in [*_KNOWN_BRANDS, *_COLORS, *_MATERIALS, "日系", "韩系", "北欧", "法式", "奶油风", "工业风", "极简", "简约", "复古", "低饱和", "通勤"]:
            phrase = phrase.replace(token, "")
        phrase = re.sub(r"^(?:的)+|(?:的|吧|呢|呀|啊|可以吗)+$", "", phrase).strip()
        # Keep only the head product after possessive/attribute phrases.
        phrase = phrase.split("的")[-1].strip()
        if (phrase and phrase not in {"点", "一些", "一点"} and len(phrase) <= 12
                and not generic_phrase and not any(word in phrase for word in _GENERIC_PRODUCTS)):
            changes["category"] = {"set": {"raw": phrase, "evidence": phrase, "source": "explicit", "hard": True}}
    return {"intent": "refine_search" if re.search(r"换成|改成|还是", text) else "search_product", "changes": changes, "parseWarnings": []}


def merge_fallback_without_overwriting_valid_entities(delta: dict, fallback: dict) -> dict:
    result = copy.deepcopy(delta if isinstance(delta, dict) else {"intent": "search_product", "changes": {}})
    result.setdefault("changes", {})
    for key, value in (fallback.get("changes") or {}).items():
        if key not in result["changes"]:
            result["changes"][key] = copy.deepcopy(value)
    if not result.get("intent"):
        result["intent"] = fallback.get("intent") or "search_product"
    return result


def _merge_bucket(target: dict, change: dict) -> dict:
    current = {"include": list(target.get("include") or []), "exclude": list(target.get("exclude") or [])}
    if change.get("clear"):
        return {"include": [], "exclude": []}
    for operation, bucket in (("replaceInclude", "include"), ("replaceExclude", "exclude")):
        if operation in change:
            current[bucket] = copy.deepcopy(change[operation])
    for operation, bucket in (("addInclude", "include"), ("addExclude", "exclude")):
        for row in change.get(operation, []):
            canonical = row.get("canonical")
            current[bucket] = [old for old in current[bucket] if old.get("canonical") != canonical]
            current[bucket].append(copy.deepcopy(row))
    return current


def merge_requirement(current: dict | None, delta: dict, raw_text: str = "") -> dict:
    result = copy.deepcopy(current) if isinstance(current, dict) else empty_requirement(raw_text)
    template = empty_requirement(raw_text)
    result = {**template, **result}
    result["schemaVersion"] = SCHEMA_VERSION
    result["rawText"] = raw_text or result.get("rawText", "")
    result["intent"] = delta.get("intent") or result.get("intent") or "search_product"
    result["parseWarnings"] = list(dict.fromkeys([*(result.get("parseWarnings") or []), *(delta.get("parseWarnings") or [])]))[-20:]
    changes = delta.get("changes") if isinstance(delta.get("changes"), dict) else {}
    category_change = changes.get("category")
    if isinstance(category_change, dict):
        if category_change.get("clear"):
            result["category"] = None
        elif category_change.get("set"):
            previous = (result.get("category") or {}).get("canonical")
            incoming = category_change["set"].get("canonical")
            result["category"] = copy.deepcopy(category_change["set"])
            if previous and incoming and previous != incoming:
                for key in ("colors", "sizes", "materials", "otherAttributes", "scenes", "freeTextRequirements"):
                    result[key] = copy.deepcopy(template[key])
    for key in ("brands", "colors", "materials"):
        if isinstance(changes.get(key), dict):
            result[key] = _merge_bucket(result.get(key) or {}, changes[key])
    if isinstance(changes.get("sizes"), dict):
        bucket = _merge_bucket({"include": result.get("sizes") or [], "exclude": []}, changes["sizes"])
        result["sizes"] = bucket["include"]
    if isinstance(changes.get("price"), dict):
        result["price"] = None if changes["price"].get("clear") else copy.deepcopy(changes["price"].get("set") or result.get("price"))
    if isinstance(changes.get("otherAttributes"), dict):
        attrs = dict(result.get("otherAttributes") or {})
        for key, value in (changes["otherAttributes"].get("set") or {}).items():
            attrs[str(key)[:50]] = copy.deepcopy(value)
        for key in changes["otherAttributes"].get("clear", []):
            attrs.pop(str(key), None)
        result["otherAttributes"] = attrs
    _rebuild_constraints(result)
    return result


def _rebuild_constraints(requirement: dict) -> None:
    hard, soft = [], []
    category = requirement.get("category")
    if category:
        hard.append(f"category={category['canonical']}")
    for field, key in (("brands", "brand"), ("colors", "color"), ("materials", "material")):
        for row in requirement.get(field, {}).get("include", []):
            (hard if row.get("hard") else soft).append(f"{key}.include={row['canonical']}")
        for row in requirement.get(field, {}).get("exclude", []):
            hard.append(f"{key}.exclude={row['canonical']}")
    price = requirement.get("price")
    if price:
        if price.get("min") is not None:
            hard.append(f"price.min={price['min']:g}")
        if price.get("max") is not None:
            hard.append(f"price.max={price['max']:g}")
    requirement["hardConstraints"] = hard
    requirement["softPreferences"] = soft
    requirement["missingImportantFields"] = [] if category else ["category"]
    requirement["nextAction"] = "search" if category else "ask"


def derive_legacy_preferences(requirement: dict | None) -> dict:
    if not isinstance(requirement, dict):
        return {}
    preferences = {}
    category = requirement.get("category")
    if isinstance(category, dict) and category.get("canonical"):
        preferences["category"] = category["canonical"]
        preferences["categoryAliases"] = list(category.get("aliases") or [category["canonical"]])
    for field, legacy in (("brands", "brand"), ("colors", "color"), ("materials", "material")):
        values = [row.get("canonical") for row in requirement.get(field, {}).get("include", []) if row.get("canonical")]
        excludes = [row.get("canonical") for row in requirement.get(field, {}).get("exclude", []) if row.get("canonical")]
        if values:
            preferences[legacy] = values[0]
            preferences[f"{legacy}s"] = values
        if excludes:
            preferences[f"excluded{legacy.title()}s"] = excludes
    price = requirement.get("price")
    if isinstance(price, dict):
        if price.get("min") is not None:
            preferences["minPrice"] = price["min"]
        if price.get("max") is not None:
            preferences["maxPrice"] = price["max"]
    return preferences


def requirement_from_legacy(preferences: dict | None) -> dict:
    """One-way migration for sessions written before schema v1."""
    preferences = preferences if isinstance(preferences, dict) else {}
    requirement = empty_requirement()
    category = str(preferences.get("category") or "").strip()
    if category and not any(word in category for word in _GENERIC_PRODUCTS):
        canonical, aliases, relation = DEFAULT_ALIAS_RESOLVER.resolve("category", category)
        requirement["category"] = {"raw": category, "canonical": canonical,
                                   "aliases": aliases, "relation": relation,
                                   "confidence": 1.0, "source": "remembered",
                                   "evidence": None, "hard": True}
    for legacy, field, entity_type in (("brand", "brands", "brand"), ("color", "colors", "color"),
                                        ("material", "materials", "material")):
        value = str(preferences.get(legacy) or "").strip()
        if value:
            canonical, aliases, relation = DEFAULT_ALIAS_RESOLVER.resolve(entity_type, value)
            requirement[field]["include"] = [{"raw": value, "canonical": canonical,
                                                "aliases": aliases, "relation": relation,
                                                "confidence": 1.0, "source": "remembered",
                                                "evidence": None, "hard": True}]
    if isinstance(preferences.get("maxPrice"), (int, float)):
        requirement["price"] = {"min": None, "max": float(preferences["maxPrice"]),
                                "currency": "CNY", "hard": True, "confidence": 1.0,
                                "source": "remembered", "evidence": None}
    _rebuild_constraints(requirement)
    return requirement


def requirement_debug(requirement: dict | None) -> dict:
    requirement = requirement or {}
    return {
        "schemaVersion": requirement.get("schemaVersion", SCHEMA_VERSION),
        "category": (requirement.get("category") or {}).get("canonical"),
        "categoryAliases": list((requirement.get("category") or {}).get("aliases") or []),
        "brands": [row.get("canonical") for row in requirement.get("brands", {}).get("include", [])],
        "price": copy.deepcopy(requirement.get("price")),
        "nextAction": requirement.get("nextAction"),
        "warningCount": len(requirement.get("parseWarnings") or []),
    }


__all__ = [
    "AliasResolver", "DEFAULT_ALIAS_RESOLVER", "SCHEMA_VERSION", "SOURCE_CAPABILITIES",
    "derive_legacy_preferences", "empty_requirement", "extract_high_confidence_fallbacks",
    "merge_fallback_without_overwriting_valid_entities", "merge_requirement",
    "requirement_debug", "requirement_from_legacy", "validate_requirement_delta",
]

