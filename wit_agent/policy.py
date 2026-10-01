"""Deterministic turn understanding and guide policy."""

import re
from dataclasses import asdict, dataclass

STYLES = ("日系", "韩系", "北欧", "法式", "奶油风", "原木", "工业风", "极简", "简约", "复古", "低饱和")
SCENES = ("出租屋", "宿舍", "桌面", "卧室", "客厅", "办公室", "通勤", "旅行", "户外")
CATEGORIES = ("桌面灯", "台灯", "收纳盒", "收纳", "餐桌", "书桌", "椅子", "腮红", "口红", "耳机", "衣服", "包", "香薰", "摆件", "护肤品")


@dataclass(frozen=True)
class EmotionState:
    mood: str
    energy: str
    frustration: float
    purchase_intent: str
    interaction_need: str
    confidence: float


@dataclass(frozen=True)
class GuidePolicy:
    action: str
    question_count: int
    recommendation_count: int
    push_purchase: bool
    tone: str
    reason: str


def extract_updates(text: str) -> dict:
    updates = {}
    for field, words in (("style", STYLES), ("scene", SCENES), ("category", CATEGORIES)):
        found = max((word for word in words if word in text), key=lambda word: text.rfind(word), default=None)
        if found:
            updates[field] = found
    budget = re.search(r"(?:预算|不超过|低于|少于|控制在|最多)\D{0,5}(\d+(?:\.\d+)?)\s*元?", text)
    budget = budget or re.search(r"(\d+(?:\.\d+)?)\s*元\s*(?:以内|以下)", text)
    if budget:
        updates["maxPrice"] = float(budget[1])
    if "category" not in updates:
        match = re.search(r"(?:想找|想买|帮我找|推荐|看看|找)\s*([^，。！？?]{1,24})", text)
        if match:
            candidate = match[1]
            candidate = re.sub(r"\d+(?:\.\d+)?\s*元\s*(?:以内|以下)?|预算|不超过|低于|少于|控制在|最多", "", candidate)
            for word in (*STYLES, *SCENES):
                candidate = candidate.replace(word, "")
            candidate = re.sub(r"^(个|一款|一些|点|的)+|(?:的|商品|东西|有吗)$", "", candidate).strip()
            if candidate and candidate not in ("随便", "什么", "好物") and len(candidate) <= 12:
                updates["category"] = candidate
    return updates


def forget_field(text: str) -> str | None:
    if not re.search(r"忘记|删除.*记忆|清除.*记忆|别记", text):
        return None
    if "预算" in text or "价格" in text:
        return "maxPrice"
    if "风格" in text or any(x in text for x in STYLES):
        return "style"
    if "场景" in text:
        return "scene"
    if "品类" in text or "类目" in text:
        return "category"
    return "all"


def understand(text: str, memory: dict) -> tuple[dict, dict, dict]:
    updates = extract_updates(text)
    preference = dict(memory.get("preferences", {}))
    if "style" in updates and re.search(r"不喜欢|不要|排除", text) and not re.search(r"改成|换成|想要|喜欢", text.split(updates["style"])[-1]):
        negative = re.search(r"(?:不喜欢|不要|排除)\s*([^，。]{0,8})", text)
        if negative and updates["style"] in negative[1]:
            if preference.get("style") == updates["style"]:
                preference.pop("style", None)
            updates.pop("style", None)
    forget = forget_field(text)
    if forget == "all":
        preference.clear()
    elif forget:
        preference.pop(forget, None)
    else:
        preference.update(updates)
    current = bool(memory.get("current_items"))
    stop = bool(re.search(r"不想买|先不买|别推销|不要推销|只想逛|纯逛", text))
    bored = bool(re.search(r"无聊|随便逛|随便看看|找灵感", text))
    frustrated = bool(re.search(r"都不喜欢|不满意|太差|失望|不合适", text))
    compare = current and bool(re.search(r"比较|对比|哪一款|哪款|哪个好|哪个更|这几款|第一款|第二款|第三款", text))
    detail = current and bool(re.search(r"这款|那款|这个商品|第一款|第二款|第三款|刚才那|上一轮|它(?:的|们|是|有|呢)", text))
    cheaper = current and bool(re.search(r"便宜一点|太贵|更便宜|换个价格", text))
    if cheaper and "maxPrice" not in updates:
        prices = [x.get("price") for x in memory.get("current_items", []) if isinstance(x, dict)]
        prices = [p for p in prices if isinstance(p, (int, float)) and p > 1]
        if prices:
            preference["maxPrice"] = min(min(prices) - 1, preference.get("maxPrice", float("inf")))
    memory_question = bool(re.search(r"记得我|我喜欢什么|我的偏好", text))
    if stop:
        mood, need, intent = "stop_selling", "light_exploration", "none"
    elif frustrated:
        mood, need, intent = "frustrated", "change_direction", "uncertain"
    elif bored:
        mood, need, intent = "bored", "light_exploration", "uncertain"
    elif compare:
        mood, need, intent = "compare", "compare_current", "considering"
    elif cheaper:
        mood, need, intent = "budget_sensitive", "refine", "considering"
    elif detail:
        mood, need, intent = "search", "current_detail", "considering"
    elif "maxPrice" in updates or "预算" in text:
        mood, need, intent = "budget_sensitive", "search", "considering"
    elif preference.get("category"):
        mood, need, intent = "search", "search", "considering"
    else:
        mood, need, intent = "explore", "light_exploration", "uncertain"
    state = asdict(EmotionState(mood, "low" if bored or stop else "normal", 0.8 if frustrated else 0.0, intent, need, 0.9 if any((stop, bored, frustrated, compare, cheaper, detail)) else 0.65))
    if forget:
        action = "forget"
    elif memory_question:
        action = "recall"
    elif compare:
        action = "compare_current"
    elif detail and not cheaper:
        action = "current_detail"
    elif stop or bored:
        action = "explore"
    elif frustrated and (updates.get("style") or updates.get("category")):
        action = "search"
    elif frustrated:
        action = "change_direction"
    elif not preference.get("category"):
        action = "clarify"
    else:
        action = "search"
    policy = asdict(GuidePolicy(action, 1 if action in ("clarify", "explore", "change_direction") else 0, 3 if action == "search" else 0, False, "gentle" if stop or bored or frustrated else "clear", need))
    return preference, state, policy
