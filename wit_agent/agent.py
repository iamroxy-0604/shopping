"""Shopping workflow hosted by the actual Wit 3.0 Agent Entry."""

import asyncio
import copy
import json
import os
import math
from collections import defaultdict
from pathlib import Path
from typing import Awaitable, Callable

import httpx
from wit import WitAgent
from wit.loops.workflow import WorkflowGraph, WorkflowLoopComponent
from wit.messages import SystemMessage, UserMessage
from wit.models import MODEL, ModelRequest
from wit.providers.openai import OpenAIModelComponent

from .memory import MemoryManager
from .policy import forget_field, understand

Search = Callable[[str, dict], Awaitable[dict | list]]
CATEGORY_EQUIVALENTS = {"桌面灯": ("桌面灯", "台灯"), "台灯": ("台灯", "桌面灯"), "腮红": ("腮红", "胭脂"), "耳机": ("耳机", "耳麦")}
STYLE_EQUIVALENTS = {"日系": ("日系", "日式"), "韩系": ("韩系", "韩式"), "北欧": ("北欧",), "法式": ("法式",)}
STYLE_CONFLICTS = ("日系", "日式", "韩系", "韩式", "北欧", "法式")


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
        "facts": {"title": title, "price": price, "material": facts.get("material"), "color": facts.get("color"), "dimensions": facts.get("dimensions")},
        "semantic": raw.get("semantic") if isinstance(raw.get("semantic"), dict) else {},
    }


def select_products(raw_items: list, preferences: dict) -> list:
    budget = preferences.get("maxPrice")
    category = preferences.get("category", "")
    style = preferences.get("style", "")
    material = preferences.get("material", "")
    seen = set()
    ranked = []
    for raw in raw_items:
        item = normalize_product(raw)
        if not item or item["id"] in seen:
            continue
        title = item["title"]
        title_key = "".join(character for character in title.lower() if character.isalnum())[:32]
        if title_key in seen:
            continue
        if category == "餐桌":
            if any(word in title for word in ("桌布", "桌垫", "桌旗", "桌巾", "桌罩", "餐垫", "台布")):
                continue
            chair_positions = [title.find(word) for word in ("靠背椅", "餐椅", "椅子", "座椅", "扶手椅") if word in title]
            table_positions = [title.find(word) for word in ("餐桌", "饭桌", "桌子", "餐台") if word in title]
            if chair_positions and (not table_positions or min(chair_positions) < min(table_positions)):
                continue
        if budget is not None and item["price"] is not None and item["price"] > budget:
            continue
        category_match = bool(category and any(term in title for term in CATEGORY_EQUIVALENTS.get(category, (category,))))
        if category and not category_match:
            continue
        style_aliases = STYLE_EQUIVALENTS.get(style, (style,)) if style else ()
        style_position = min((title.find(term) for term in style_aliases if term and term in title), default=len(title) + 1)
        conflicting_position = min((title.find(term) for term in STYLE_CONFLICTS if term not in style_aliases and term in title), default=len(title) + 1)
        if style in STYLE_EQUIVALENTS and conflicting_position < style_position:
            continue
        seen.add(item["id"])
        seen.add(title_key)
        style_tags = item["semantic"].get("style_tags") or []
        style_match = bool(style and (any(term in title for term in style_aliases) or style in style_tags))
        material_match = bool(material and (material in title or material in (item["facts"].get("material") or [])))
        score = int(category_match) * 3 + int(style_match) * 3 + int(material_match) * 2 + int(item["price"] is not None)
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
        item["recommendation"] = "，".join(reasons[1:]) + "。" if len(reasons) > 1 else "可以先看图片和商品详情，再判断是否合适。"
        ranked.append((score, item))
    ranked.sort(key=lambda pair: -pair[0])
    return [item for _, item in ranked[:3]]


def compare_message(items: list, message: str) -> str:
    if not items:
        return "目前没有可比较的商品。你想先看哪一类？"
    indexed = [(i + 1, x) for i, x in enumerate(items)]
    if "第一款" in message:
        indexed = indexed[:1]
    elif "第二款" in message:
        indexed = indexed[1:2]
    elif "第三款" in message:
        indexed = indexed[2:3]
    parts = []
    for i, item in indexed:
        price_text = f"，标价 ¥{item['price']:g}" if item.get("price") is not None else "，价格待确认"
        facts = item.get("facts") or {}
        attributes = []
        if "材质" in message and facts.get("material"):
            material = facts["material"]
            attributes.append("材质 " + "、".join(material if isinstance(material, list) else [str(material)]))
        if "颜色" in message and facts.get("color"):
            color = facts["color"]
            attributes.append("颜色 " + "、".join(color if isinstance(color, list) else [str(color)]))
        if "尺寸" in message and facts.get("dimensions"):
            attributes.append("尺寸 " + str(facts["dimensions"]))
        parts.append(f"第{i}款“{item['title']}”{price_text}" + ("，" + "，".join(attributes) if attributes else ""))
    return "根据现有商品信息，" + "；".join(parts) + "。未列出的属性需要以商品详情为准。"


class ShoppingAgent:
    def __init__(self, memory_path: str | Path, search: Search = product_api_search, model=None):
        self.memory = MemoryManager(memory_path)
        self.search = search
        self._locks = defaultdict(asyncio.Lock)
        self.agent = WitAgent()
        if model is None and os.getenv("LLM_MODEL") and (os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")):
            model = OpenAIModelComponent(
                model=os.environ["LLM_MODEL"],
                api_key=os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY"),
                base_url=os.getenv("LLM_BASE_URL", "https://api.openai.com/v1"),
                api="chat.completions", timeout=12.0, max_retries=0,
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

    async def chat(self, session_id: str, message: str) -> dict:
        if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 128:
            raise ValueError("sessionId must be a nonempty string of at most 128 characters")
        if not isinstance(message, str) or len(message) > 4000:
            raise ValueError("message must be a string of at most 4000 characters")
        async with self._locks[session_id]:
            result = await self.agent.invoke({"sessionId": session_id, "message": message.strip()})
            return result.output.output

    def _load(self, ctx):
        request = ctx.input
        ctx.state["session_id"] = request["sessionId"]
        ctx.state["message"] = request["message"]
        ctx.state["memory"] = self.memory.load(request["sessionId"])

    def _plan(self, ctx):
        preference, emotion, policy = understand(ctx.state["message"], ctx.state["memory"])
        ctx.state["preferences"] = preference
        ctx.state["emotion"] = emotion
        ctx.state["policy"] = policy

    async def _retrieve(self, ctx):
        state = ctx.state
        action = state["policy"]["action"]
        state["items"] = []
        if action in ("compare_current", "current_detail"):
            state["current_items"] = copy.deepcopy(state["memory"].get("current_items", []))
            return
        if action != "search":
            return
        prefs = state["preferences"]
        query = " ".join(str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k))
        state["query"] = query
        filters = {"end_price": prefs["maxPrice"]} if prefs.get("maxPrice") is not None else {}
        try:
            queries = [query]
            if prefs.get("style") == "日系" and prefs.get("category"):
                queries.append("日式" + prefs["category"])
            if prefs.get("category"):
                queries.append(prefs["category"])
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
                state["items"] = select_products(candidates, prefs)
                if len(state["items"]) >= 3:
                    break
        except (httpx.HTTPError, OSError, TimeoutError, ValueError):
            state["search_error"] = "商品搜索暂时不可用，请稍后重试"

    async def _reply(self, ctx):
        state = ctx.state
        action = state["policy"]["action"]
        prefs = state["preferences"]
        if action == "forget":
            message, kind = "好的，相关偏好记忆已经删除。", "question"
        elif action == "recall":
            tags = [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]
            if prefs.get("maxPrice") is not None:
                tags.append(f"预算 ¥{prefs['maxPrice']:g} 以内")
            message, kind = ("我记得你提过：" + "、".join(tags) + "。" if tags else "目前还没有记下明确偏好。"), "question"
        elif action in ("compare_current", "current_detail"):
            message, kind = compare_message(state.get("current_items", []), state["message"]), "comparison"
        elif action == "explore":
            message, kind = "可以只逛逛，不急着决定。想从暖光、桌面收纳或小摆件里看哪个方向？", "question"
        elif action == "change_direction":
            message, kind = "明白，这一轮没有贴近你的感觉。换个方向吧：你想试试不同风格，还是换一个品类？", "question"
        elif action == "clarify":
            message, kind = "可以。你想先看哪一类？比如台灯、收纳或耳机。", "question"
        elif state.get("search_error"):
            message, kind = state["search_error"], "error"
        elif not state["items"]:
            message, kind = "这轮没有找到符合条件的商品。可以换个品类或调整预算。", "results"
        else:
            lead = "明白，上一轮不太合适。我按新方向挑了几款。" if state["emotion"]["mood"] == "frustrated" else "我按你说的条件挑了几款，先看看图片和已知信息。"
            if state["emotion"]["mood"] != "frustrated":
                try:
                    model = ctx.invocation.component_context.get(MODEL)
                    options = (lead, "这几款可以先放在一起看看。", "慢慢看，合适再继续聊。")
                    result = await asyncio.wait_for(model.complete(ModelRequest(messages=(
                        SystemMessage("你是耐心、不催单的生活方式导购。只返回数字 0、1 或 2，不要添加其他内容。"),
                        UserMessage(json.dumps({"user": state["message"], "emotion": state["emotion"], "options": options}, ensure_ascii=False)),
                    )), ctx.invocation), timeout=13)
                    choice = result.final_text.strip()
                    if choice in ("0", "1", "2"):
                        lead = options[int(choice)]
                except Exception:
                    pass
            message, kind = lead, "results"
        state["response"] = {
            "ok": kind != "error", "type": kind, "message": message,
            "items": copy.deepcopy(state["items"]) if kind == "results" else [],
            "memory": {"preferences": {**prefs, "memoryTags": [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]}, "turns": state["memory"].get("turns", 0) + 1, "currentRecommendationCount": 0 if action == "forget" and forget_field(state["message"]) == "all" else len(state["items"] or state["memory"].get("current_items", []))},
            "emotion": copy.deepcopy(state["emotion"]), "policy": copy.deepcopy(state["policy"]),
        }
        if kind == "error":
            state["response"]["error"] = {"code": "SEARCH_ERROR", "message": message}

    def _save(self, ctx):
        state = ctx.state
        data = state["memory"]
        if state["policy"]["action"] == "forget" and forget_field(state["message"]) == "all":
            data["current_items"] = []
            data["last_query"] = ""
            data["feedback"] = []
        data["preferences"] = copy.deepcopy(state["preferences"])
        data["emotion"] = copy.deepcopy(state["emotion"])
        data["turns"] = data.get("turns", 0) + 1
        if "收藏" in state["message"] or "不喜欢" in state["message"]:
            feedback_type = "saved" if "收藏" in state["message"] else "disliked"
            index = next((i for token, i in (("第一款", 0), ("第二款", 1), ("第三款", 2)) if token in state["message"]), None)
            current_items = data.get("current_items", [])
            item_ids = [current_items[index]["id"]] if index is not None and index < len(current_items) else []
            data["feedback"] = [*data.get("feedback", []), {"type": feedback_type, "itemIds": item_ids}][-20:]
        if state["policy"]["action"] == "search" and not state.get("search_error"):
            data["current_items"] = copy.deepcopy(state["items"])
            data["last_query"] = state.get("query", "")
        self.memory.save(state["session_id"], data)
        return state["response"]
