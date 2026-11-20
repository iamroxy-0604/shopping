"""Model interpretation with evidence gates and constrained language planning."""

import asyncio
import json
import math
import re

from wit.messages import SystemMessage, UserMessage
from wit.models import ModelRequest

from .policy import MATERIALS, SCENES, STYLES
from .requirement import (SOURCE_CAPABILITIES, derive_legacy_preferences,
                          merge_fallback_without_overwriting_valid_entities,
                          validate_requirement_delta)

STYLE_ALIASES = {"日系": ("日系", "日式"), "韩系": ("韩系", "韩式"), "北欧": ("北欧", "北欧风")}
ALLOWED_INTENTS = {"search", "compare_current", "current_detail", "explore", "stop_selling", "recall", "clarify"}
ALLOWED_ANGLES = {"category", "style", "material", "price", "image"}
ALLOWED_LEADS = {"direct", "gentle", "budget", "acknowledge"}


class NarrativeGenerationError(Exception):
    """The model did not produce a complete, source-grounded shopping narrative."""


async def _ask_json(model, invocation, instruction: str, payload: dict, *, timeout: float = 32) -> dict:
    result = await asyncio.wait_for(
        model.complete(
            ModelRequest(messages=(
                SystemMessage(instruction + " 只输出一个 JSON 对象，不要 Markdown。"),
                UserMessage(json.dumps(payload, ensure_ascii=False)),
            )),
            invocation,
        ),
        timeout=timeout,
    )
    raw = result.final_text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        # Some gateways wrap an otherwise valid object in explanatory text.
        value = None
        decoder = json.JSONDecoder()
        for match in re.finditer(r"\{", raw):
            try:
                candidate, _ = decoder.raw_decode(raw[match.start():])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                value = candidate
                break
        if value is None:
            raise
    return value if isinstance(value, dict) else {}


def _explicit_value(field: str, value, text: str):
    if field == "maxPrice":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            return None
        if not re.search(r"预算|以内|以下|不超过|低于|少于|最多|控制在", text):
            return None
        return float(value) if re.search(rf"(?<!\d){re.escape(f'{value:g}')}(?!\d)", text) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 24:
        return None
    if field == "style":
        if value not in STYLES:
            return None
        return value if any(alias in text for alias in STYLE_ALIASES.get(value, (value,))) else None
    if field == "material":
        return value if value in MATERIALS and value in text else None
    if field == "scene":
        return value if value in SCENES and value in text else None
    if field == "category":
        if any(generic in value for generic in ("好物", "东西", "给我看看", "随便")) or value.rstrip("个的") in STYLES:
            return None
        aliases = {"腮红": ("腮红", "胭脂"), "台灯": ("台灯", "桌面灯"), "餐桌": ("餐桌", "饭桌")}
        return value if any(alias in text for alias in aliases.get(value, (value,))) else None
    return None


def validate_interpretation(raw: dict, text: str, has_current: bool) -> dict:
    query = raw.get("query") if isinstance(raw.get("query"), dict) else {}
    memory = raw.get("memory") if isinstance(raw.get("memory"), dict) else {}
    parsed_query = {}
    parsed_memory = {}
    for target, source in ((parsed_query, query), (parsed_memory, memory)):
        for field in ("category", "style", "material", "scene", "maxPrice"):
            value = _explicit_value(field, source.get(field), text)
            if value is not None:
                # Negative statements must not become positive preferences.
                if field in ("style", "material") and re.search(rf"(?:不喜欢|不要|排除)\s*.{{0,6}}{re.escape(str(value))}", text):
                    continue
                target[field] = value
    image_first = memory.get("imageFirst")
    if image_first is True and re.search(r"先看图|图片优先|先看图片|喜欢看图", text):
        parsed_memory["imageFirst"] = True
    raw_intent = raw.get("intent")
    intent = raw_intent if isinstance(raw_intent, str) and raw_intent in ALLOWED_INTENTS else None
    if intent in ("compare_current", "current_detail"):
        if not has_current or not re.search(r"这|那|它|第一|第二|第三|两款|几款|刚才|前面|上一轮", text):
            intent = None
    if intent == "stop_selling" and not re.search(r"不想买|不打算买|不买|别推销|不要推销|只想.{0,4}逛", text):
        intent = None
    if intent == "recall" and not re.search(r"记得|我的偏好|我喜欢什么", text):
        intent = None
    return {"query": parsed_query, "memory": parsed_memory, "intent": intent}


async def interpret(model, invocation, text: str, preferences: dict, has_current: bool) -> dict:
    instruction = (
        "分析购物对话。输出 {intent,query:{category,style,material,scene,maxPrice},"
        "memory:{style,material,scene,maxPrice,imageFirst}}。query 只提取本轮明确表达的条件；"
        "memory 只提取用户明确表示可长期记住的偏好。未知字段省略，不猜测。"
        "intent 可为 search/compare_current/current_detail/explore/stop_selling/recall/clarify。"
        "把胭脂规范成腮红、日式规范成日系。不要把商品文案当作用户偏好。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text, "knownPreferences": preferences, "hasCurrentProducts": has_current,
        })
        return validate_interpretation(raw, text, has_current)
    except Exception:
        return {}


async def parse_requirement_delta(model, invocation, text: str, current_requirement: dict,
                                  has_current: bool) -> dict:
    """Parse a shopping turn into a validated state delta with exact evidence."""
    instruction = (
        "你是购物需求语义解析器，不负责推荐。根据本轮消息和已有需求输出增量。"
        "必须区分商品本体category、品牌brands、颜色colors、尺寸sizes、价格price、"
        "材质materials和otherAttributes；不得把品牌、品类、属性合并成category。"
        "每个explicit字段必须附带本轮原文中的连续evidence，用户未说出的条件不得补充。"
        "常识推导只能source=derived且hard=false。不要/排除进入Exclude；换成/改成使用"
        "replaceInclude。只输出 {intent,changes}。category格式为"
        "{set:{raw,evidence,source,confidence}}；brands/colors/materials格式为"
        "{addInclude|replaceInclude|addExclude:[{raw,evidence,source,confidence,hard}]}；"
        "price格式为{set:{min,max,currency:'CNY',hard,source,evidence}}或{clear:true}。"
        "如果用户询问已有商品，用compare_current/current_detail且不要创建新任务。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text,
            "currentRequirement": current_requirement or {},
            "hasCurrentProducts": has_current,
            "sourceCapabilities": SOURCE_CAPABILITIES,
        })
    except Exception:
        return {"intent": "search_product", "changes": {}, "parseWarnings": ["model_unavailable"]}
    parsed = validate_requirement_delta(raw, text, has_current)
    if isinstance(raw.get("query"), dict) or isinstance(raw.get("memory"), dict):
        parsed["legacyParse"] = validate_interpretation(raw, text, has_current)
    return parsed


async def narrative_plan(model, invocation, text: str, emotion: dict, items: list) -> dict:
    instruction = (
        "你是温和、不催单的导购。只选择已有措辞方案，不写新的商品事实。"
        "输出 {lead:'direct|gentle|budget|acknowledge',"
        "reasons:[{id:'商品ID',angle:'category|style|material|price|image'}]}。"
        "每个商品只能选择一个有证据的角度；没有证据选 image。"
        "不要推断功效、肤色适配、库存、尺寸或质量。"
    )
    facts = [
        {"id": item["id"], "title": item["title"], "price": item.get("price"),
         "material": item.get("facts", {}).get("material"),
         "styleTags": item.get("semantic", {}).get("style_tags") or []}
        for item in items
    ]
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text, "emotion": emotion, "products": facts,
        })
    except Exception:
        return {}
    requested_lead = raw.get("lead")
    lead = requested_lead if isinstance(requested_lead, str) and requested_lead in ALLOWED_LEADS else None
    allowed_ids = {item["id"] for item in items}
    reasons = {}
    for row in raw.get("reasons", []) if isinstance(raw.get("reasons"), list) else []:
        if (isinstance(row, dict) and isinstance(row.get("id"), str)
                and isinstance(row.get("angle"), str)
                and row["id"] in allowed_ids and row["angle"] in ALLOWED_ANGLES):
            reasons[row["id"]] = row["angle"]
    return {"lead": lead, "reasons": reasons}


async def questionnaire_plan(model, invocation, text: str, category: str, known: dict,
                             requirement: dict | None = None,
                             asked_fields: list[str] | None = None) -> list[dict]:
    """Generate executable questions whose answers map to requirement fields."""
    instruction = (
        "你是购物导购。根据本轮目标和已有条件，为当前商品设计三道不同的简短追问，"
        "每题必须对应一个缺失字段，并且答案能改变query/filter/ranking至少一项。"
        "不要重复已知字段或askedFields，不要再次询问已知品类/预算，不问无法执行的闲聊问题。"
        "不要承诺功效。输出 {questions:[{id,field,title,options:[{label,value}],"
        "affects:['query|filter|ranking'],hard:false,reason,confidence}]}。最多三题，"
        "每题2到4个可区分选项。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text, "category": category, "knownConditions": known,
            "shoppingRequirement": requirement or {}, "askedFields": asked_fields or [],
            "sourceCapabilities": SOURCE_CAPABILITIES,
        })
    except Exception:
        return []
    rows = raw.get("questions")
    if not isinstance(rows, list):
        return []
    valid = []
    for row in rows[:3]:
        if not isinstance(row, dict):
            continue
        title, options = row.get("title"), row.get("options")
        legacy_fields = ("otherAttributes.useCase", "scenes", "otherAttributes.priority")
        field = str(row.get("field") or legacy_fields[len(valid)]).strip()
        affects = [value for value in row.get("affects", [])
                   if value in {"query", "filter", "ranking"}]
        if not affects and "field" not in row:
            affects = ["query", "ranking"]
        if (not isinstance(title, str) or not 5 <= len(title) <= 60
                or not isinstance(options, list) or not 2 <= len(options) <= 4
                or not field or field in (asked_fields or []) or not affects):
            continue
        if any(word in category for word in ("防晒", "护肤", "面霜")) and "材质" in title:
            continue
        labels, values = [], {}
        for option in options:
            if isinstance(option, str):
                label, value = option.strip(), option.strip()
            elif isinstance(option, dict):
                label, value = str(option.get("label") or "").strip(), option.get("value")
            else:
                continue
            if 1 <= len(label) <= 18:
                labels.append(label)
                values[label] = value
        if len(labels) < 2:
            continue
        legacy_ids = ("use", "scene", "priority")
        try:
            confidence = max(0.0, min(1.0, float(row.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5
        valid.append({"id": str(row.get("id") or legacy_ids[len(valid)])[:40],
                      "field": field[:80], "title": title.strip(), "options": labels,
                      "optionValues": values, "affects": list(dict.fromkeys(affects)),
                      "hard": bool(row.get("hard", False)),
                      "reason": str(row.get("reason") or "missing_high_value_field")[:120],
                      "confidence": confidence, "allowCustom": True})
    return valid if len({row["title"] for row in valid}) == len(valid) else []


async def category_question_plan(model, invocation, text: str, known: dict) -> dict | None:
    """Ask a context-aware first question when the user has not named a product."""
    instruction = (
        "你是购物导购。用户想逛或描述了场景，但尚未说清想看哪种商品。"
        "请用一题轻松追问具体品类，给出2到4个和场景有关、确实能购买的商品类别选项。"
        "选项必须是商品名词，例如台灯、收纳盒，不要抽象的风格、用途或品牌。"
        "输出 {title:'...',options:['...','...']}。不要猜用户已经决定购买。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction,
                              {"message": text, "knownPreferences": known})
    except Exception:
        return None
    title, options = raw.get("title"), raw.get("options")
    if (not isinstance(title, str) or not 5 <= len(title) <= 60
            or not isinstance(options, list) or not 2 <= len(options) <= 4
            or not all(isinstance(value, str) and 1 <= len(value.strip()) <= 12
                       and not any(word in value for word in ("好物", "东西", "随便", "风格"))
                       for value in options)):
        return None
    return {"id": "category", "title": title.strip(),
            "options": [value.strip() for value in options], "allowCustom": True}


async def search_plan(model, invocation, text: str, preferences: dict, answers: list[dict],
                      requirement: dict | None = None) -> list[str]:
    """Let the model plan retrieval terms while keeping the requested product type anchored."""
    category = str(preferences.get("category") or "").strip()
    if not category:
        return []
    instruction = (
        "你是电商检索助手。根据当前购物目标、已记住的条件和问卷回答，输出2到4个不同的商品搜索词。"
        "每个词都必须指向用户要买的商品本身，保留核心品类；可以使用常见同义词与风格词。"
        "不要把餐桌改成桌布、椅子；不要把台灯改成灯罩。不要添加用户未说的品牌、功效或硬性预算。"
        "先具体后宽泛。只输出 {queries:['搜索词1','搜索词2']}。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text, "category": category, "preferences": preferences,
            "questionnaireAnswers": answers, "shoppingRequirement": requirement or {},
        })
    except Exception:
        return []
    aliases = {"餐桌": ("餐桌", "饭桌", "餐台"), "台灯": ("台灯", "桌面灯"),
               "桌面灯": ("桌面灯", "台灯"), "腮红": ("腮红", "胭脂"),
               "耳机": ("耳机", "耳麦")}.get(category, (category,))
    queries = raw.get("queries")
    if not isinstance(queries, list):
        return []
    accepted = []
    for value in queries[:4]:
        if not isinstance(value, str):
            continue
        value = " ".join(value.split())
        if 2 <= len(value) <= 40 and any(alias in value for alias in aliases) and value not in accepted:
            accepted.append(value)
    return accepted


AUDIT_CATEGORY_ALIASES = {
    "电饭锅": ("电饭锅", "电饭煲", "饭煲"),
    "充电宝": ("充电宝", "移动电源"),
    "裙子": ("裙子", "连衣裙", "长裙", "短裙", "半身裙"),
    "餐桌": ("餐桌", "饭桌", "餐台"),
    "台灯": ("台灯", "桌面灯"),
    "腮红": ("腮红", "胭脂"),
    "耳机": ("耳机", "耳麦"),
}


def validate_exclude_terms(value, target_category: str = "") -> list[str]:
    """Validate shared rules aggressively because they affect every shopper."""
    if not isinstance(value, list):
        return []
    blocked = ("http://", "https://", "<script", "javascript:", "预算", "价格", "元以内",
               "通勤", "日常", "户外", "风格", "材质", "用户", "电话", "邮箱")
    category_aliases = tuple(
        alias for alias in AUDIT_CATEGORY_ALIASES.get(target_category, (target_category,))
        if isinstance(alias, str) and alias.strip()
    )
    valid = []
    for term in value[:20]:
        if not isinstance(term, str):
            continue
        term = " ".join(term.split()).strip(" ,，。；;")
        if (not 2 <= len(term) <= 20 or any(token in term.lower() for token in blocked)
                or re.search(r"[@{}<>]|\d{5,}", term) or term in valid
                # Shared exclusions must name an independent, non-target item.
                # Phrases containing the target category are commonly legitimate
                # subcategories (for example a flavour, form or product type).
                # Useful accessory rules should be expressed as the accessory
                # itself ("保护套"), not "<目标品类>保护套".
                or any(alias in term for alias in category_aliases)):
            continue
        valid.append(term)
    return valid[:12] if len(valid) >= 3 else []


async def generate_exclude_terms(model, invocation, target_category: str) -> list[str]:
    """Generate category-level exclusions without any shopper preferences."""
    instruction = (
        "你是商品品类边界规则专家。仅生成3到12个明确不属于目标商品本体、但容易混入"
        "搜索结果的独立商品名，例如配件、替换件、耗材、制作原料或搭配物。每个词都必须"
        "表示另一种主要售卖对象，而不是目标商品的正常子类。严禁输出目标品类名称或其"
        "同义词，也严禁输出包含目标品类名称/同义词的组合词。不要把目标商品的类型、口味、"
        "款式、形态、包装、规格、容量、适用人群或用途当作排除项。若某配件通常写成"
        "“目标品类+配件”，只输出可独立识别的配件名。不要生成搜索词，不要使用用户偏好，"
        "不要输出品牌、预算、场景、风格或材质。短语应为2到20个字；不确定时宁可少输出。"
        "输出 {excludeTerms:['短语']}。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction,
                              {"targetCategory": str(target_category).strip()})
    except Exception:
        return []
    return validate_exclude_terms(raw.get("excludeTerms"), target_category)


def _audit_rows(raw: dict) -> list[dict]:
    rows = raw.get("decisions")
    if isinstance(rows, list):
        return rows
    flattened = []
    for decision in ("accepted", "rejected", "uncertain"):
        values = raw.get(decision)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    flattened.append({**value, "decision": decision[:-2] if decision.endswith("ed") else decision})
    return flattened


async def audit_product_categories(model, invocation, target_category: str,
                                   exclude_terms: list[str], products: list[dict]) -> dict:
    """Ask the model for a closed-world, fail-closed product-body decision."""
    if not products:
        return {"accepted": [], "rejected": [], "uncertain": []}
    instruction = (
        "你是严格的商品本体审核员。判断每件商品主要售卖的对象是否属于 targetCategory。"
        "不能仅因标题出现目标品类词就通过；配件、保护套、搭配商品和关联用品通常拒绝；"
        "excludeTerms 只是提示可能混入了其他主商品，不是违禁词，也不能单独作为拒绝依据。"
        "目标品类的正常子类、口味、款式、形态、包装、规格和用途仍属于目标商品，应通过；"
        "若目标商品本体正确而只是赠送配件，仍按本体判断。证据不足必须 uncertain。"
        "只能返回输入商品ID，不得虚构事实。为每件商品输出一次，格式为 "
        "{decisions:[{id:'...',decision:'accept|reject|uncertain',primaryCategory:'...',"
        "reason:'...',confidence:0.0}]}。"
    )
    compact = []
    for product in products[:20]:
        row = {key: product.get(key) for key in ("id", "title", "source", "price")}
        if product.get("category"):
            row["category"] = product["category"]
        if product.get("description"):
            row["description"] = str(product["description"])[:240]
        row["exclusionMatched"] = bool(product.get("exclusionMatched"))
        row["matchedTerms"] = list(product.get("matchedTerms") or [])[:12]
        compact.append(row)
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "targetCategory": target_category,
            "excludeTerms": exclude_terms,
            "products": compact,
        })
    except Exception:
        return {"accepted": [], "rejected": [], "uncertain": [
            {"id": str(product.get("id")), "reason": "审核服务不可用"}
            for product in products[:20] if product.get("id") is not None
        ]}

    allowed = {str(product.get("id")) for product in products[:20] if product.get("id") is not None}
    seen = set()
    result = {"accepted": [], "rejected": [], "uncertain": []}
    for row in _audit_rows(raw):
        if not isinstance(row, dict):
            continue
        item_id = row.get("id")
        decision = row.get("decision")
        if isinstance(decision, str):
            decision = {
                "accepted": "accept", "pass": "accept", "passed": "accept", "通过": "accept",
                "rejected": "reject", "fail": "reject", "failed": "reject", "拒绝": "reject",
                "unknown": "uncertain", "待定": "uncertain", "存疑": "uncertain",
            }.get(decision.strip().lower(), decision.strip().lower())
        if not isinstance(item_id, str) or item_id not in allowed or item_id in seen:
            continue
        seen.add(item_id)
        confidence = row.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence):
            confidence = 0.0
        confidence = max(0.0, min(1.0, float(confidence)))
        primary = row.get("primaryCategory")
        reason = row.get("reason") if isinstance(row.get("reason"), str) else ""
        output = {"id": item_id, "primaryCategory": primary.strip() if isinstance(primary, str) else "",
                  "reason": reason[:200], "confidence": confidence}
        target_aliases = AUDIT_CATEGORY_ALIASES.get(target_category, (target_category,))
        primary_matches = any(alias and (alias in output["primaryCategory"]
                                         or output["primaryCategory"] in alias)
                              for alias in target_aliases)
        if decision == "accept" and output["primaryCategory"] and primary_matches:
            result["accepted"].append(output)
        elif decision == "reject":
            result["rejected"].append(output)
        else:
            result["uncertain"].append(output)
    for item_id in allowed - seen:
        result["uncertain"].append({"id": item_id, "primaryCategory": "",
                                    "reason": "模型未返回审核结果", "confidence": 0.0})
    return result


async def product_plan(model, invocation, preferences: dict, items: list[dict]) -> dict:
    """Choose existing candidate IDs and a response tone in one model call."""
    if not items:
        return {"ids": [], "lead": None}
    instruction = (
        "你是购物导购。只从候选商品中选择最符合用户要求的最多三款，"
        "输出 {ids:['商品ID'],lead:'direct|gentle|budget|acknowledge'}。"
        "优先商品本体、明确符合风格和问卷需求的款式；避免配件、重复款和风格明显冲突的款式。"
        "lead 选择最贴合用户情绪的一种导购语气。"
        "不要猜测图片、材质、功效或未给出的商品事实。若证据不足，可少选。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "preferences": preferences,
            "candidates": [{"id": item["id"], "title": item["title"],
                            "price": item.get("price"),
                            "styleTags": (item.get("semantic") or {}).get("style_tags") or []}
                           for item in items[:12]],
        })
    except Exception:
        return {"ids": [], "lead": None}
    allowed = {item["id"] for item in items[:12]}
    ids = raw.get("ids")
    if not isinstance(ids, list):
        ids = []
    lead = raw.get("lead")
    return {"ids": list(dict.fromkeys(value for value in ids
                                     if isinstance(value, str) and value in allowed))[:3],
            "lead": lead if isinstance(lead, str) and lead in ALLOWED_LEADS else None}


def _safe_copy(value, evidence: str, *, minimum: int = 12, maximum: int = 220,
               item_count: int = 0) -> str:
    """Reject unsupported numeric specifications and unverifiable sales/efficacy claims."""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not minimum <= len(value) <= maximum or any(mark in value for mark in ("```", "<script", "| ---")):
        return ""
    allowed_numbers = set(re.findall(r"\d+(?:\.\d+)?", evidence))
    allowed_numbers.update(number[:-2] for number in tuple(allowed_numbers) if number.endswith(".0"))
    allowed_numbers.update(str(i) for i in range(1, item_count + 1))
    for number in re.findall(r"\d+(?:\.\d+)?", value):
        if number not in allowed_numbers:
            return ""
    if re.search(r"保证|一定适合|绝对|全网最低|销量第一|零风险", value):
        return ""
    for seller_claim in ("实测", "亲测", "认证", "已经验证"):
        if seller_claim in value and not (
            seller_claim in evidence and re.search(r"标题|标注|卖家|商品页|页面", value)
        ):
            return ""
    if re.search(r"(?:适合|适用于|专为).{0,8}(?:油皮|干皮|敏感肌|黄皮|肤质)|"
                 r"(?:美白|淡斑|抗皱|护眼|防晒|防水|耐汗).{0,6}(?:见效|保证|显著|有效)", value):
        return ""
    for property_name in ("黄金", "纯棉", "实木", "玻璃", "防水", "耐汗", "SPF", "PA+++",
                          "敏感肌", "油皮", "干皮", "黄皮", "美白", "显白", "抗皱", "无毒"):
        if property_name in value and property_name not in evidence:
            return ""
    return value


async def recommendation_plan(model, invocation, goal: str, preferences: dict,
                              answers: list[dict], items: list[dict]) -> dict:
    """Require a complete model-written result for the selected source products."""
    if not items:
        raise NarrativeGenerationError("no_products")
    if model is None:
        raise NarrativeGenerationError("model_unavailable")
    instruction = (
        "你是有温度、自然简洁的购物导购。只根据用户的本轮目标、问卷回答和商品资料写推荐，"
        "不要套用'第N款符合品类/在预算内'的机械句式。先用1-2句自然回应需求；"
        "再用2-3句比较这些商品已知的差异；为每个商品分别写1-2句独特的介绍，"
        "说清它吸引人的点及用户需要核实的一点。最后问一个贴合本轮需求的追问。"
        "可以介绍品类选择思路，但不要把通用品类知识写成某款商品已验证的功效。"
        "商品标题只是卖家描述，不是独立验证；未提供的规格、成分、肤质适配、材质、"
        "容量、防护效果、销量、评价、库存、折扣和实际到手价都不能猜。"
        "不要臆测图片内容。没有差异证据就坦率说尚无法比较，不要硬编。"
        "若商品的 selectionScope 是 initial_request，它是仅按首次需求保留的悦买商品；"
        "不要声称它符合后续问卷偏好，并应自然提醒用户该款只按首次品类匹配。"
        "引用认证、实测等卖家表述时，必须写成‘商品标题标注’或‘卖家标注’，不能当作已核验事实。"
        "作为导购专家，请从 summary 原文中挑选0-3个真正影响选择、值得视觉强调的短语，放入 emphasis 数组。"
        "短语必须逐字出现在 summary 中，每个2-16字；只强调结论、商品名或关键差异，不要选择完整句子，"
        "不要为了凑数而强调，整段都重要时也只选最关键的部分。"
        "控制篇幅：intro 40-100字，summary 60-160字，followUp 15-60字，"
        "每个商品的 reason 40-100字且只写一句。"
        "输出 JSON {intro:'',summary:'',emphasis:[''],followUp:'',items:[{id:'',reason:''}]}，"
        "items 必须逐一对应输入的商品 ID，不能新增商品。不要 Markdown。"
    )
    evidence = [{"id": item["id"], "title": item["title"], "price": item.get("price"),
                 "facts": item.get("facts") or {},
                  "selectionScope": item.get("selectionScope") or "refined_preferences",
                 "styleTags": (item.get("semantic") or {}).get("style_tags") or []}
                for item in items[:3]]
    payload = {"goal": goal, "preferences": preferences, "questionnaireAnswers": answers,
               "products": evidence}
    context = json.dumps({"goal": goal, "preferences": preferences,
                          "answers": answers, "products": evidence}, ensure_ascii=False)
    last_failure = "invalid_output"
    last_exception = None
    last_diagnostics = {}
    accepted = {"intro": "", "summary": "", "followUp": ""}
    per_item = {}
    expected = {item["id"] for item in items}
    for attempt in range(3):
        missing = [key for key, value in accepted.items() if not value]
        if len(per_item) != len(items):
            missing.append("items")
        try:
            raw = await _ask_json(model, invocation, instruction + (
                f" 上一次输出未通过校验；请特别修正 {', '.join(missing)}，仍输出完整 JSON。"
                if attempt else ""
            ), payload, timeout=95)
        except json.JSONDecodeError:
            if not any(accepted.values()) and not per_item:
                last_failure = "invalid_output"
            continue
        except Exception as exc:
            last_failure = "model_timeout" if isinstance(exc, asyncio.TimeoutError) else "model_request_failed"
            last_exception = exc
            break
        intro = _safe_copy(raw.get("intro"), context, maximum=180, item_count=len(items))
        summary = _safe_copy(raw.get("summary"), context, maximum=260, item_count=len(items))
        follow_up = _safe_copy(raw.get("followUp"), context, minimum=5, maximum=100,
                               item_count=len(items))
        if intro and not accepted["intro"]:
            accepted["intro"] = intro
        if summary and not accepted["summary"]:
            accepted["summary"] = summary
        if follow_up and not accepted["followUp"]:
            accepted["followUp"] = follow_up
        rows = raw.get("items")
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict) or row.get("id") not in expected or row["id"] in per_item:
                    continue
                reason = _safe_copy(row.get("reason"), context, maximum=260, item_count=len(items))
                if reason and reason not in per_item.values():
                    per_item[row["id"]] = reason
        if all(accepted.values()) and len(per_item) == len(items):
            emphasis = []
            rows_to_emphasize = raw.get("emphasis")
            if isinstance(rows_to_emphasize, list):
                for phrase in rows_to_emphasize:
                    if not isinstance(phrase, str):
                        continue
                    phrase = phrase.strip()
                    if (2 <= len(phrase) <= 16 and phrase in accepted["summary"]
                            and phrase not in emphasis):
                        emphasis.append(phrase)
                    if len(emphasis) == 3:
                        break
            return {**accepted, "emphasis": emphasis, "items": per_item}
        last_failure = "invalid_product_reasons" if all(accepted.values()) else "missing_narrative_fields"
        last_diagnostics = {
            "introValid": bool(accepted["intro"]), "summaryValid": bool(accepted["summary"]),
            "followUpValid": bool(accepted["followUp"]),
            "itemCount": len(per_item), "expectedItemCount": len(items),
            "introLength": len(raw.get("intro")) if isinstance(raw.get("intro"), str) else None,
            "summaryLength": len(raw.get("summary")) if isinstance(raw.get("summary"), str) else None,
            "followUpLength": len(raw.get("followUp")) if isinstance(raw.get("followUp"), str) else None,
        }
    if last_exception is not None:
        raise NarrativeGenerationError(last_failure) from last_exception
    error = NarrativeGenerationError(last_failure)
    error.diagnostics = last_diagnostics
    raise error
