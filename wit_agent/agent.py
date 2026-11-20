"""Shopping workflow hosted by the actual Wit 3.0 Agent Entry."""

import asyncio
import copy
import json
import os
import math
import re
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path
from typing import Awaitable, Callable

import httpx
from wit import WitAgent
from wit.loops.workflow import WorkflowGraph, WorkflowLoopComponent
from wit.models import MODEL
from wit.providers.openai import OpenAIModelComponent

from .category_audit import CategoryAuditAgent
from .llm import (NarrativeGenerationError, category_question_plan, parse_requirement_delta, product_plan,
                  questionnaire_plan, recommendation_plan)
from .memory import MemoryManager
from .policy import extract_updates, forget_field, temporary_budget, understand, usual_budget
from .requirement import (derive_legacy_preferences, empty_requirement,
                          extract_high_confidence_fallbacks, merge_fallback_without_overwriting_valid_entities,
                          merge_requirement, requirement_debug, requirement_from_legacy,
                          validate_requirement_delta)

Search = Callable[[str, dict], Awaitable[dict | list]]
CATEGORY_EQUIVALENTS = {"桌面灯": ("桌面灯", "台灯"), "台灯": ("台灯", "桌面灯"), "腮红": ("腮红", "胭脂"), "耳机": ("耳机", "耳麦"), "餐桌": ("餐桌", "饭桌", "餐台"), "裤子": ("裤子", "裤"), "裙子": ("裙子", "连衣裙", "长裙", "短裙", "半身裙"), "充电宝": ("充电宝", "移动电源"), "电饭锅": ("电饭锅", "电饭煲", "饭煲")}
STYLE_EQUIVALENTS = {"日系": ("日系", "日式"), "韩系": ("韩系", "韩式"), "北欧": ("北欧",), "法式": ("法式",)}
STYLE_CONFLICTS = ("日系", "日式", "韩系", "韩式", "北欧", "欧式", "美式", "法式")


async def product_api_search(query: str, filters: dict) -> dict:
    url = os.getenv("WIT_PRODUCT_URL", "http://127.0.0.1:3000/api/products/search")
    request_filters = dict(filters or {})
    source = request_filters.pop("_source", None)
    body = {"query": query, "filters": request_filters}
    if source:
        body["source"] = source
    # The product service is a local sidecar and must never be routed through
    # HTTP(S)/SOCKS proxy variables inherited from the desktop environment.
    async with httpx.AsyncClient(timeout=9.0, trust_env=False) as client:
        response = await client.post(url, json=body)
        response.raise_for_status()
        return response.json()


def normalize_product(raw: dict) -> dict | None:
    """Retain source facts while providing the flat fields expected by the UI."""
    if not isinstance(raw, dict):
        return None
    facts = raw.get("facts") if isinstance(raw.get("facts"), dict) else raw
    title = str(facts.get("title") or "").strip()
    if not title:
        return None
    price = facts.get("price")
    try:
        price = float(price) if price is not None and price != "" else None
        if price is not None and (not math.isfinite(price) or price < 0):
            price = None
    except (TypeError, ValueError):
        price = None
    source = raw.get("source", "")
    media = raw.get("media") or {}
    images = (media.get("images") or []) if isinstance(media, dict) else []
    image_url = raw.get("imageUrl") or (images[0].get("url") if images and isinstance(images[0], dict) else "")
    normalized_facts = {
        "title": title,
        "price": price,
        "material": copy.deepcopy(facts.get("material")),
        "color": copy.deepcopy(facts.get("color")),
        "dimensions": copy.deepcopy(facts.get("dimensions")),
        "brand": copy.deepcopy(facts.get("brand")),
    }
    for key in ("goodsId", "skuCount", "representativeSkuId", "sellingPoint", "description",
                "category", "deliverTime", "servicePromise", "afterSaleRule"):
        if facts.get(key) is not None:
            normalized_facts[key] = copy.deepcopy(facts.get(key))
    return {
        "id": str(raw.get("id") or raw.get("product_id") or title),
        "title": title,
        "price": price,
        "imageUrl": str(image_url or ""),
        "promotionUrl": str(raw.get("promotionUrl") or ""),
        "source": copy.deepcopy(source) if isinstance(source, dict) else str(source or ""),
        "shopName": str(raw.get("shopName") or ""),
        "description": str(raw.get("description") or facts.get("sellingPoint") or facts.get("description") or ""),
        "media": copy.deepcopy(media) if isinstance(media, dict) else {},
        "facts": normalized_facts,
        "providerData": copy.deepcopy(raw.get("providerData")) if isinstance(raw.get("providerData"), dict) else {},
        "semantic": copy.deepcopy(raw.get("semantic")) if isinstance(raw.get("semantic"), dict) else {},
        "selectionScope": str(raw.get("selectionScope") or ""),
        "matchPolicy": str(raw.get("matchPolicy") or ""),
    }


def product_source_name(raw: dict) -> str:
    if not isinstance(raw, dict):
        return ""
    source = raw.get("source")
    if isinstance(source, str):
        name = source
    elif isinstance(source, dict):
        name = source.get("id") or source.get("name") or source.get("provider") or source.get("source") or ""
    else:
        name = ""
    name = str(name).strip().lower()
    if name == "syh":
        return "yuemai"
    if name:
        return name
    item_id = str(raw.get("id") or raw.get("product_id") or "").lower()
    return item_id.split(":", 1)[0] if ":" in item_id else ""


def payload_has_source_metadata(payload, raw_items: list) -> bool:
    supported = {"taobao", "yuemai"}
    if isinstance(payload, dict):
        if str(payload.get("source") or "").lower() in supported:
            return True
        sources = payload.get("sources")
        if isinstance(sources, list) and any(
            isinstance(entry, dict) and str(entry.get("source") or "").lower() in supported
            for entry in sources
        ):
            return True
    return any(product_source_name(item) in supported
               for item in raw_items if isinstance(item, dict))


def select_products(raw_items: list, preferences: dict, limit: int = 3,
                    allow_style_unknown: bool = False,
                    diagnostics: dict | None = None) -> list:
    budget = preferences.get("maxPrice")
    category = preferences.get("category", "")
    style = preferences.get("style", "")
    material = preferences.get("material", "")
    category_aliases = tuple(dict.fromkeys([
        *(preferences.get("categoryAliases") or []),
        *CATEGORY_EQUIVALENTS.get(category, (category,)),
    ]))
    required_brand = preferences.get("brand", "")
    excluded_brands = preferences.get("excludedBrands") or []
    excluded_colors = preferences.get("excludedColors") or []
    dislikes = preferences.get("dislikes") or []
    answer_terms = preferences.get("answer_terms") or []
    seen = set()
    ranked = []

    if diagnostics is not None:
        diagnostics.clear()
        diagnostics.update({"normalizedCount": 0, "qualifiedCount": 0,
                            "rejectionReasons": {}, "rejectedSample": []})

    def reject(reason: str, raw=None, item=None, **details) -> None:
        if diagnostics is None:
            return
        reasons = diagnostics["rejectionReasons"]
        reasons[reason] = reasons.get(reason, 0) + 1
        if len(diagnostics["rejectedSample"]) >= 5:
            return
        source = item if isinstance(item, dict) else raw if isinstance(raw, dict) else {}
        facts = source.get("facts") if isinstance(source.get("facts"), dict) else source
        sample = {
            "id": str(source.get("id") or source.get("product_id") or "")[:160],
            "title": str(source.get("title") or facts.get("title") or "")[:120],
            "reason": reason,
        }
        sample.update(details)
        diagnostics["rejectedSample"].append(sample)

    for raw in raw_items:
        item = normalize_product(raw)
        if not item:
            reject("invalid_product", raw=raw)
            continue
        if diagnostics is not None:
            diagnostics["normalizedCount"] += 1
        if item["id"] in seen:
            reject("duplicate_id", item=item)
            continue
        title = item["title"]
        item_brand = str(item.get("facts", {}).get("brand") or "")
        if any(value and (value in title or value in item_brand) for value in excluded_brands):
            reject("excluded_brand", item=item)
            continue
        if any(value and value in title for value in excluded_colors):
            reject("excluded_color", item=item)
            continue
        if required_brand and required_brand not in title and required_brand not in item_brand:
            reject("brand_mismatch", item=item, expectedBrand=required_brand)
            continue
        if any(isinstance(dislike, str) and dislike.strip("感的 ") and dislike.strip("感的 ") in title for dislike in dislikes):
            reject("user_dislike", item=item)
            continue
        title_key = "".join(character for character in title.lower() if character.isalnum())[:32]
        if title_key in seen:
            reject("duplicate_title", item=item)
            continue
        if category == "餐桌":
            if any(word in title for word in ("桌布", "桌垫", "桌旗", "桌巾", "桌罩", "餐垫", "台布", "装饰画", "挂画", "壁画", "背景墙", "贴纸", "花瓶", "摆件", "餐椅", "靠背椅", "扶手椅", "椅子", "座椅", "桌椅")):
                reject("table_accessory", item=item)
                continue
        if budget is not None and (item["price"] is None or item["price"] > budget):
            reject("unknown_price_with_budget" if item["price"] is None else "over_budget",
                   item=item, price=item["price"], maxPrice=budget)
            continue
        category_match = bool(category and any(term in title for term in category_aliases))
        if category and not category_match:
            reject("category_mismatch", item=item,
                    expectedTerms=list(category_aliases))
            continue
        style_aliases = STYLE_EQUIVALENTS.get(style, (style,)) if style else ()
        if style in STYLE_EQUIVALENTS and any(term in title for term in STYLE_CONFLICTS if term not in style_aliases):
            reject("style_conflict", item=item, expectedStyle=style)
            continue
        style_tags = item["semantic"].get("style_tags") or []
        style_match = bool(style and (any(term in title for term in style_aliases) or style in style_tags))
        if category == "餐桌" and style == "日系" and not style_match and not allow_style_unknown:
            reject("style_evidence_missing", item=item, expectedStyle=style)
            continue
        seen.add(item["id"])
        seen.add(title_key)
        material_match = bool(material and (material in title or material in (item["facts"].get("material") or [])))
        score = (int(category_match) * 3 + int(style_match) * 3 + int(material_match) * 2
                 + int(item["price"] is not None) + sum(2 for term in answer_terms if term in title))
        reasons = []
        if category_match:
            reasons.append(f"商品标题写的是{category}")
        if style_match:
            reasons.append(f"标注了{style}风格")
        if material_match:
            reasons.append(f"商品信息提到{material}")
        if budget is not None and item["price"] is not None:
            reasons.append(f"标价 ¥{item['price']:g}，在你 ¥{budget:g} 的预算内")
        item["matchReasons"] = reasons
        ranked.append((score, item))
    if diagnostics is not None:
        diagnostics["qualifiedCount"] = len(ranked)
    ranked.sort(key=lambda pair: -pair[0])
    return [item for _, item in ranked[:limit]]


def compare_message(items: list, message: str) -> str:
    if not items:
        return "目前没有可比较的商品。你想先看哪一类？"
    if any(word in message for word in ("肤质", "黄皮", "显白", "美白", "护眼", "功效", "祛痘", "淡斑")):
        return "仅凭商品标题和当前资料，无法判断肤质适配或实际功效；需要核对商品方的成分与说明。"
    compare = bool(re.search(r"比较|对比|哪一?款|哪[个款].*(?:便宜|好)|这[两三几]款|怎么选|和.*怎么|两[个盏款]", message))
    indexed = list(enumerate(items, 1))
    if not compare:
        number = next((n for word, n in (("第一款", 1), ("第二款", 2), ("第三款", 3), ("左边", 1), ("右边", 2), ("前者", 1), ("后者", 2)) if word in message), None)
        if number is not None and number <= len(items):
            indexed = [indexed[number - 1]]
        elif "便宜的" in message:
            priced = [row for row in indexed if row[1].get("price") is not None]
            if priced:
                indexed = [min(priced, key=lambda row: row[1]["price"])]
        elif len(items) > 1:
            matched = [row for row in indexed if any(term in message and term in row[1]["title"] for term in ("米白", "黑色", "白色", "竹制", "不锈钢", "原木"))]
            indexed = matched[:1] or indexed[:1]
    def field(item, key):
        value = (item.get("facts") or {}).get(key)
        if isinstance(value, list):
            return "、".join(str(part) for part in value if part)
        return str(value).strip() if value is not None else ""
    if "原木感" in message and "依据" in message:
        item = indexed[0][1]
        material = field(item, "material")
        return f"商品材质字段是{material}；“原木感”只是观感描述，不等于原木材质。" if material else "目前没有材质依据；“原木感”只是观感描述，不能当作材质事实。"
    if "小户型" in message and not any(field(item, "dimensions") for _, item in indexed):
        return f"这{len(indexed)}款目前都缺少可核对的尺寸，不能只凭图片判断哪款更适合小户型。你方便说一下餐桌位置的长宽吗？"
    parts = []
    for i, item in indexed:
        attributes = []
        if "价格" in message or "标价" in message or "便宜" in message or compare or "夹具" in message:
            attributes.append(f"标价 ¥{item['price']:g}" if item.get("price") is not None else "价格未知")
        for key, label, keywords in (("material", "材质", ("材质", "什么做的")), ("color", "颜色", ("颜色", "色")), ("dimensions", "尺寸", ("尺寸", "多大"))):
            if any(word in message for word in keywords) or (compare and key in ("material", "color") and field(item, key)):
                value = field(item, key)
                attributes.append(f"{label} {value}" if value else f"{label}未知（当前商品信息未提供）")
        if "现货" in message or "库存" in message:
            attributes.append("库存/现货信息未知，当前商品资料没有实时库存")
        if "降价" in message or "促销" in message:
            attributes.append("后续是否降价/促销未知，无法预测")
        if "保温" in message:
            attributes.append("保温时长未知，当前资料未提供测试数据")
        if "链接" in message or "来源" in message:
            source = item.get("source")
            link = item.get("promotionUrl") or (source.get("url") if isinstance(source, dict) else "")
            attributes.append(f"商品链接：{link}" if link else "商品来源链接未知，当前资料未提供")
        if "适合" in message and "风" in message:
            material, color = field(item, "material"), field(item, "color")
            attributes.append("这只是风格判断，依据是" + "、".join(x for x in (f"标题“{item['title']}”", f"材质{material}" if material else "", f"颜色{color}" if color else "") if x))
        if not attributes:
            attributes.append("可核对标题和商品详情，其他属性尚未确认")
        parts.append(f"第{i}款“{item['title']}”：" + "，".join(attributes))
    if compare and "便宜" in message:
        priced = [(i, x["price"]) for i, x in indexed if x.get("price") is not None]
        if len(priced) >= 2:
            cheapest = min(priced, key=lambda row: row[1])
            parts.append(f"按当前标价，第{cheapest[0]}款更便宜；实际成交价以商品页为准")
    return "根据现有商品信息，" + "；".join(parts) + "。"


def default_questionnaire(category: str, preferences: dict) -> list[dict]:
    """Four category-aware decisions; never ask for irrelevant product attributes."""
    category = category or "好物"
    if category == "好物":
        rows = [
            ("category", "想先逛哪一类好物？", ["台灯", "收纳盒", "餐桌", "其他，自己描述"]),
            ("use", "主要是给自己用、送人，还是找搭配灵感？", ["自己日常用", "送朋友", "先找灵感"]),
            ("priority", "你最希望这件好物带来什么？", ["实用省心", "好看有氛围", "性价比高"]),
        ]
    elif any(word in category for word in ("防晒", "护肤", "面霜")):
        rows = [
            ("use", "你的肤质或最近皮肤状态更接近哪种？", ["偏油，怕黏腻", "偏干，想要滋润", "敏感或不确定"]),
            ("scene", "主要会在什么场景使用？", ["日常通勤", "长时间户外 / 军训", "旅行或运动"]),
            ("priority", "使用感上最在意什么？", ["清爽不泛油", "防水耐汗", "温和好卸"]),
        ]
    elif any(word in category for word in ("台灯", "灯具")):
        rows = [
            ("use", "这盏灯主要放在哪里？", ["书桌阅读", "床头放松", "客厅氛围"]),
            ("scene", "平时主要需要怎样的光？", ["长时间阅读", "柔和氛围", "两种都想兼顾"]),
            ("priority", "选灯时最在意哪一点？", ["调光方便", "桌面占地小", "造型好看"]),
        ]
    elif any(word in category for word in ("餐桌", "桌子", "书桌")):
        rows = [
            ("use", "平时大概几个人使用？", ["1–2 人", "3–4 人", "5 人以上"]),
            ("scene", "摆放空间更接近哪种？", ["小户型 / 租房", "普通餐厅", "空间比较宽敞"]),
            ("priority", "你更希望桌子具备哪点？", ["尺寸省空间", "桌面好打理", "颜值和质感"]),
        ]
    elif any(word in category for word in ("耳机", "音箱")):
        rows = [
            ("use", "主要在什么场景使用？", ["通勤路上", "学习 / 办公", "运动时"]),
            ("scene", "你更习惯哪种佩戴方式？", ["入耳式", "头戴式", "都可以"]),
            ("priority", "最看重什么体验？", ["降噪", "佩戴舒适", "续航"]),
        ]
    else:
        rows = [
            ("use", f"这件{category}主要准备怎么用？", ["日常自己用", "送人", "先找搭配灵感"]),
            ("scene", f"使用{category}时，最常见的场景是？", ["家里", "工作 / 学习", "外出"]),
            ("priority", f"挑{category}时最在意什么？", ["使用体验", "外观风格", "性价比"]),
        ]
    if preferences.get("maxPrice") is None:
        rows.append(("budget", f"这次{category}大概想控制在什么价位？", ["100 元以内", "500 元以内", "1000 元以内", "暂不设预算"]))
    else:
        rows.append(("detail", f"关于{category}，还有哪点最想确认？", ["尺寸 / 规格", "品牌和口碑", "暂时没有，可直接推荐"]))
    field_map = {
        "category": "category", "use": "otherAttributes.useCase",
        "scene": "scenes", "priority": "otherAttributes.priority",
        "budget": "price.max", "detail": "otherAttributes.detail",
    }
    return [{"id": key, "field": field_map[key], "title": title, "options": options,
             "optionValues": {option: option for option in options},
             "affects": ["filter"] if key == "budget" else ["query", "ranking"],
             "hard": key == "budget", "reason": "missing_high_value_field",
             "confidence": 1.0, "allowCustom": True} for key, title, options in rows]


def questionnaire_question(questionnaire: dict) -> dict | None:
    questions = questionnaire.get("questions", [])
    index = len(questionnaire.get("answers", []))
    return questions[index] if index < len(questions) else None


class ShoppingAgent:
    def __init__(self, memory_path: str | Path, search: Search = product_api_search, model=None, *, questionnaire_enabled=True, narrator=None):
        self.memory = MemoryManager(memory_path)
        self.search = search
        self.questionnaire_enabled = questionnaire_enabled
        self.narrator = narrator  # Test-only dependency injection; production uses the installed model.
        self._locks = defaultdict(asyncio.Lock)
        self.agent = WitAgent()
        if model is None and os.getenv("LLM_MODEL") and (os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")):
            model = OpenAIModelComponent(
                model=os.environ["LLM_MODEL"],
                api_key=os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY"),
                base_url=os.getenv("LLM_BASE_URL", "https://api.openai.com/v1"),
                api="chat.completions", timeout=90.0, max_retries=0,
                settings={"max_tokens": 1600, "temperature": 0.2},
            )
        if model is not None:
            self.agent.install(model, required=True)
        category_model_enabled = (
            self.search is product_api_search
            or bool(getattr(self.search, "supports_product_sources", False))
        )
        self.category_auditor = CategoryAuditAgent(
            self.memory, model, category_model_enabled=category_model_enabled,
        )
        graph = WorkflowGraph("shopping", version="1", initialize=lambda _: {})
        graph.node("load", self._load).node("plan", self._plan).node("retrieve", self._retrieve)
        graph.node("reply", self._reply).node("save", self._save).start("load")
        graph.edge("load", "plan").edge("plan", "retrieve").edge("retrieve", "reply")
        graph.edge("reply", "save").edge("save", None)
        self.agent.install(WorkflowLoopComponent(graph), required=True)

    def _source_filters(self, filters: dict, source: str) -> dict:
        if self.search is product_api_search or getattr(self.search, "supports_product_sources", False):
            return {**filters, "_source": source}
        return dict(filters)

    def _log_questionnaire(self, session_id: str, source: str, questions: list[dict]) -> None:
        """Append the minimal questionnaire audit record without affecting the chat flow."""
        log_path = Path(self.memory.path).parent / "questionnaire.events.jsonl"
        record = {
            "sessionId": session_id,
            "source": source,
            "questions": questions,
        }
        try:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError:
            # Logging must never prevent the user from continuing the questionnaire.
            pass

    def _log_category_event(self, event: str, **fields) -> None:
        """Write privacy-minimal structured audit telemetry."""
        record = {"time": datetime.now(timezone.utc).isoformat(), "event": event, **fields}
        try:
            with (Path(self.memory.path).parent / "category-audit.events.jsonl").open(
                    "a", encoding="utf-8") as log:
                log.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError:
            pass

    async def __aenter__(self):
        await self.agent.start()
        return self

    async def __aexit__(self, *_):
        await self.agent.stop()

    async def chat(self, session_id: str, message: str, user_id: str | None = None, *, new_conversation: bool = False, answer: dict | None = None, profile_preferences: dict | None = None) -> dict:
        if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 128:
            raise ValueError("sessionId must be a nonempty string of at most 128 characters")
        if user_id is None:
            user_id = session_id  # Compatibility for callers that only send sessionId.
        if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 128:
            raise ValueError("userId must be a nonempty string of at most 128 characters")
        if not isinstance(message, str) or len(message) > 4000:
            raise ValueError("message must be a string of at most 4000 characters")
        if type(new_conversation) is not bool:
            raise ValueError("newConversation must be a boolean")
        if answer is not None and (not isinstance(answer, dict) or not isinstance(answer.get("questionId"), str)):
            raise ValueError("answer must include questionId")
        if profile_preferences is not None and (not isinstance(profile_preferences, dict) or len(profile_preferences) > 30):
            raise ValueError("profilePreferences must be an object")
        safe_profile = {
            key: (value[0] if isinstance(value, list) and key != "dislikes" and value else value)
            for key, value in (profile_preferences or {}).items()
            if key in {"style", "material", "color", "scene", "dislikes", "maxPrice"}
            and (isinstance(value, (str, int, float)) or isinstance(value, list))
        }
        async with self._locks[user_id]:
            if new_conversation:
                self.memory.reset_session(session_id, user_id)
            result = await self.agent.invoke({"sessionId": session_id, "userId": user_id, "message": message.strip(), "answer": answer, "profilePreferences": safe_profile})
            return result.output.output

    def _load(self, ctx):
        request = ctx.input
        ctx.state["session_id"] = request["sessionId"]
        ctx.state["user_id"] = request["userId"]
        ctx.state["message"] = request["message"]
        ctx.state["answer"] = request.get("answer")
        memory = self.memory.load(request["sessionId"], request["userId"])
        # Account-level preferences are a baseline for a new conversation. Any
        # explicit choice already made inside this conversation wins.
        memory["preferences"] = {**request.get("profilePreferences", {}), **memory.get("preferences", {})}
        ctx.state["memory"] = memory

    async def _questions_for_goal(self, ctx, category: str, preferences: dict, goal: str,
                                  requirement: dict | None = None,
                                  asked_fields: list[str] | None = None) -> list[dict]:
        try:
            model = ctx.invocation.component_context.get(MODEL)
            planned = await questionnaire_plan(model, ctx.invocation, goal, category, preferences,
                                               requirement, asked_fields)
        except LookupError:
            planned = []
        fallback = default_questionnaire(category, preferences)
        questions = [*(planned + fallback[len(planned):3]), fallback[3]]
        source = "llm" if len(planned) == 3 else "fallback"
        self._log_questionnaire(ctx.state["session_id"], source, questions)
        return questions

    async def _plan(self, ctx):
        state = ctx.state
        if state["message"] == "重试生成推荐" and state["memory"].get("pending_result"):
            pending_result = copy.deepcopy(state["memory"]["pending_result"])
            state["preferences"] = pending_result["preferences"]
            state["durable_preferences"] = copy.deepcopy(state["memory"]["preferences"])
            state["temporary"] = copy.deepcopy(state["memory"].get("temporary", {}))
            state["emotion"] = copy.deepcopy(state["memory"].get("emotion") or {})
            state["policy"] = {"action": "narrative_retry", "question_count": 0,
                               "recommendation_count": len(pending_result["items"])}
            state["items"] = pending_result["items"]
            state["questionnaire"] = pending_result.get("questionnaire")
            state["query"] = pending_result.get("query", "")
            return
        pending = copy.deepcopy(state["memory"].get("questionnaire"))
        current_requirement = copy.deepcopy(state["memory"].get("shopping_requirement"))
        if not isinstance(current_requirement, dict):
            current_requirement = requirement_from_legacy(state["memory"].get("preferences"))
        fallback_delta = validate_requirement_delta(
            extract_high_confidence_fallbacks(state["message"]), state["message"],
            bool(state["memory"].get("current_items")),
        )
        preview_requirement = merge_requirement(current_requirement, fallback_delta, state["message"])
        incoming = derive_legacy_preferences(preview_requirement)
        previous_category = state["memory"].get("shopping_category")
        category_changed = bool(incoming.get("category") and previous_category
                                and incoming["category"] != previous_category
                                and not state.get("answer") and re.search(
                                    r"想买|我要买|想找|换成|改成|重新找", state["message"]))
        if category_changed:
            # A different product is a new shopping task within this conversation.
            # Conditions and products for the previous product cannot guide it.
            state["memory"].update(preferences={}, temporary={}, current_items=[],
                                   last_query="", questionnaire=None, pending_result=None,
                                   shopping_answers=[], yuemai_anchor=None,
                                   yuemai_initial_preferences={}, shopping_requirement=None,
                                   asked_fields=[], last_search_plan=None)
            current_requirement = empty_requirement(state["message"])
        if pending and category_changed:
            pending = None
        if pending and questionnaire_question(pending):
            expected = questionnaire_question(pending)
            answer = state.get("answer")
            if answer and answer["questionId"] != expected["id"]:
                state["invalid_answer"] = True
                state["questionnaire"] = pending
                state["policy"] = {"action": "questionnaire", "question_count": 1, "recommendation_count": 0}
                state["preferences"] = copy.deepcopy(state["memory"]["preferences"])
                state["durable_preferences"] = copy.deepcopy(state["preferences"])
                state["temporary"] = copy.deepcopy(state["memory"].get("temporary", {}))
                state["emotion"] = {}
                return
            if answer or not re.search(r"想买|我要买|想找|换成|改成|重新找", state["message"]):
                value = str((answer or {}).get("value") or state["message"]).strip()[:80]
                if expected["id"] == "category":
                    chosen = extract_updates(value).get("category")
                    if not chosen and re.fullmatch(r"[\u4e00-\u9fffA-Za-z0-9]{2,12}", value):
                        if value not in ("日系", "韩系", "北欧", "法式", "简约", "原木", "低饱和"):
                            chosen = value
                    if not chosen:
                        state["invalid_answer"] = True
                        state["questionnaire"] = pending
                        state["policy"] = {"action": "questionnaire", "question_count": 1, "recommendation_count": 0}
                        state["preferences"] = copy.deepcopy(state["memory"]["preferences"])
                        state["durable_preferences"] = copy.deepcopy(state["preferences"])
                        state["temporary"] = copy.deepcopy(state["memory"].get("temporary", {}))
                        state["emotion"] = {}
                        return
                    pending["category"] = chosen
                    pending["initialPreferences"] = {
                        **copy.deepcopy(pending.get("initialPreferences") or {}),
                        "category": chosen,
                    }
                    # The remaining questions must follow the category the user chose.
                    tailored = await self._questions_for_goal(
                        ctx, chosen, {**state["memory"]["preferences"], "category": chosen},
                        pending.get("goal") or state["message"], current_requirement,
                        state["memory"].get("asked_fields", []),
                    )
                    pending["questions"] = [pending["questions"][0], tailored[0], tailored[2], tailored[3]]
                pending["answers"].append({"id": expected["id"], "title": expected["title"], "value": value})
                field = str(expected.get("field") or "")
                mapped_value = (expected.get("optionValues") or {}).get(value, value)
                if field == "category":
                    answer_delta = validate_requirement_delta({"intent": "search_product", "changes": {
                        "category": {"set": {"raw": value, "evidence": value, "source": "explicit"}}
                    }}, value)
                elif field == "price.max":
                    match = re.search(r"(\d+(?:\.\d+)?)\s*元\s*(?:以内|以下)", value)
                    answer_delta = validate_requirement_delta({"intent": "refine_search", "changes": {
                        "price": {"set": {"max": float(match[1]), "evidence": match.group(0),
                                          "source": "explicit", "hard": True}}
                    }}, value) if match else {"intent": "refine_search", "changes": {}}
                elif field.startswith("otherAttributes."):
                    answer_delta = {"intent": "refine_search", "changes": {"otherAttributes": {"set": {
                        field.split(".", 1)[1]: {"raw": value, "normalized": mapped_value,
                                                 "source": "explicit", "evidence": value,
                                                 "hard": bool(expected.get("hard", False))}
                    }}}}
                elif field == "scenes":
                    answer_delta = {"intent": "refine_search", "changes": {"otherAttributes": {"set": {
                        "scene": {"raw": value, "normalized": mapped_value, "source": "explicit",
                                  "evidence": value, "hard": False}
                    }}}}
                else:
                    answer_delta = {"intent": "refine_search", "changes": {}}
                current_requirement = merge_requirement(current_requirement, answer_delta, value)
                state["requirement"] = current_requirement
                state["asked_fields"] = list(dict.fromkeys([
                    *state["memory"].get("asked_fields", []), field,
                ]))
                state["questionnaire"] = pending
                state["answering_questionnaire"] = True
                state["message"] = value
        durable = copy.deepcopy(state["memory"]["preferences"])
        temporary = copy.deepcopy(state["memory"].get("temporary", {}))
        budget = temporary_budget(state["message"])
        if usual_budget(state["message"]):
            temporary.pop("maxPrice", None)
        elif budget is not None:
            temporary["maxPrice"] = budget
        elif re.search(r"(?:预算|不超过|低于|少于|控制在|最多)\D{0,5}\d+", state["message"]):
            temporary.pop("maxPrice", None)
        model_parse = {}
        requirement_delta = fallback_delta
        if not state.get("answering_questionnaire"):
            try:
                model = ctx.invocation.component_context.get(MODEL)
                requirement_delta = await parse_requirement_delta(
                    model, ctx.invocation, state["message"], current_requirement,
                    bool(state["memory"]["current_items"]),
                )
            except LookupError:
                pass
            requirement_delta = merge_fallback_without_overwriting_valid_entities(
                requirement_delta, fallback_delta,
            )
            current_requirement = merge_requirement(current_requirement, requirement_delta,
                                                    state["message"])
        state["requirement"] = current_requirement
        structured_preferences = derive_legacy_preferences(current_requirement)
        legacy_parse = requirement_delta.get("legacyParse") if isinstance(requirement_delta.get("legacyParse"), dict) else {}
        model_parse = {
            "query": {**(legacy_parse.get("query") or {}), **structured_preferences},
            "memory": copy.deepcopy(legacy_parse.get("memory") or {}),
            "intent": legacy_parse.get("intent") or {"search_product": "search", "refine_search": "search"}.get(
                requirement_delta.get("intent"), requirement_delta.get("intent")
            ),
        }
        self._log_category_event(
            "requirement_parsed", sessionId=state["session_id"],
            intent=requirement_delta.get("intent"),
            fields=list((requirement_delta.get("changes") or {}).keys()),
            warningCount=len(requirement_delta.get("parseWarnings") or []),
        )
        self._log_category_event(
            "requirement_normalized", sessionId=state["session_id"],
            category=(current_requirement.get("category") or {}).get("canonical"),
            aliasCount=len((current_requirement.get("category") or {}).get("aliases") or []),
            brandCount=len(current_requirement.get("brands", {}).get("include", [])),
            hardConstraintCount=len(current_requirement.get("hardConstraints") or []),
            softPreferenceCount=len(current_requirement.get("softPreferences") or []),
        )
        working_memory = {**state["memory"], "preferences": {**durable, **temporary}}
        preference, emotion, policy = understand(state["message"], working_memory, model_parse)
        if policy.get("action") == "forget":
            current_requirement = empty_requirement(state["message"])
            state["requirement"] = current_requirement
            structured_preferences = {}
            temporary = {}
        else:
            preference.update(structured_preferences)
            preference.update(temporary)
        forgotten = forget_field(state["message"])
        if forgotten in ("all", "maxPrice"):
            temporary.pop("maxPrice", None)
        if usual_budget(state["message"]):
            if "maxPrice" in durable:
                preference["maxPrice"] = durable["maxPrice"]
            else:
                preference.pop("maxPrice", None)
        durable_preferences = copy.deepcopy(preference)
        if "maxPrice" in temporary:
            if "maxPrice" in durable:
                durable_preferences["maxPrice"] = durable["maxPrice"]
            else:
                durable_preferences.pop("maxPrice", None)
        ctx.state["preferences"] = preference
        ctx.state["durable_preferences"] = durable_preferences
        ctx.state["temporary"] = temporary
        ctx.state["emotion"] = emotion
        ctx.state["policy"] = policy
        if state.get("answering_questionnaire"):
            # A questionnaire answer augments the current shopping goal; it is
            # never interpreted as a request for a different product.
            preference["category"] = pending["category"]
            durable_preferences["category"] = pending["category"]
            state["preferences"] = preference
            state["durable_preferences"] = durable_preferences
            if pending["answers"][-1]["id"] == "budget":
                value = pending["answers"][-1]["value"]
                match = re.search(r"(\d+(?:\.\d+)?)\s*元\s*(?:以内|以下)", value)
                if match:
                    preference["maxPrice"] = float(match[1])
                    durable_preferences["maxPrice"] = float(match[1])
            policy["action"] = "questionnaire" if questionnaire_question(pending) else "search"
            return
        if action := policy.get("action"):
            should_start = action == "search" and (not previous_category or category_changed or not state["memory"].get("last_query"))
            if action in ("explore", "clarify") and not previous_category and not state["memory"].get("current_items"):
                should_start = True
            if self.questionnaire_enabled and should_start:
                category = str(preference.get("category") or "").strip()
                if category:
                    questions = await self._questions_for_goal(
                        ctx, category, preference, state["message"], current_requirement,
                        state["memory"].get("asked_fields", []),
                    )
                else:
                    questions = default_questionnaire(category, preference)
                    try:
                        model = ctx.invocation.component_context.get(MODEL)
                        first = await category_question_plan(model, ctx.invocation,
                                                             state["message"], preference)
                        if first:
                            questions[0] = first
                    except LookupError:
                        pass
                state["questionnaire"] = {
                    "category": category,
                    "goal": state["message"],
                    "questions": questions,
                    "answers": [],
                    "initialPreferences": copy.deepcopy(preference),
                }
                if questions:
                    self._log_category_event(
                        "question_selected", sessionId=state["session_id"],
                        field=questions[0].get("field"), affects=questions[0].get("affects", []),
                        reason=questions[0].get("reason", "missing_high_value_field"),
                    )
                policy["action"] = "questionnaire"

    async def _retrieve(self, ctx):
        state = ctx.state
        action = state["policy"]["action"]
        if action == "narrative_retry":
            return  # Reuse the exact source products; do not search for different goods.
        state["items"] = []
        if action in ("compare_current", "current_detail"):
            state["current_items"] = copy.deepcopy(state["memory"].get("current_items", []))
            return
        if action != "search":
            return
        prefs = state["preferences"]
        if not prefs.get("category") and prefs.get("scene") == "桌面":
            state["browse"] = True
            state["query"] = "browse:桌面"
            filters = {"end_price": prefs["maxPrice"]} if prefs.get("maxPrice") is not None else {}
            selected, categories, failures = [], {}, 0
            for category in ("台灯", "收纳盒", "摆件"):
                keyword = {"台灯": "台灯" if prefs.get("style") else "桌面台灯", "收纳盒": "收纳盒", "摆件": "摆件" if prefs.get("style") else "桌面摆件"}[category]
                query = " ".join(part for part in (prefs.get("style"), keyword) if part)
                try:
                    payload = await self.search(query, filters)
                    if isinstance(payload, dict) and not payload.get("ok", True):
                        failures += 1
                        continue
                    raw = payload.get("items", []) if isinstance(payload, dict) else payload
                    if not isinstance(raw, list):
                        failures += 1
                        continue
                    forbidden = {
                        "台灯": ("酒吧", "清吧", "户外", "露营", "夜市"),
                        "收纳盒": ("内衣", "袜子", "衣服"),
                        "摆件": ("动漫", "二次元", "手办", "周边", "立牌", "盲盒", "净化空气", "招财"),
                    }[category]
                    raw = [item for item in raw if isinstance(item, dict)
                           and (category == "台灯" or "桌面" in str((item.get("facts") or item).get("title", "")))
                           and not any(word in str((item.get("facts") or item).get("title", "")) for word in forbidden)]
                    matches = select_products(raw, {**prefs, "category": category})
                    style = prefs.get("style")
                    if style:
                        aliases = STYLE_EQUIVALENTS.get(style, (style,))
                        matches = [item for item in matches if any(alias in item["title"] for alias in aliases) or style in (item["semantic"].get("style_tags") or [])]
                    match = next((item for item in matches if item["id"] not in {entry["id"] for entry in selected}), None)
                    if match:
                        selected.append(match)
                        categories[match["id"]] = category
                except (httpx.HTTPError, OSError, TimeoutError, ValueError):
                    failures += 1
            state["items"] = selected
            state["browse_categories"] = categories
            if failures == 3:
                state["search_error"] = "商品搜索暂时不可用，请稍后重试"
            return
        answers = ((state.get("questionnaire") or {}).get("answers")
                   or state["memory"].get("shopping_answers", []))
        answer_terms = []
        for row in answers:
            if row.get("id") not in ("use", "scene", "priority", "detail"):
                continue
            value = str(row.get("value", ""))
            answer_terms.extend(
                term for term in ("书桌", "床头", "阅读", "小户型", "两人", "四人", "通勤", "运动",
                                  "户外", "军训", "清爽", "防水", "耐汗", "原木", "简约", "收纳")
                if term in value
            )
        prefs = {**prefs, "answer_terms": list(dict.fromkeys(answer_terms))}
        filters = {"end_price": prefs["maxPrice"]} if prefs.get("maxPrice") is not None else {}
        try:
            requirement = {
                "targetCategory": (state.get("requirement") or {}).get("category") or prefs.get("category", ""),
                "goal": (state.get("questionnaire") or {}).get("goal") or state["message"],
                "preferences": prefs,
                "answers": answers,
                "shoppingRequirement": state.get("requirement") or {},
            }
            plan = await self.category_auditor.plan_search(ctx.invocation, requirement)
            queries = list(dict.fromkeys([*plan["queries"], *plan.get("fallbackQueries", [])]))[:4]
            state["search_plan"] = copy.deepcopy(plan)
            state["query"] = queries[0] if queries else str(prefs.get("category") or "")
            self._log_category_event(
                "category_audit_plan", sessionId=state["session_id"],
                category=plan["targetCategory"], queryCount=len(queries),
                excludeTermCount=len(plan["excludeTerms"]),
                excludeTermsSource=plan["excludeTermsSource"],
            )
            self._log_category_event(
                "search_plan_created", sessionId=state["session_id"],
                queryCount=len(queries), filterFields=[key for key, value in filters.items() if value is not None],
                fallbackQueryCount=len(plan.get("fallbackQueries", [])),
            )

            accepted_by_id = {}
            source_aware = (
                self.search is product_api_search
                or bool(getattr(self.search, "supports_product_sources", False))
            )
            model = self.category_auditor.model
            for attempt, candidate_query in enumerate(queries):
                try:
                    payload = await self.search(
                        candidate_query, self._source_filters(filters, "taobao")
                    )
                except (httpx.HTTPError, OSError, TimeoutError, ValueError):
                    if attempt == 0:
                        state["search_error"] = "商品搜索暂时不可用，请稍后重试"
                    continue
                if isinstance(payload, dict) and not payload.get("ok", True):
                    if attempt == 0:
                        error = payload.get("error")
                        state["search_error"] = str(
                            error.get("message") if isinstance(error, dict) else "商品搜索暂时不可用"
                        )
                    continue
                raw = payload.get("items", []) if isinstance(payload, dict) else payload
                if not isinstance(raw, list):
                    continue
                source_aware = source_aware or payload_has_source_metadata(payload, raw)
                raw = [item for item in raw
                       if not source_aware or product_source_name(item) in ("", "taobao")]
                basic_filter = {}
                batch = select_products(
                    raw, prefs, limit=20,
                    allow_style_unknown=self.category_auditor.category_model_enabled,
                    diagnostics=basic_filter,
                )
                batch = [item for item in batch if item["id"] not in accepted_by_id]
                self._log_category_event(
                    "category_basic_filter", sessionId=state["session_id"],
                    category=plan["targetCategory"], query=candidate_query,
                    sourceCount=len(raw), normalizedCount=basic_filter["normalizedCount"],
                    qualifiedCount=basic_filter["qualifiedCount"], passedCount=len(batch),
                    rejectedCount=sum(basic_filter["rejectionReasons"].values()),
                    rejectionReasons=basic_filter["rejectionReasons"],
                    rejectedSample=basic_filter["rejectedSample"],
                )
                audit = await self.category_auditor.audit_products(
                    ctx.invocation, plan.get("targetCategoryContract") or plan["targetCategory"],
                    plan["excludeTerms"], batch,
                )
                by_id = {item["id"]: item for item in batch}
                for decision in audit["accepted"]:
                    item = by_id.get(decision["id"])
                    if item:
                        item["categoryAudit"] = copy.deepcopy(decision)
                        accepted_by_id[item["id"]] = item
                self._log_category_event(
                    "category_audit_batch", sessionId=state["session_id"],
                    category=plan["targetCategory"], query=candidate_query,
                    candidateCount=len(batch), acceptedCount=len(audit["accepted"]),
                    rejectedCount=len(audit["rejected"]), uncertainCount=len(audit["uncertain"]),
                )
                if len(accepted_by_id) >= 3:
                    break
                if attempt + 1 < len(queries):
                    self._log_category_event(
                        "category_audit_retry", sessionId=state["session_id"],
                        category=plan["targetCategory"], acceptedTotal=len(accepted_by_id),
                        nextQueryIndex=attempt + 1,
                    )

            accepted = list(accepted_by_id.values())
            if model is not None and accepted:
                choice = await product_plan(model, ctx.invocation, prefs, accepted)
                state["lead"] = choice["lead"]
                by_id = {item["id"]: item for item in accepted}
                selected = [by_id[item_id] for item_id in choice["ids"] if item_id in by_id]
                for item in accepted:
                    if len(selected) >= 3:
                        break
                    if item["id"] not in {entry["id"] for entry in selected}:
                        selected.append(item)
                state["items"] = selected[:3]
            else:
                state["items"] = accepted[:3]

            if source_aware:
                taobao_items = state["items"][:3]
                for item in taobao_items:
                    item["selectionScope"] = "refined_preferences"
                    item["matchPolicy"] = "full_questionnaire"

                initial_prefs = copy.deepcopy(
                    (state.get("questionnaire") or {}).get("initialPreferences")
                    or state["memory"].get("yuemai_initial_preferences")
                    or {"category": prefs.get("category", "")}
                )
                if prefs.get("category") and not initial_prefs.get("category"):
                    initial_prefs["category"] = prefs["category"]
                state["yuemai_initial_preferences"] = initial_prefs
                anchor = normalize_product(state["memory"].get("yuemai_anchor") or {})
                if anchor and product_source_name(anchor) != "yuemai":
                    anchor = None
                if anchor is None and initial_prefs.get("category"):
                    initial_filters = {}
                    if initial_prefs.get("maxPrice") is not None:
                        initial_filters["end_price"] = initial_prefs["maxPrice"]
                    try:
                        yuemai_payload = await self.search(
                            str(initial_prefs["category"]),
                            self._source_filters(initial_filters, "yuemai"),
                        )
                        yuemai_raw = (yuemai_payload.get("items", [])
                                      if isinstance(yuemai_payload, dict) else yuemai_payload)
                        yuemai_matches = select_products(
                            [item for item in yuemai_raw if product_source_name(item) == "yuemai"]
                            if isinstance(yuemai_raw, list) else [],
                            initial_prefs, limit=20, allow_style_unknown=True,
                        )
                        yuemai_audit = await self.category_auditor.audit_products(
                            ctx.invocation, plan.get("targetCategoryContract") or plan["targetCategory"],
                            plan["excludeTerms"], yuemai_matches,
                        )
                        yuemai_by_id = {item["id"]: item for item in yuemai_matches}
                        first = yuemai_audit["accepted"][0] if yuemai_audit["accepted"] else None
                        anchor = yuemai_by_id.get(first["id"]) if first else None
                        if anchor:
                            anchor["categoryAudit"] = copy.deepcopy(first)
                        self._log_category_event(
                            "category_audit_batch", sessionId=state["session_id"],
                            category=plan["targetCategory"], query=str(initial_prefs["category"]),
                            source="yuemai", candidateCount=len(yuemai_matches),
                            acceptedCount=len(yuemai_audit["accepted"]),
                            rejectedCount=len(yuemai_audit["rejected"]),
                            uncertainCount=len(yuemai_audit["uncertain"]),
                        )
                    except (httpx.HTTPError, OSError, TimeoutError, ValueError):
                        anchor = None
                elif anchor:
                    cached_audit = await self.category_auditor.audit_products(
                        ctx.invocation, plan.get("targetCategoryContract") or plan["targetCategory"],
                        plan["excludeTerms"], [anchor],
                    )
                    if not cached_audit["accepted"]:
                        anchor = None

                if anchor:
                    anchor["selectionScope"] = "initial_request"
                    anchor["matchPolicy"] = "initial_request_only"
                    anchor["matchReasons"] = [
                        f"悦买商品名称与首次品类“{initial_prefs.get('category', '')}”匹配",
                        *[reason for reason in anchor.get("matchReasons", []) if reason.startswith("标价")],
                    ]
                    state["yuemai_anchor"] = copy.deepcopy(anchor)
                    state["items"] = [anchor, *taobao_items[:2]]
                else:
                    state["yuemai_anchor"] = None
                    state["items"] = taobao_items[:3]
            if state["items"]:
                state.pop("search_error", None)
        except Exception as exc:
            self._log_category_event(
                "retrieval_failed", sessionId=state["session_id"],
                errorType=type(exc).__name__, errorMessage=str(exc)[:240],
            )
            if not state["items"]:
                state["search_error"] = "商品搜索暂时不可用，请稍后重试"

    async def _reply(self, ctx):
        state = ctx.state
        action = state["policy"]["action"]
        prefs = state["preferences"]
        if action == "questionnaire":
            question = questionnaire_question(state["questionnaire"])
            if state.get("invalid_answer"):
                message = "这道问题已经切换了，请回答当前这一题。"
            else:
                message = f"好，我先了解一下你挑{state['questionnaire']['category'] or '好物'}时在意的点，再帮你找更合适的。"
            kind = "question"
        elif action == "forget":
            message, kind = "好的，相关偏好记忆已经删除。", "question"
        elif action == "recall":
            tags = [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]
            if prefs.get("maxPrice") is not None:
                tags.append(f"预算 ¥{prefs['maxPrice']:g} 以内")
            message, kind = ("我记得你提过：" + "、".join(tags) + "。" if tags else "目前还没有记下明确偏好。"), "question"
        elif action in ("compare_current", "current_detail"):
            message, kind = compare_message(state.get("current_items", []), state["message"]), "comparison"
        elif action == "explore":
            if state["emotion"]["mood"] == "stop_selling":
                opening = "这盏灯先收藏着，今天不考虑购买。" if "收藏" in state["message"] else "好，今天先不考虑购买。"
                message = opening + "想聊聊搭配感觉，还是先看看别的方向？"
            elif "累" in state["message"] or "不想做选择" in state["message"]:
                message = "累了就先不做选择，随手逛逛就好。想看温暖一点的氛围，还是清爽一点的？"
            elif "搭配参考" in state["message"]:
                message = "明白，现在只是做搭配参考，不用急着定下来。想先对照颜色，还是材质？"
            else:
                message = "无聊时随便看看也挺好，不用先定预算。想从暖光台灯、桌面收纳还是小摆件开始？"
            kind = "question"
        elif action == "change_direction":
            message, kind = "抱歉，这个方向没对上你的感觉。想先换材质，还是换个品类？", "question"
        elif action == "clarify":
            if any(word in state["message"] for word in ("第一款", "第二款", "第三款", "上一轮", "刚才那", "这几款", "那几款", "这款", "那款", "这个商品", "它的", "它是", "它有", "它呢")):
                message, kind = "这是新的对话，我没有把上一轮商品带过来。你可以说说想看的品类，我再帮你找。", "question"
            else:
                message, kind = "可以。你想先看哪一类？比如台灯、收纳或耳机。", "question"
        elif state.get("search_error"):
            message, kind = state["search_error"], "error"
        elif not state["items"]:
            message = "这轮暂时没找到贴近的桌面好物。想先看台灯还是收纳？" if state.get("browse") else "按这轮条件暂时没有合适商品。要换个关键词，还是调整预算？"
            kind = "results"
        else:
            message = ""
            kind = "results"
        narrative = None
        if kind == "results" and state["items"]:
            try:
                try:
                    model = self.narrator or ctx.invocation.component_context.get(MODEL)
                except LookupError:
                    model = None
                answers = ((state.get("questionnaire") or {}).get("answers")
                           or state["memory"].get("shopping_answers", []))
                narrative = await recommendation_plan(
                    model, ctx.invocation,
                    (state.get("questionnaire") or {}).get("goal")
                    or (state["memory"].get("pending_result") or {}).get("goal")
                    or state["message"],
                    prefs, answers, state["items"],
                )
            except NarrativeGenerationError as exc:
                state["narrative_error"] = str(exc)
                try:
                    with Path(self.memory.path).with_suffix(".events.log").open("a", encoding="utf-8") as log:
                        log.write(json.dumps({"time": datetime.now(timezone.utc).isoformat(),
                                              "event": "narrative_failed", "reason": str(exc),
                                              "productCount": len(state["items"])}, ensure_ascii=False) + "\n")
                except OSError:
                    pass  # Logging must never replace the user-facing retry response.
                state["pending_result"] = {
                    "items": copy.deepcopy(state["items"]),
                    "preferences": copy.deepcopy(prefs),
                    "questionnaire": copy.deepcopy(state.get("questionnaire")),
                    "query": state.get("query", ""),
                    "goal": (state.get("questionnaire") or {}).get("goal") or state["message"],
                }
                message = "商品已经找到，但 AI 导购分析暂时没生成成功。请重试生成；这次不会用固定话术代替。"
                kind = "error"
            else:
                for item in state["items"]:
                    reason = narrative["items"][item["id"]]
                    item["talkingPoint"] = reason
                    item["recommendation"] = reason
                message = narrative["intro"]
        next_question = ({**question, "step": len(state["questionnaire"]["answers"]) + 1,
                          "total": len(state["questionnaire"]["questions"])}
                         if action == "questionnaire" and question else None)
        state["response"] = {
            "ok": kind != "error", "type": kind, "message": message,
            "items": copy.deepcopy(state["items"]) if kind == "results" else [],
            "candidateItems": copy.deepcopy(state["items"]) if state.get("narrative_error") else [],
            "summary": narrative["summary"] if narrative else "",
            "emphasis": narrative.get("emphasis", []) if narrative else [],
            "followUp": narrative["followUp"] if narrative else "",
            "narrativeSource": "ai" if narrative else "none",
            "question": copy.deepcopy(next_question),
            "task": {"category": state["questionnaire"]["category"], "answers": {
                row["id"]: row["value"] for row in state["questionnaire"]["answers"]
            }} if state.get("questionnaire") else None,
            "memory": {"preferences": {**copy.deepcopy(prefs), "memoryTags": [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]}, "turns": state["memory"].get("turns", 0) + 1, "currentRecommendationCount": 0 if action == "forget" and forget_field(state["message"]) == "all" else len(state["items"] or state["memory"].get("current_items", []))},
            "emotion": copy.deepcopy(state["emotion"]), "policy": copy.deepcopy(state["policy"]),
            "requirementDebug": requirement_debug(state.get("requirement")),
        }
        if kind == "error":
            state["response"]["error"] = {"code": "NARRATIVE_UNAVAILABLE" if state.get("narrative_error") else "SEARCH_ERROR", "message": message}

    def _save(self, ctx):
        state = ctx.state
        data = state["memory"]
        forget_all = state["policy"]["action"] == "forget" and forget_field(state["message"]) == "all"
        if forget_all:
            data["current_items"] = []
            data["last_query"] = ""
            data["feedback"] = []
            data["pending_result"] = None
            data["yuemai_anchor"] = None
            data["yuemai_initial_preferences"] = {}
            data["shopping_requirement"] = None
            data["asked_fields"] = []
            data["last_search_plan"] = None
        elif isinstance(state.get("requirement"), dict):
            data["shopping_requirement"] = copy.deepcopy(state["requirement"])
            data["requirement_schema_version"] = 1
            data["asked_fields"] = copy.deepcopy(state.get("asked_fields", data.get("asked_fields", [])))
            if isinstance(state.get("search_plan"), dict):
                data["last_search_plan"] = copy.deepcopy(state["search_plan"])
        data["preferences"] = copy.deepcopy(state["durable_preferences"])
        data["temporary"] = copy.deepcopy(state["temporary"])
        data["emotion"] = copy.deepcopy(state["emotion"])
        data["turns"] = data.get("turns", 0) + 1
        if state.get("questionnaire"):
            data["questionnaire"] = copy.deepcopy(state["questionnaire"])
            data["shopping_category"] = state["questionnaire"]["category"]
            initial = state["questionnaire"].get("initialPreferences")
            if isinstance(initial, dict):
                data["yuemai_initial_preferences"] = copy.deepcopy(initial)
        if not forget_all and ("收藏" in state["message"] or "不喜欢" in state["message"]):
            feedback_type = "saved" if "收藏" in state["message"] else "disliked"
            index = next((i for token, i in (("第一款", 0), ("第二款", 1), ("第三款", 2)) if token in state["message"]), None)
            current_items = data.get("current_items", [])
            item_ids = [current_items[index]["id"]] if index is not None and index < len(current_items) else []
            data["feedback"] = [*data.get("feedback", []), {"type": feedback_type, "itemIds": item_ids}][-20:]
        if state.get("narrative_error"):
            data["pending_result"] = copy.deepcopy(state["pending_result"])
        if "yuemai_anchor" in state:
            data["yuemai_anchor"] = copy.deepcopy(state["yuemai_anchor"])
        if isinstance(state.get("yuemai_initial_preferences"), dict):
            data["yuemai_initial_preferences"] = copy.deepcopy(state["yuemai_initial_preferences"])
        if state["policy"]["action"] in ("search", "narrative_retry") and not state.get("search_error") and not state.get("narrative_error"):
            data["current_items"] = copy.deepcopy(state["items"])
            data["last_query"] = state.get("query", "")
            if state.get("questionnaire"):
                data["shopping_answers"] = copy.deepcopy(state["questionnaire"]["answers"])
            data["questionnaire"] = None
            data["shopping_category"] = state["preferences"].get("category", "")
            data["pending_result"] = None
        self.memory.save(
            state["session_id"], data, state["user_id"],
            forget_all=forget_all,
        )
        return state["response"]
