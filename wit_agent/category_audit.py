"""Category-safety agent used before retrieval and before product ranking."""

from __future__ import annotations

import re

from .llm import (audit_product_categories, generate_exclude_terms, search_plan,
                  validate_exclude_terms)
from .memory import MemoryManager
from .requirement import DEFAULT_ALIAS_RESOLVER, derive_legacy_preferences


CATEGORY_ALIASES = {
    "胭脂": "腮红",
    "桌面灯": "台灯",
    "饭桌": "餐桌",
}

SEARCH_ALIASES = {
    "充电宝": ("充电宝", "移动电源"),
    "腮红": ("腮红", "胭脂"),
    "台灯": ("台灯", "桌面灯"),
    "餐桌": ("餐桌", "饭桌", "餐台"),
    "耳机": ("耳机", "耳麦"),
    "裙子": ("裙子", "连衣裙", "长裙", "短裙", "半身裙"),
}

ACCESSORY_TERMS = (
    "保护套", "保护壳", "手机壳", "外壳", "收纳袋", "收纳包", "贴膜", "配件",
    "替换件", "支架", "挂绳", "灯罩", "灯泡", "桌布", "桌垫", "桌旗", "餐垫",
    "装饰画", "背景墙", "挂画", "摆件", "同款鞋", "小皮鞋", "餐椅", "椅子",
)
GIFT_MARKERS = ("赠", "送", "附送", "加赠", "含赠品")


def normalize_category_key(category: str) -> str:
    key = re.sub(r"\s+", "", str(category or "").strip()).lower()
    return CATEGORY_ALIASES.get(key, key)


def _category_contract(value) -> tuple[str, tuple[str, ...]]:
    if isinstance(value, dict):
        canonical = str(value.get("canonical") or value.get("raw") or "").strip()
        aliases = tuple(str(alias).strip() for alias in value.get("aliases", []) if str(alias).strip())
    else:
        canonical = str(value or "").strip()
        aliases = ()
    resolved, approved, _ = DEFAULT_ALIAS_RESOLVER.resolve("category", canonical)
    canonical = resolved or canonical
    aliases = tuple(dict.fromkeys([*aliases, *approved, *SEARCH_ALIASES.get(canonical, (canonical,))]))
    return canonical, aliases or (canonical,)


def _fallback_queries(requirement: dict, category: str) -> list[str]:
    preferences = requirement.get("preferences") if isinstance(requirement.get("preferences"), dict) else {}
    answers = requirement.get("answers") if isinstance(requirement.get("answers"), list) else []
    values = []
    for key in ("style", "material", "scene", "length"):
        value = preferences.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    for row in answers:
        value = row.get("value") if isinstance(row, dict) else None
        if isinstance(value, str):
            values.extend(term for term in re.split(r"[、，, /]+", value.strip()) if 1 < len(term) <= 10)
    queries = []
    if values:
        queries.append(" ".join([*values[:2], category]))
        if preferences.get("style") == "日系":
            queries.append(f"日式{category}")
        else:
            queries.append(" ".join([values[0], category]))
    queries.extend((category, f"{category} 商品"))
    return list(dict.fromkeys(query for query in queries if query))[:4]


def _deterministic_audit(target_category: str, products: list[dict], aliases: tuple[str, ...] = ()) -> dict:
    """Resolve obvious product bodies locally and isolate only ambiguous rows."""
    aliases = aliases or SEARCH_ALIASES.get(target_category, (target_category,))
    result = {"accepted": [], "rejected": [], "uncertain": []}
    for product in products[:20]:
        item_id = str(product.get("id") or "")
        title = str(product.get("title") or "").strip()
        if not item_id or not title:
            continue
        has_target = any(alias and alias in title for alias in aliases)
        matched_accessories = [term for term in ACCESSORY_TERMS if term in title]
        exclusion_signals = [
            term for term in product.get("matchedTerms", [])
            if (isinstance(term, str) and term in title and term not in aliases
                and term not in matched_accessories)
        ]
        gift_only = any(marker in title for marker in GIFT_MARKERS)
        obvious_other = (
            target_category == "裙子" and any(term in title for term in ("鞋", "靴", "袜"))
        )
        if has_target and (obvious_other or matched_accessories):
            bucket = "uncertain" if gift_only else "rejected"
            result[bucket].append({
                "id": item_id,
                "primaryCategory": "" if gift_only else "关联商品",
                "confidence": 0.0 if gift_only else 0.96,
                "reason": ("目标商品与赠品同时出现，需要判断主要售卖对象" if gift_only
                           else "标题显示主要售卖对象是配件、搭配物或关联商品"),
                "auditMethod": "local",
            })
        elif has_target and exclusion_signals:
            result["uncertain"].append({
                "id": item_id, "primaryCategory": "", "confidence": 0.0,
                "reason": "标题同时包含目标品类与关联商品信号，需要判断主要售卖对象",
                "auditMethod": "local",
            })
        elif has_target:
            result["accepted"].append({
                "id": item_id, "primaryCategory": target_category, "confidence": 0.9,
                "reason": "标题明确指向目标商品本体",
                "auditMethod": "local",
            })
        else:
            result["uncertain"].append({
                "id": item_id, "primaryCategory": "", "confidence": 0.0,
                "reason": "现有商品资料不足以确认本体品类",
                "auditMethod": "local",
            })
    return result


class CategoryAuditAgent:
    """Owns shared category exclusions and the fail-closed product admission gate."""

    def __init__(self, memory: MemoryManager, model=None, *, category_model_enabled: bool = True):
        self.memory = memory
        self.model = model
        self.category_model_enabled = category_model_enabled

    async def plan_search(self, invocation, requirement: dict) -> dict:
        category, aliases = _category_contract(requirement.get("targetCategory"))
        category_key = normalize_category_key(category)
        if not category_key:
            return {"targetCategory": "", "targetCategoryContract": None,
                    "queries": [], "fallbackQueries": [], "excludeTerms": [],
                    "excludeTermsSource": "generated"}
        shopping_requirement = requirement.get("shoppingRequirement") if isinstance(requirement.get("shoppingRequirement"), dict) else {}
        preferences = requirement.get("preferences") if isinstance(requirement.get("preferences"), dict) else {}
        preferences = {**derive_legacy_preferences(shopping_requirement), **preferences,
                       "category": category, "categoryAliases": list(aliases)}
        answers = requirement.get("answers") if isinstance(requirement.get("answers"), list) else []
        queries = []
        if self.model is not None:
            queries = await search_plan(
                self.model, invocation, str(requirement.get("goal") or category),
                preferences, answers, shopping_requirement,
            )
        if len(queries) < 2:
            queries = list(dict.fromkeys([*queries, *_fallback_queries(requirement, category)]))[:4]
        brand = preferences.get("brand")
        fallback_queries = list(dict.fromkeys([
            *([f"{brand} {alias}" for alias in aliases[:2]] if brand else []),
            *aliases,
        ]))[:4]
        queries = list(dict.fromkeys([*queries, *fallback_queries]))[:4]

        stored_exclusions = self.memory.get_category_exclusions(category_key)
        exclusions = (validate_exclude_terms(stored_exclusions, category_key)
                      if stored_exclusions is not None else None)
        source = "memory" if stored_exclusions is not None else "generated"
        if stored_exclusions is not None and exclusions != stored_exclusions:
            # Revalidate rules created by older prompts before they affect a new
            # shopper. Valid survivors are rewritten; fully contaminated sets
            # are regenerated below using the current prompt.
            source = "memory_revalidated"
            if exclusions:
                self.memory.save_category_exclusions(category_key, exclusions)
        if exclusions is None or not exclusions:
            exclusions = (await generate_exclude_terms(self.model, invocation, category)
                          if self.model is not None and self.category_model_enabled else [])
            if exclusions:
                self.memory.save_category_exclusions(category_key, exclusions)
                source = "regenerated" if stored_exclusions is not None else "generated"
        return {
            "targetCategory": category,
            "targetCategoryContract": {"canonical": category, "aliases": list(aliases)},
            "queries": queries[:4],
            "fallbackQueries": fallback_queries,
            "sourceFilters": {"end_price": preferences.get("maxPrice")},
            "requiredEvidence": {"categoryAny": list(aliases),
                                 "brandAny": [brand] if brand else []},
            "softRanking": [],
            "excludeTerms": exclusions,
            "excludeTermsSource": source,
        }

    async def audit_products(self, invocation, target_category,
                             exclude_terms: list[str], products: list[dict]) -> dict:
        target_category, upstream_aliases = _category_contract(target_category)
        marked = []
        target_aliases = upstream_aliases
        for product in products[:20]:
            if not isinstance(product, dict):
                continue
            title = str(product.get("title") or "")
            matched = [term for term in exclude_terms
                       if isinstance(term, str) and term in title and term not in target_aliases]
            facts = product.get("facts") if isinstance(product.get("facts"), dict) else {}
            marked.append({
                **product,
                "category": facts.get("category") or product.get("category"),
                "exclusionMatched": bool(matched),
                "matchedTerms": matched,
            })
        local = _deterministic_audit(target_category, marked, upstream_aliases)
        if self.model is None or not self.category_model_enabled or not local["uncertain"]:
            return local

        by_id = {product["id"]: product for product in marked}
        ambiguous = [by_id[row["id"]] for row in local["uncertain"] if row["id"] in by_id]
        result = {"accepted": list(local["accepted"]),
                  "rejected": list(local["rejected"]), "uncertain": []}
        for start in range(0, len(ambiguous), 5):
            model_result = await audit_product_categories(
                self.model, invocation, target_category, exclude_terms,
                ambiguous[start:start + 5],
            )
            for bucket in ("accepted", "rejected", "uncertain"):
                for row in model_result[bucket]:
                    result[bucket].append({**row, "auditMethod": "model"})
        return result
