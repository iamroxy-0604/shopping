"""Shopping workflow hosted by the actual Wit 3.0 Agent Entry."""

import asyncio
import copy
import os
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Awaitable, Callable

import httpx
from wit import WitAgent
from wit.loops.workflow import WorkflowGraph, WorkflowLoopComponent
from wit.models import MODEL
from wit.providers.openai import OpenAIModelComponent

from .llm import interpret, narrative_plan
from .memory import MemoryManager
from .policy import forget_field, temporary_budget, understand, usual_budget

Search = Callable[[str, dict], Awaitable[dict | list]]
CATEGORY_EQUIVALENTS = {"桌面灯": ("桌面灯", "台灯"), "台灯": ("台灯", "桌面灯"), "腮红": ("腮红", "胭脂"), "耳机": ("耳机", "耳麦"), "餐桌": ("餐桌", "饭桌", "餐台")}
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


def select_products(raw_items: list, preferences: dict) -> list:
    budget = preferences.get("maxPrice")
    category = preferences.get("category", "")
    style = preferences.get("style", "")
    material = preferences.get("material", "")
    dislikes = preferences.get("dislikes") or []
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
        seen.add(item["id"])
        seen.add(title_key)
        style_tags = item["semantic"].get("style_tags") or []
        style_match = bool(style and (any(term in title for term in style_aliases) or style in style_tags))
        if category == "餐桌" and style == "日系" and not style_match:
            continue
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
        item["recommendation"] = grounded_reason(item, preferences)
        ranked.append((score, item))
    ranked.sort(key=lambda pair: -pair[0])
    return [item for _, item in ranked[:3]]


def grounded_reason(item: dict, preferences: dict, angle: str | None = None) -> str:
    """Render only evidence from title, semantic tags, price, and explicit facts."""
    title = item["title"]
    style = preferences.get("style")
    material = preferences.get("material")
    category = preferences.get("category")
    budget = preferences.get("maxPrice")
    tags = item.get("semantic", {}).get("style_tags") or []
    style_ok = bool(style and (any(word in title for word in STYLE_EQUIVALENTS.get(style, (style,))) or style in tags))
    material_fact = item.get("facts", {}).get("material") or []
    material_ok = bool(material and (material in title or material in material_fact))
    price_ok = budget is not None and item.get("price") is not None and item["price"] <= budget
    category_ok = bool(category and any(word in title for word in CATEGORY_EQUIVALENTS.get(category, (category,))))
    evidence = {
        "material": material_ok,
        "style": style_ok,
        "price": price_ok,
        "category": category_ok,
        "image": True,
    }
    if not evidence.get(angle, False):
        angle = next(key for key in ("material", "style", "price", "category", "image") if evidence[key])
    if angle == "material":
        origin = "材质字段列有" if material in material_fact else "标题提到"
        reason = f"{origin}“{material}”，对应你提到的材质偏好。"
    elif angle == "style":
        origin = "风格标签" if style in tags else "标题"
        reason = f"{origin}提到“{style}”，和你想看的风格方向一致。"
    elif angle == "category":
        reason = f"标题写着“{category}”，可以先看图片和规格。"
    elif angle == "price":
        reason = ""
    else:
        reason = "可以先看商品图片与详情，确认它是否符合你的需要。"
    if price_ok:
        reason += f"标价 ¥{item['price']:g}，在 ¥{budget:g} 预算内；实际成交价以商品页为准。"
    return reason or "可以先看商品图片与详情，确认它是否符合你的需要。"


def lead_message(lead: str | None, emotion: dict, items: list, preferences: dict) -> str:
    """One state-specific acknowledgement and at most one next-step question."""
    one = len(items) == 1
    category = preferences.get("category")
    style = preferences.get("style")
    direction = "".join(str(part) for part in (style, category) if part) or "这个方向"
    next_item = "想先看这款的哪项信息？" if one else "想先看哪一款的图片或详情？"
    if emotion.get("mood") == "frustrated":
        return f"抱歉，前面没贴近你的想法。这次按你新说的{direction}重新筛过。" + next_item
    if emotion.get("mood") in ("bored", "stop_selling"):
        return "只逛逛也很好，不用急着决定。" + ("想先看这款的图片吗？" if one else "哪款图片让你想多看一眼？")
    if emotion.get("mood") == "budget_sensitive" or lead == "budget":
        budget = preferences.get("maxPrice")
        limit = f"¥{budget:g}" if isinstance(budget, (int, float)) else "你给的预算"
        price_note = "有些商品尚未标价，得进详情再确认。" if any(item.get("price") is None for item in items) else "我优先保留标价在范围内的商品。"
        return f"预算上限是{limit}；看{direction}时，{price_note}" + ("想先核对这款的详情吗？" if one else "想先比较哪两款的价格？")
    if emotion.get("purchase_intent") == "ready":
        return f"你已经明确想买{direction}，先看这轮符合条件的商品。" + next_item
    if lead == "gentle":
        return f"先慢慢看{direction}，不用马上决定。" + ("这款的哪一点最想确认？" if one else "哪款更接近你想要的感觉？")
    return f"先围绕{direction}看已知信息。" + next_item


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
                api="chat.completions", timeout=6.0, max_retries=0,
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

    async def chat(self, session_id: str, message: str, user_id: str | None = None, *, new_conversation: bool = False) -> dict:
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
        async with self._locks[user_id]:
            if new_conversation:
                self.memory.reset_session(session_id, user_id)
            result = await self.agent.invoke({"sessionId": session_id, "userId": user_id, "message": message.strip()})
            return result.output.output

    def _load(self, ctx):
        request = ctx.input
        ctx.state["session_id"] = request["sessionId"]
        ctx.state["user_id"] = request["userId"]
        ctx.state["message"] = request["message"]
        ctx.state["memory"] = self.memory.load(request["sessionId"], request["userId"])

    async def _plan(self, ctx):
        state = ctx.state
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
        except Exception:
            if not state["items"]:
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
            plan = {}
            try:
                model = ctx.invocation.component_context.get(MODEL)
                plan = await narrative_plan(model, ctx.invocation, state["message"], state["emotion"], state["items"])
            except Exception:
                pass
            for item in state["items"]:
                item["recommendation"] = grounded_reason(
                    item, {**prefs, "category": state.get("browse_categories", {}).get(item["id"], prefs.get("category"))}, plan.get("reasons", {}).get(item["id"])
                )
            if state.get("browse"):
                style = prefs.get("style")
                message = f"好，换成{style}的桌面小物。先随便看看，哪件更合你眼缘？" if style else "先摆几样桌面小物给你逛逛，不用急着决定。哪件让你想多看一眼？"
            else:
                message = lead_message(plan.get("lead"), state["emotion"], state["items"], prefs)
            kind = "results"
        state["response"] = {
            "ok": kind != "error", "type": kind, "message": message,
            "items": copy.deepcopy(state["items"]) if kind == "results" else [],
            "memory": {"preferences": {**copy.deepcopy(prefs), "memoryTags": [str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k)]}, "turns": state["memory"].get("turns", 0) + 1, "currentRecommendationCount": 0 if action == "forget" and forget_field(state["message"]) == "all" else len(state["items"] or state["memory"].get("current_items", []))},
            "emotion": copy.deepcopy(state["emotion"]), "policy": copy.deepcopy(state["policy"]),
        }
        if kind == "error":
            state["response"]["error"] = {"code": "SEARCH_ERROR", "message": message}

    def _save(self, ctx):
        state = ctx.state
        data = state["memory"]
        forget_all = state["policy"]["action"] == "forget" and forget_field(state["message"]) == "all"
        if forget_all:
            data["current_items"] = []
            data["last_query"] = ""
            data["feedback"] = []
        data["preferences"] = copy.deepcopy(state["durable_preferences"])
        data["temporary"] = copy.deepcopy(state["temporary"])
        data["emotion"] = copy.deepcopy(state["emotion"])
        data["turns"] = data.get("turns", 0) + 1
        if not forget_all and ("收藏" in state["message"] or "不喜欢" in state["message"]):
            feedback_type = "saved" if "收藏" in state["message"] else "disliked"
            index = next((i for token, i in (("第一款", 0), ("第二款", 1), ("第三款", 2)) if token in state["message"]), None)
            current_items = data.get("current_items", [])
            item_ids = [current_items[index]["id"]] if index is not None and index < len(current_items) else []
            data["feedback"] = [*data.get("feedback", []), {"type": feedback_type, "itemIds": item_ids}][-20:]
        if state["policy"]["action"] == "search" and not state.get("search_error"):
            data["current_items"] = copy.deepcopy(state["items"])
            data["last_query"] = state.get("query", "")
        self.memory.save(
            state["session_id"], data, state["user_id"],
            forget_all=forget_all,
        )
        return state["response"]
