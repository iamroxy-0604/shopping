"""A browse request should display products without turning into a purchase push."""

import asyncio

from wit_agent.agent import ShoppingAgent
from wit_agent.llm import validate_interpretation
from wit_agent.policy import extract_updates


def test_generic_desktop_goods_is_not_a_product_category():
    text = "我只想逛逛，推荐一些桌面好物给我看看"
    assert extract_updates(text) == {"scene": "桌面"}
    parsed = validate_interpretation({"query": {"category": "桌面好物"}}, text, False)
    assert "category" not in parsed["query"]
    followup = validate_interpretation({"query": {"category": "日系的", "style": "日系"}}, "我就想要点日系的", True)
    assert followup["query"] == {"style": "日系"}


def test_browse_then_refine_japanese_style_returns_three_categories(tmp_path):
    calls = []

    async def search(query, filters):
        calls.append(query)
        category = next(word for word in ("台灯", "收纳盒", "摆件") if word in query)
        styled = "日系" in query
        title = f"{'日系' if styled else '简约'}桌面{category}"
        noisy = {"台灯": "户外酒吧桌面台灯", "收纳盒": "内衣桌面收纳盒", "摆件": "动漫周边桌面摆件"}[category]
        return {"ok": True, "items": [
            {"id": f"{category}-noise", "title": f"{'日系' if styled else '简约'}{noisy}", "price": 20},
            {"id": f"{category}-{'styled' if styled else 'plain'}", "title": title, "price": 68},
            {"id": f"{category}-irrelevant", "title": "北欧餐桌布", "price": 20},
        ]}

    async def scenario():
        async with ShoppingAgent(tmp_path / "browse.db", search) as agent:
            first = await agent.chat("s", "我只想逛逛，推荐一些桌面好物给我看看", user_id="u")
            assert first["type"] == "results"
            assert len(first["items"]) == 3
            assert all("noise" not in item["id"] for item in first["items"])
            assert first["emotion"]["purchase_intent"] == "none"
            assert first["policy"]["push_purchase"] is False
            assert first["memory"]["preferences"].get("category") is None
            assert "购买" not in first["message"]
            second = await agent.chat("s", "我就想要点日系的", user_id="u")
            assert second["type"] == "results"
            assert len(second["items"]) == 3
            assert all("noise" not in item["id"] for item in second["items"])
            assert all("日系" in item["title"] for item in second["items"])
            assert second["memory"]["preferences"]["style"] == "日系"
            assert agent.memory.load("s", "u")["last_query"] == "browse:桌面"
            assert len(calls) == 6
            casual = await agent.chat("casual", "今天有点无聊，随便看看桌面好物。", user_id="visitor")
            assert casual["type"] == "results" and casual["items"]
            assert casual["policy"]["push_purchase"] is False
            followup = await agent.chat("casual", "先看能让桌面舒服一点的。", user_id="visitor")
            assert followup["type"] == "results" and followup["items"]
            agent.memory.save("legacy", {
                "preferences": {"scene": "桌面", "category": "好物给我看看"},
                "last_query": "好物给我看看", "current_items": [],
            }, "existing-user")
            recovered = await agent.chat("legacy", "我就想要点日系的", user_id="existing-user")
            assert recovered["type"] == "results" and len(recovered["items"]) == 3
            assert recovered["memory"]["preferences"].get("category") is None
            assert agent.memory.load("legacy", "existing-user")["preferences"].get("category") is None

    asyncio.run(scenario())
