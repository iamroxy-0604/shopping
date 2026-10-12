"""Model interpretation with evidence gates and constrained language planning."""

import asyncio
import json
import math
import re

from wit.messages import SystemMessage, UserMessage
from wit.models import ModelRequest

from .policy import MATERIALS, SCENES, STYLES

STYLE_ALIASES = {"日系": ("日系", "日式"), "韩系": ("韩系", "韩式"), "北欧": ("北欧", "北欧风")}
ALLOWED_INTENTS = {"search", "compare_current", "current_detail", "explore", "stop_selling", "recall", "clarify"}
ALLOWED_ANGLES = {"category", "style", "material", "price", "image"}
ALLOWED_LEADS = {"direct", "gentle", "budget", "acknowledge"}


async def _ask_json(model, invocation, instruction: str, payload: dict) -> dict:
    result = await asyncio.wait_for(
        model.complete(
            ModelRequest(messages=(
                SystemMessage(instruction + " 只输出一个 JSON 对象，不要 Markdown。"),
                UserMessage(json.dumps(payload, ensure_ascii=False)),
            )),
            invocation,
        ),
        timeout=18,
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
    intent = raw.get("intent") if raw.get("intent") in ALLOWED_INTENTS else None
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


async def questionnaire_plan(model, invocation, text: str, category: str, known: dict) -> list[dict]:
    """Generate three category-specific questions; reject incomplete model output."""
    instruction = (
        "你是购物导购。根据本轮目标和已有条件，为当前商品设计三道不同的简短追问，"
        "分别帮助判断使用方式、实际场景和最在意的取舍；按商品品类调整问题，不套固定题干。"
        "不要重复用户已经说清的条件，不要问与品类无关的属性，例如防晒霜的材质。"
        "不要承诺功效。输出 {questions:[{title:'...',options:['...','...','...']},"
        "{title:'...',options:['...','...','...']},{title:'...',options:['...','...','...']}]}。"
        "每题给2到4个可区分的选项，选项不超过18字。"
    )
    try:
        raw = await _ask_json(model, invocation, instruction, {
            "message": text, "category": category, "knownConditions": known,
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
        if (not isinstance(title, str) or not 5 <= len(title) <= 60
                or not isinstance(options, list) or not 2 <= len(options) <= 4
                or not all(isinstance(option, str) and 1 <= len(option) <= 18 for option in options)):
            continue
        if any(word in category for word in ("防晒", "护肤", "面霜")) and "材质" in title:
            continue
        valid.append({"id": ("use", "scene", "priority")[len(valid)], "title": title.strip(),
                      "options": [option.strip() for option in options], "allowCustom": True})
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


async def search_plan(model, invocation, text: str, preferences: dict, answers: list[dict]) -> list[str]:
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
            "questionnaireAnswers": answers,
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
