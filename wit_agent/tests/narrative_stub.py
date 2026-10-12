"""Model-shaped narration fixture for tests unrelated to LLM availability."""

import json

from wit.messages import AssistantMessage
from wit.models import ModelResult


class EvidenceNarrator:
    async def complete(self, request, invocation):
        payload = json.loads(request.messages[-1].text())
        products = payload["products"]
        preferences = payload["preferences"]
        category = preferences.get("category") or "商品"
        goal = payload.get("goal") or ""
        budget = preferences.get("maxPrice")
        if "不喜欢" in goal or "不满意" in goal:
            intro = f"抱歉，刚才没有挑到合心意的{category}，这次换个方向看看？"
        elif budget is not None:
            intro = f"按¥{budget:g}的预算，我找到几款{category}，我们先看看区别？"
        else:
            intro = f"先慢慢看看这几款{category}，你更在意哪一点？"
        result = {
            "intro": intro,
            "summary": f"这几款{category}可以从标题和标价先作初步比较，具体规格需要在商品页核对。",
            "followUp": f"你想先仔细看哪款{category}的详情？",
            "items": [{"id": item["id"],
                       "reason": (f"第{index}款标题是“{item['title']}”，"
                                  + (f"目前标价¥{item['price']:g}，" if item.get("price") is not None else "价格还需核对，")
                                  + "可以先对照你关心的条件，再核对详情。")}
                      for index, item in enumerate(products, 1)],
        }
        return ModelResult(AssistantMessage(json.dumps(result, ensure_ascii=False)))
