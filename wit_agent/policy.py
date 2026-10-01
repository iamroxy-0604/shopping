"""Deterministic turn understanding and guide policy."""

import re
from dataclasses import asdict, dataclass

PRIMARY_STYLES = ("日系", "韩系", "北欧", "法式", "奶油风", "工业风", "极简", "简约", "复古")
STYLES = (*PRIMARY_STYLES, "原木", "低饱和")
MATERIALS = ("原木", "实木", "竹", "金属", "玻璃", "陶瓷")
SCENES = ("出租屋", "宿舍", "桌面", "卧室", "客厅", "办公室", "通勤", "旅行", "户外")
CATEGORIES = ("桌面灯", "台灯", "收纳盒", "收纳", "餐桌", "书桌", "椅子", "腮红", "口红", "耳机", "衣服", "包", "香薰", "摆件", "护肤品")
REFERENCE = r"第一款|第二款|第三款|上一轮|刚才那|这几款|那几款|这款|那款|这个商品|这盏|那盏|这张|那张|这个|那个|它(?:的|是|有|呢)|左边|右边|前者|后者|便宜的"


def temporary_budget(text: str) -> float | None:
    match = re.search(r"(?:这次|本次|这回|这一回).{0,12}?(?:预算.{0,4}?)?(?:到|可到|可以到|最高|上限|不超过)\s*(\d+(?:\.\d+)?)\s*元", text)
    return float(match[1]) if match else None


def usual_budget(text: str) -> bool:
    return bool(re.search(r"平常预算|平时预算|原来预算|原本预算|按我平常|按我平时", text))


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
        matches = [(text.rfind(word), word) for word in words if word in text]
        if field == "style":
            explicit = [(index, word) for index, word in matches if word in PRIMARY_STYLES]
            allowed = [(index, word) for index, word in explicit if not re.search(r"不喜欢|不要|排除|不是", text[max(0, index - 5):index])]
            matches = allowed or (explicit if not allowed and not matches else matches)
            if allowed:
                matches = allowed
            found = (max(matches) if re.search(r"改成|换成|现在喜欢", text) else min(matches))[1] if matches else None
        else:
            found = max(matches)[1] if matches else None
        if found:
            updates[field] = found
    material = next((word for word in MATERIALS if word in text), None)
    if material:
        updates["material"] = material
    budget = re.search(r"(?:预算|不超过|低于|少于|控制在|最多)\D{0,5}(\d+(?:\.\d+)?)\s*元?", text)
    budget = budget or re.search(r"(\d+(?:\.\d+)?)\s*元\s*(?:以内|以下)", text)
    budget = budget or re.search(r"(?:到|可到|可以到)\s*(\d+(?:\.\d+)?)\s*元", text)
    if budget:
        updates["maxPrice"] = float(budget[1])
    if "category" not in updates:
        match = re.search(r"(?:想找|想买|帮我找|推荐|看看|找)\s*([^，。！？?]{1,24})", text)
        if match:
            candidate = match[1]
            if "东西" in candidate:
                return updates
            candidate = re.sub(r"\d+(?:\.\d+)?\s*元\s*(?:以内|以下)?|预算|不超过|低于|少于|控制在|最多", "", candidate)
            for word in (*STYLES, *SCENES, *MATERIALS):
                candidate = candidate.replace(word, "")
            candidate = re.sub(r"^(个|一款|一些|点|的)+|(?:的|商品|东西|有吗)$", "", candidate).strip()
            if candidate and candidate not in ("随便", "什么", "好物") and "东西" not in candidate and len(candidate) <= 12:
                updates["category"] = candidate
    return updates


def forget_field(text: str) -> str | None:
    if not re.search(r"忘记|忘掉|删除.*记忆|清除.*记忆|别记", text):
        return None
    if re.search(r"所有|全部|清空|偏好都", text):
        return "all"
    if "预算" in text or "价格" in text:
        return "maxPrice"
    if "风格" in text or any(x in text for x in STYLES):
        return "style"
    if "材质" in text:
        return "material"
    if "图片" in text or "先看图" in text:
        return "imageFirst"
    if "场景" in text:
        return "scene"
    if "品类" in text or "类目" in text:
        return "category"
    return "all"


def understand(text: str, memory: dict, model_parse: dict | None = None) -> tuple[dict, dict, dict]:
    updates = extract_updates(text)
    model_parse = model_parse or {}
    updates.update(model_parse.get("query", {}))
    preference = dict(memory.get("preferences", {}))
    if memory.get("current_items") and re.search(REFERENCE, text) and not re.search(r"想找|帮我找|想买|改成|换成|以后喜欢|我喜欢.{0,8}(?:风|材质)", text):
        for key in ("category", "style", "material", "scene"):
            updates.pop(key, None)
    negative_only = bool(re.search(r"不喜欢|不要|排除", text)) and not bool(re.search(r"改成|换成|想找|帮我找|推荐|想买", text))
    if negative_only:
        for key in ("category", "style", "material"):
            updates.pop(key, None)
    dislike = re.search(r"不喜欢\s*([^，。！？]{2,16})", text)
    if dislike:
        phrase = dislike[1].strip("的这那个")
        # A negative description is a preference, not a positive product query.
        if phrase and phrase not in preference.get("dislikes", []):
            preference["dislikes"] = [*preference.get("dislikes", []), phrase][-20:]
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
        preference.update(model_parse.get("memory", {}))
    current = bool(memory.get("current_items"))
    orphan_reference = not current and bool(re.search(REFERENCE, text))
    stop = bool(re.search(r"不想买|不打算买|暂时不买|先不买|今天不买|不买|别推销|不要推销|只想.{0,4}逛|纯逛", text))
    explicit_buy = not stop and bool(re.search(r"想买|准备买|需要买|打算买|下单", text))
    bored = bool(re.search(r"无聊|累了|随便逛|随手逛|随便看看|找灵感|不想做选择|搭配参考", text))
    frustrated = bool(re.search(r"不喜欢|不满意|太差|失望|不合适", text))
    compare = current and bool(re.search(r"比较|对比|哪一款|哪款|哪个好|哪个更|哪个便宜|怎么选|这几款|这两|两个|两盏|第一款.*第二款|左边.*(右边|竹制)", text))
    detail = current and bool(re.search(REFERENCE + r"|现货|库存|价格|标价|多少钱|材质|颜色|尺寸|保温|降价|促销|来源|链接", text))
    cheaper = current and bool(re.search(r"便宜一点|太贵|更便宜|换个价格", text))
    refine = current and bool(re.search(r"换成|改成|换一款|换个风格|重新找", text))
    vague = bool(re.search(r"(?:找|看|推荐).{0,8}(?:东西|随便什么|哪个好物)", text)) and not updates.get("category")
    if cheaper and "maxPrice" not in updates:
        prices = [x.get("price") for x in memory.get("current_items", []) if isinstance(x, dict)]
        prices = [p for p in prices if isinstance(p, (int, float)) and p > 1]
        if prices:
            preference["maxPrice"] = min(min(prices) - 1, preference.get("maxPrice", float("inf")))
    memory_question = bool(re.search(r"记得我|我喜欢什么|我的偏好", text))
    model_intent = model_parse.get("intent")
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
    if explicit_buy and mood in ("search", "budget_sensitive"):
        intent = "ready"
    state = asdict(EmotionState(mood, "low" if bored or stop else "normal", 0.8 if frustrated else 0.0, intent, need, 0.9 if any((stop, bored, frustrated, compare, cheaper, detail)) else 0.65))
    if forget:
        action = "forget"
    elif memory_question:
        action = "recall"
    elif orphan_reference:
        action = "clarify"
    elif stop or bored:
        action = "explore"
    elif frustrated and refine:
        action = "search" if preference.get("category") else "clarify"
    elif frustrated:
        action = "change_direction"
    elif compare:
        action = "compare_current"
    elif current and model_intent == "compare_current":
        action = "compare_current"
    elif refine or cheaper:
        action = "search" if preference.get("category") else "clarify"
    elif detail:
        action = "current_detail"
    elif current and model_intent == "current_detail":
        action = "current_detail"
    elif vague:
        action = "clarify"
    elif not preference.get("category"):
        action = "clarify"
    else:
        action = "search"
    policy = asdict(GuidePolicy(action, 1 if action in ("clarify", "explore", "change_direction", "search") else 0, 3 if action == "search" else 0, False, "gentle" if stop or bored or frustrated else "clear", need))
    return preference, state, policy
