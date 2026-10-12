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

from .llm import (NarrativeGenerationError, category_question_plan, interpret, product_plan,
                  questionnaire_plan, recommendation_plan, search_plan)
from .memory import MemoryManager
from .policy import extract_updates, forget_field, temporary_budget, understand, usual_budget

Search = Callable[[str, dict], Awaitable[dict | list]]
CATEGORY_EQUIVALENTS = {"桌面灯": ("桌面灯", "台灯"), "台灯": ("台灯", "桌面灯"), "腮红": ("腮红", "胭脂"), "耳机": ("耳机", "耳麦"), "餐桌": ("餐桌", "饭桌", "餐台"), "裤子": ("裤子", "裤")}
STYLE_EQUIVALENTS = {"日系": ("日系", "日式"), "韩系": ("韩系", "韩式"), "北欧": ("北欧",), "法式": ("法式",)}
STYLE_CONFLICTS = ("日系", "日式", "韩系", "韩式", "北欧", "欧式", "美式", "法式")


async def product_api_search(query: str, filters: dict) -> dict:
    url = os.getenv("WIT_PRODUCT_URL", "http://127.0.0.1:3000/api/products/search")
    async with httpx.AsyncClient(timeout=9.0) as client:
        response = await client.post(url, json={"query": query, "filters": filters})
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
    return {
        "id": str(raw.get("id") or raw.get("product_id") or title),
        "title": title,
        "price": price,
        "imageUrl": str(image_url or ""),
        "promotionUrl": str(raw.get("promotionUrl") or ""),
        "source": copy.deepcopy(source) if isinstance(source, dict) else str(source or ""),
        "shopName": str(raw.get("shopName") or ""),
        "media": copy.deepcopy(media) if isinstance(media, dict) else {},
        "facts": {"title": title, "price": price, "material": copy.deepcopy(facts.get("material")), "color": copy.deepcopy(facts.get("color")), "dimensions": copy.deepcopy(facts.get("dimensions"))},
        "semantic": copy.deepcopy(raw.get("semantic")) if isinstance(raw.get("semantic"), dict) else {},
    }


def select_products(raw_items: list, preferences: dict, limit: int = 3,
                    allow_style_unknown: bool = False) -> list:
    budget = preferences.get("maxPrice")
    category = preferences.get("category", "")
    style = preferences.get("style", "")
    material = preferences.get("material", "")
    dislikes = preferences.get("dislikes") or []
    answer_terms = preferences.get("answer_terms") or []
    seen = set()
    ranked = []
    for raw in raw_items:
        item = normalize_product(raw)
        if not item or item["id"] in seen:
            continue
        title = item["title"]
        if any(isinstance(dislike, str) and dislike.strip("感的 ") and dislike.strip("感的 ") in title for dislike in dislikes):
            continue
        title_key = "".join(character for character in title.lower() if character.isalnum())[:32]
        if title_key in seen:
            continue
        if category == "餐桌":
            if any(word in title for word in ("桌布", "桌垫", "桌旗", "桌巾", "桌罩", "餐垫", "台布", "装饰画", "挂画", "壁画", "背景墙", "贴纸", "花瓶", "摆件", "餐椅", "靠背椅", "扶手椅", "椅子", "座椅", "桌椅")):
                continue
        if budget is not None and (item["price"] is None or item["price"] > budget):
            continue
        category_match = bool(category and any(term in title for term in CATEGORY_EQUIVALENTS.get(category, (category,))))
        if category and not category_match:
            continue
        style_aliases = STYLE_EQUIVALENTS.get(style, (style,)) if style else ()
        if style in STYLE_EQUIVALENTS and any(term in title for term in STYLE_CONFLICTS if term not in style_aliases):
            continue
        style_tags = item["semantic"].get("style_tags") or []
        style_match = bool(style and (any(term in title for term in style_aliases) or style in style_tags))
        if category == "餐桌" and style == "日系" and not style_match and not allow_style_unknown:
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
    return [{"id": key, "title": title, "options": options, "allowCustom": True} for key, title, options in rows]


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
                api="chat.completions", timeout=30.0, max_retries=0,
            )
        if model is not None:
            self.agent.install(model, required=True)
        graph = WorkflowGraph("shopping", version="1", initialize=lambda _: {})
        graph.node("load", self._load).node("plan", self._plan).node("retrieve", self._retrieve)
        graph.node("reply", self._reply).node("save", self._save).start("load")
        graph.edge("load", "plan").edge("plan", "retrieve").edge("retrieve", "reply")
        graph.edge("reply", "save").edge("save", None)
        self.agent.install(WorkflowLoopComponent(graph), required=True)

    async def __aenter__(self):
        await self.agent.start()
        return self

    async def __aexit__(self, *_):
        await self.agent.stop()

    async def chat(self, session_id: str, message: str, user_id: str | None = None, *, new_conversation: bool = False, answer: dict | None = None) -> dict:
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
        async with self._locks[user_id]:
            if new_conversation:
                self.memory.reset_session(session_id, user_id)
            result = await self.agent.invoke({"sessionId": session_id, "userId": user_id, "message": message.strip(), "answer": answer})
            return result.output.output

    def _load(self, ctx):
        request = ctx.input
        ctx.state["session_id"] = request["sessionId"]
        ctx.state["user_id"] = request["userId"]
        ctx.state["message"] = request["message"]
        ctx.state["answer"] = request.get("answer")
        ctx.state["memory"] = self.memory.load(request["sessionId"], request["userId"])

    async def _questions_for_goal(self, ctx, category: str, preferences: dict, goal: str) -> list[dict]:
        try:
            model = ctx.invocation.component_context.get(MODEL)
            planned = await questionnaire_plan(model, ctx.invocation, goal, category, preferences)
        except LookupError:
            planned = []
        fallback = default_questionnaire(category, preferences)
        return [*(planned + fallback[len(planned):3]), fallback[3]]

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
        incoming = extract_updates(state["message"])
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
                                   shopping_answers=[])
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
                    # The remaining questions must follow the category the user chose.
                    tailored = await self._questions_for_goal(
                        ctx, chosen, {**state["memory"]["preferences"], "category": chosen},
                        pending.get("goal") or state["message"],
                    )
                    pending["questions"] = [pending["questions"][0], tailored[0], tailored[2], tailored[3]]
                pending["answers"].append({"id": expected["id"], "title": expected["title"], "value": value})
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
        if not state.get("answering_questionnaire"):
            try:
                model = ctx.invocation.component_context.get(MODEL)
                model_parse = await interpret(
                    model, ctx.invocation, state["message"],
                    state["memory"]["preferences"], bool(state["memory"]["current_items"]),
                )
            except LookupError:
                pass
        working_memory = {**state["memory"], "preferences": {**durable, **temporary}}
        preference, emotion, policy = understand(state["message"], working_memory, model_parse)
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
                    questions = await self._questions_for_goal(ctx, category, preference, state["message"])
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
                state["questionnaire"] = {"category": category, "goal": state["message"],
                                          "questions": questions, "answers": []}
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
        answers = (state.get("questionnaire") or {}).get("answers") or state["memory"].get("shopping_answers", [])
        answer_terms = []
        for row in answers:
            if row.get("id") not in ("use", "scene", "priority", "detail"):
                continue
            value = str(row.get("value", ""))
            answer_terms.extend(term for term in ("书桌", "床头", "阅读", "小户型", "两人", "四人", "通勤", "运动", "户外", "军训", "清爽", "防水", "耐汗", "原木", "简约", "收纳") if term in value)
        prefs = {**prefs, "answer_terms": list(dict.fromkeys(answer_terms))}
        query = " ".join(str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k))
        filters = {"end_price": prefs["maxPrice"]} if prefs.get("maxPrice") is not None else {}
        try:
            planned_queries = []
            has_model = False
            try:
                model = ctx.invocation.component_context.get(MODEL)
                has_model = True
                planned_queries = await search_plan(model, ctx.invocation,
                                                    (state.get("questionnaire") or {}).get("goal") or state["message"],
                                                    prefs, answers)
            except LookupError:
                pass
            queries = list(planned_queries[:2])
            if answer_terms:
                queries.append(" ".join([*answer_terms[:1], query]).strip())
            if query not in queries:
                queries.append(query)
            if prefs.get("style") == "日系" and prefs.get("category"):
                queries.append("日式" + prefs["category"])
            if prefs.get("category"):
                queries.append(prefs["category"])
            state["query"] = queries[0]
            candidates = []
            for attempt, candidate_query in enumerate(dict.fromkeys(queries)):
                payload = await self.search(candidate_query, filters)
                if isinstance(payload, dict) and not payload.get("ok", True):
                    if attempt == 0:
                        error = payload.get("error")
                        state["search_error"] = str(error.get("message") if isinstance(error, dict) else "商品搜索暂时不可用")
                    break
                raw = payload.get("items", []) if isinstance(payload, dict) else payload
                if isinstance(raw, list):
                    candidates.extend(raw)
                state["items"] = select_products(candidates, prefs, limit=12 if has_model else 3,
                                                 allow_style_unknown=has_model)
                if len(state["items"]) >= (6 if has_model else 3):
                    break
            if has_model and state["items"]:
                choice = await product_plan(model, ctx.invocation, prefs, state["items"])
                ids = choice["ids"]
                state["lead"] = choice["lead"]
                by_id = {item["id"]: item for item in state["items"]}
                selected = [by_id[item_id] for item_id in ids]
                # Complete a short model selection only with candidates that pass
                # the stricter evidence checks; never pad it with arbitrary goods.
                for item in select_products(candidates, prefs):
                    if len(selected) >= 3:
                        break
                    if item["id"] not in ids:
                        selected.append(item)
                state["items"] = selected[:3]
        except Exception:
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
            "summary": narrative["summary"] if narrative else "",
            "followUp": narrative["followUp"] if narrative else "",
            "narrativeSource": "ai" if narrative else "none",
            "question": copy.deepcopy(next_question),
            "task": {"category": state["questionnaire"]["category"], "answers": {
                row["id"]: row["value"] for row in state["questionnaire"]["answers"]
            }} if state.get("questionnaire") else None,
            "memory": {"preferences": {**copy.deepcopy(prefs), "memoryTags": [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]}, "turns": state["memory"].get("turns", 0) + 1, "currentRecommendationCount": 0 if action == "forget" and forget_field(state["message"]) == "all" else len(state["items"] or state["memory"].get("current_items", []))},
            "emotion": copy.deepcopy(state["emotion"]), "policy": copy.deepcopy(state["policy"]),
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
        data["preferences"] = copy.deepcopy(state["durable_preferences"])
        data["temporary"] = copy.deepcopy(state["temporary"])
        data["emotion"] = copy.deepcopy(state["emotion"])
        data["turns"] = data.get("turns", 0) + 1
        if state.get("questionnaire"):
            data["questionnaire"] = copy.deepcopy(state["questionnaire"])
            data["shopping_category"] = state["questionnaire"]["category"]
        if not forget_all and ("收藏" in state["message"] or "不喜欢" in state["message"]):
            feedback_type = "saved" if "收藏" in state["message"] else "disliked"
            index = next((i for token, i in (("第一款", 0), ("第二款", 1), ("第三款", 2)) if token in state["message"]), None)
            current_items = data.get("current_items", [])
            item_ids = [current_items[index]["id"]] if index is not None and index < len(current_items) else []
            data["feedback"] = [*data.get("feedback", []), {"type": feedback_type, "itemIds": item_ids}][-20:]
        if state.get("narrative_error"):
            data["pending_result"] = copy.deepcopy(state["pending_result"])
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
