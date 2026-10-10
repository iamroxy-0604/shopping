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

from .llm import interpret, narrative_plan, questionnaire_plan
from .memory import MemoryManager
from .policy import extract_updates, forget_field, temporary_budget, understand, usual_budget

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
        seen.add(item["id"])
        seen.add(title_key)
        style_tags = item["semantic"].get("style_tags") or []
        style_match = bool(style and (any(term in title for term in style_aliases) or style in style_tags))
        if category == "餐桌" and style == "日系" and not style_match:
            continue
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
        item["recommendation"] = grounded_reason(item, preferences)
        ranked.append((score, item))
    ranked.sort(key=lambda pair: -pair[0])
    return [item for _, item in ranked[:3]]


def grounded_reason(item: dict, preferences: dict, angle: str | None = None) -> str:
    """Give a natural, grounded product introduction without inventing attributes."""
    title = item["title"]
    category = preferences.get("category")
    budget = preferences.get("maxPrice")
    facts = item.get("facts") or {}
    requested = preferences.get("answer_terms") or []
    reason = product_talking_point(item, preferences)
    style = preferences.get("style")
    if style and style not in reason and any(word in title for word in STYLE_EQUIVALENTS.get(style, (style,))):
        reason += f"整体是你想看的{style}方向。"
    if item.get("price") is not None:
        reason += f"目前标价 ¥{item['price']:g}"
        reason += "，没有超过你的预算。" if budget is not None and item["price"] <= budget else "，最终到手价还得进详情确认。"
    if category in ("防晒霜", "防晒", "护肤", "面霜"):
        if "防水" in requested or "耐汗" in requested:
            reason += ("实际耐汗表现还要看使用说明和评价。"
                       if any(word in title for word in ("防水", "耐汗", "防汗")) else
                       "你在意的防水耐汗还没有可靠的实测依据，买前一定要核实。")
        else:
            reason += "防护标识和成分最好到详情页再核对一下。"
    elif category in ("餐桌", "桌子", "书桌"):
        reason += "桌子的长宽高、腿部空间和实际材质，还是要结合房间尺寸确认。"
    elif category in ("台灯", "灯具"):
        reason += "如果是长时间阅读，再留意照度、照射范围和调光方式。"
    if facts.get("dimensions") and category not in ("餐桌", "桌子", "书桌"):
        reason += "尺寸信息可在商品详情核对，确认是否放得下。"
    return reason


def product_talking_point(item: dict, preferences: dict) -> str:
    """A short shopping-guide impression, not an unverified product claim."""
    title = item["title"]
    category = str(preferences.get("category") or "")
    if any(word in category for word in ("防晒", "护肤", "面霜")):
        if "婴童" in title or "儿童" in title:
            return "这款偏婴童使用，和成人日常或军训防晒不是同一选择；先核对适用年龄与成分。"
        if "喷雾" in title:
            return "这是喷雾款，和普通防晒乳用法不同；先看看面部使用说明、容量与补涂方式。"
        if "次抛" in title or "旅行装" in title:
            return "次抛或旅行装更值得看单次容量与携带方式，出门补涂前也要核对用法。"
        if "户外" in title and "清爽" in title and any(word in title for word in ("防水", "防汗", "耐汗")):
            return "同时强调户外、清爽和防水防汗，方向挺贴近军训；实际肤感仍要看评价。"
        if "户外" in title and "清爽" in title:
            return "偏户外、清爽路线；如果要长时间在外面用，先核对防水耐汗说明。"
        if "SPF50" in title.upper():
            return "商品文案标了 SPF50 系列，更适合先核对完整的 SPF/PA 标识和成分。"
        if "户外" in title and ("防水" in title or "防汗" in title):
            return "偏户外运动方向，文案还提到防水防汗；实际耐汗表现要看说明和评价。"
        if "户外" in title:
            return "主打户外使用，适合先看防护标识、容量和补涂是否方便。"
        if "清爽" in title:
            return "强调清爽肤感，怕黏腻的话可以重点看看成分和使用评价。"
        if "敏感" in title:
            return "面向特定人群的产品，先核对适用年龄、成分及个人耐受情况。"
        if "防水" in title or "防汗" in title:
            return "文案强调防水防汗，适合先看户外使用说明；实际耐汗表现还要看评价。"
        return "先把它当作基础候选，重点看防护标识与真实使用反馈。"
    if any(word in category for word in ("餐桌", "桌子", "书桌")):
        if "折叠" in title or "伸缩" in title:
            return "空间使用更灵活；先看展开尺寸、收起厚度和承重说明。"
        if "原木" in title or "实木" in title:
            return "自然木色比较容易融入日系空间；实木还是木纹饰面要看详情。"
        if "小户型" in title:
            return "偏小空间使用；量好摆放位置和通行距离再决定。"
        return "先看桌面形状、尺寸和腿部空间，判断能否放进你的房间。"
    if any(word in category for word in ("台灯", "灯具")):
        if "调光" in title:
            return "有调光卖点；如果阅读和氛围都要兼顾，可以看看具体档位。"
        if "床头" in title:
            return "偏床头使用；先看亮度和开关位置是否顺手。"
        if "书桌" in title or "阅读" in title:
            return "偏书桌阅读使用；照射范围和调节方式值得重点核对。"
        return "先看摆放方式、光线参数，再判断适不适合你的空间。"
    if preferences.get("style") and any(word in title for word in STYLE_EQUIVALENTS.get(preferences["style"], ())):
        return f"风格方向接近你想要的{preferences['style']}，可以先看图片和实际规格。"
    return "外观和价格可以先作参考，具体使用体验再看看详情与评价。"


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
        price_note = "有的尚未标价，得进详情再确认。" if any(item.get("price") is None for item in items) else "先看它们各自有什么特点。"
        return f"按{limit}左右来挑{direction}，我先留了{'一款' if one else '几款'}给你慢慢看。{price_note}" + next_item
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


def generic_followup(preferences: dict) -> dict | None:
    """Ask one useful, category-aware question without blocking the first result set."""
    category = str(preferences.get("category") or "商品")
    if preferences.get("maxPrice") is None:
        return {"id": "budget", "title": f"这次{category}大概希望控制在什么价位？", "options": ["100 元以内", "100 - 500 元", "500 元以上"], "allowCustom": True}
    if not preferences.get("scene"):
        return {"id": "scene", "title": f"这件{category}主要准备在什么场景使用？", "options": ["日常使用", "通勤 / 工作", "送礼或布置空间"], "allowCustom": True}
    return {"id": "preference", "title": f"挑{category}时，你更在意哪一点？", "options": ["外观风格", "材质和做工", "性价比"], "allowCustom": True}


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


def result_summary(items: list, preferences: dict) -> str:
    if not items:
        return ""
    category = preferences.get("category") or "商品"
    opening = f"这{len(items[:3])}款{category}各有自己的看点，下面我直接说说怎么挑。"
    priced = [(index, item["price"]) for index, item in enumerate(items[:3], 1)
              if item.get("price") is not None]
    if len(priced) >= 2:
        cheapest = min(priced, key=lambda row: row[1])
        if sum(price == cheapest[1] for _, price in priced) == 1:
            opening += f"如果最在意价格，第{cheapest[0]}款目前标价最低（¥{cheapest[1]:g}）。"
    terms = preferences.get("answer_terms") or []
    scene_match = next(((index, term) for index, item in enumerate(items[:3], 1)
                        for term in terms if term in item["title"]), None)
    if scene_match:
        opening += f"如果更在意{scene_match[1]}，第{scene_match[0]}款可以先点开看看细节。"
    return opening


class ShoppingAgent:
    def __init__(self, memory_path: str | Path, search: Search = product_api_search, model=None, *, questionnaire_enabled=True):
        self.memory = MemoryManager(memory_path)
        self.search = search
        self.questionnaire_enabled = questionnaire_enabled
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

    async def _plan(self, ctx):
        state = ctx.state
        pending = copy.deepcopy(state["memory"].get("questionnaire"))
        incoming = extract_updates(state["message"])
        previous_category = state["memory"].get("shopping_category")
        category_changed = bool(incoming.get("category") and previous_category
                                and incoming["category"] != previous_category
                                and (not pending or (not state.get("answer") and re.search(
                                    r"想买|想找|换成|改成|重新找", state["message"]))))
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
            if answer or not re.search(r"想买|想找|换成|改成|重新找", state["message"]):
                value = str((answer or {}).get("value") or state["message"]).strip()[:80]
                if expected["id"] == "category":
                    chosen = extract_updates(value).get("category")
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
                    tailored = default_questionnaire(chosen, state["memory"]["preferences"])
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
                questions = default_questionnaire(category, preference)
                state["questionnaire"] = {"category": category, "questions": questions, "answers": []}
                policy["action"] = "questionnaire"

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
        answers = (state.get("questionnaire") or {}).get("answers") or state["memory"].get("shopping_answers", [])
        answer_terms = []
        for row in answers:
            if row.get("id") not in ("use", "scene", "priority", "detail"):
                continue
            value = str(row.get("value", ""))
            answer_terms.extend(term for term in ("书桌", "床头", "阅读", "小户型", "两人", "四人", "通勤", "运动", "户外", "军训", "清爽", "防水", "耐汗", "原木", "简约", "收纳") if term in value)
        prefs = {**prefs, "answer_terms": list(dict.fromkeys(answer_terms))}
        query = " ".join(str(prefs[k]) for k in ("style", "material", "category", "scene") if prefs.get(k))
        state["query"] = query
        filters = {"end_price": prefs["maxPrice"]} if prefs.get("maxPrice") is not None else {}
        try:
            queries = [" ".join([*answer_terms[:1], query]).strip()] if answer_terms else [query]
            if query not in queries:
                queries.append(query)
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
            plan = {}
            try:
                model = ctx.invocation.component_context.get(MODEL)
                plan = await narrative_plan(model, ctx.invocation, state["message"], state["emotion"], state["items"])
            except Exception:
                pass
            answers = ((state.get("questionnaire") or {}).get("answers") or state["memory"].get("shopping_answers", []))
            desired_terms = list(dict.fromkeys(term for row in answers
                                                for term in ("书桌", "床头", "阅读", "小户型", "通勤", "运动", "户外", "军训", "清爽", "防水", "耐汗", "原木", "简约")
                                                if term in str(row.get("value", ""))))
            for item in state["items"]:
                explicit = [term for term in desired_terms if term in item["title"]]
                if explicit:
                    item["matchReasons"] = [*item.get("matchReasons", []), "标题提到" + "、".join(explicit[:2])]
                item["recommendation"] = grounded_reason(
                    item, {**prefs, "answer_terms": desired_terms, "category": state.get("browse_categories", {}).get(item["id"], prefs.get("category"))}, plan.get("reasons", {}).get(item["id"])
                )
                item["talkingPoint"] = product_talking_point(
                    item, {**prefs, "category": state.get("browse_categories", {}).get(item["id"], prefs.get("category"))}
                )
            if state.get("browse"):
                style = prefs.get("style")
                message = f"好，换成{style}的桌面小物。先随便看看，哪件更合你眼缘？" if style else "先摆几样桌面小物给你逛逛，不用急着决定。哪件让你想多看一眼？"
            else:
                message = lead_message(plan.get("lead"), state["emotion"], state["items"], prefs)
            kind = "results"
        next_question = ({**question, "step": len(state["questionnaire"]["answers"]) + 1,
                          "total": len(state["questionnaire"]["questions"])}
                         if action == "questionnaire" and question else None)
        state["response"] = {
            "ok": kind != "error", "type": kind, "message": message,
            "items": copy.deepcopy(state["items"]) if kind == "results" else [],
            "summary": result_summary(state["items"], {**prefs, "answer_terms": [
                term for row in ((state.get("questionnaire") or {}).get("answers") or state["memory"].get("shopping_answers", []))
                for term in ("书桌", "床头", "阅读", "小户型", "两人", "四人", "通勤", "运动", "油皮", "干皮", "清爽", "原木", "简约")
                if row.get("id") in ("use", "scene", "priority", "detail") and term in str(row.get("value", ""))
            ]}) if kind == "results" and state.get("items") else "",
            "question": copy.deepcopy(next_question),
            "task": {"category": state["questionnaire"]["category"], "answers": {
                row["id"]: row["value"] for row in state["questionnaire"]["answers"]
            }} if state.get("questionnaire") else None,
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
        if "questionnaire" in state:
            data["questionnaire"] = copy.deepcopy(state["questionnaire"])
            data["shopping_category"] = state["questionnaire"]["category"]
        if not forget_all and ("收藏" in state["message"] or "不喜欢" in state["message"]):
            feedback_type = "saved" if "收藏" in state["message"] else "disliked"
            index = next((i for token, i in (("第一款", 0), ("第二款", 1), ("第三款", 2)) if token in state["message"]), None)
            current_items = data.get("current_items", [])
            item_ids = [current_items[index]["id"]] if index is not None and index < len(current_items) else []
            data["feedback"] = [*data.get("feedback", []), {"type": feedback_type, "itemIds": item_ids}][-20:]
        if state["policy"]["action"] == "search" and not state.get("search_error"):
            data["current_items"] = copy.deepcopy(state["items"])
            data["last_query"] = state.get("query", "")
            if state.get("questionnaire"):
                data["shopping_answers"] = copy.deepcopy(state["questionnaire"]["answers"])
            data["questionnaire"] = None
            data["shopping_category"] = state["preferences"].get("category", "")
        self.memory.save(
            state["session_id"], data, state["user_id"],
            forget_all=forget_all,
        )
        return state["response"]
