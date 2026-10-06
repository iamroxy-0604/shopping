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
        timeout=7,
    )
    raw = result.final_text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
    value = json.loads(raw)
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
    """Generate useful category-specific clarification; reject malformed model output."""
    instruction = (
        "你是购物导购。用户刚提出新的购物目标。为该商品生成两道简短的中文追问，"
        "帮助区分真正影响购买的场景、规格或体验。不要重复用户已经说清的条件，"
        "不要询问肤质以外品类的肤质，也不要承诺商品功效。"
        "输出 {questions:[{id:'use',title:'...',options:['...','...','...']},"
        "{id:'priority',title:'...',options:['...','...','...']}]}。"
        "问题与选项都要贴合当前品类，每个选项不超过18字。"
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
    for index, row in enumerate(rows[:2]):
        if not isinstance(row, dict):
            continue
        title, options = row.get("title"), row.get("options")
        if (not isinstance(title, str) or not 5 <= len(title) <= 60
                or not isinstance(options, list) or not 2 <= len(options) <= 4
                or not all(isinstance(option, str) and 1 <= len(option) <= 18 for option in options)):
            continue
        valid.append({"id": ("use", "priority")[index], "title": title.strip(),
                      "options": [option.strip() for option in options], "allowCustom": True})
    return valid
