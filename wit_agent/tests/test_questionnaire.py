"""The public Wit shopping flow: intake, search, refinement, and category switch."""

import asyncio

from wit_agent.agent import ShoppingAgent, default_questionnaire, grounded_reason, normalize_product


def run(coro):
    return asyncio.run(coro)


def test_every_new_category_gets_questions_before_products(tmp_path):
    async def scenario():
        searches = []

        async def search(query, filters):
            searches.append((query, filters))
            if "耳机" in query:
                return {"ok": True, "items": [
                    {"id": "h1", "title": "通勤降噪耳机", "price": 299},
                    {"id": "h2", "title": "运动蓝牙耳机", "price": 199},
                    {"id": "h3", "title": "日常无线耳机", "price": 159},
                ]}
            return {"ok": True, "items": [
                {"id": "l1", "title": "书桌阅读台灯", "price": 89},
                {"id": "l2", "title": "床头氛围台灯", "price": 119},
                {"id": "l3", "title": "简约护眼台灯", "price": 139},
            ]}

        async with ShoppingAgent(tmp_path / "flow.db", search) as agent:
            first = await agent.chat("conversation", "我想买台灯", user_id="shopper")
            assert first["type"] == "question" and first["question"]["id"] == "use"
            assert searches == []
            second = await agent.chat("conversation", "书桌阅读", user_id="shopper",
                                      answer={"questionId": "use", "value": "书桌阅读"})
            assert second["type"] == "question" and second["question"]["id"] == "scene"
            assert searches == []
            third = await agent.chat("conversation", "普通房间", user_id="shopper",
                                     answer={"questionId": "scene", "value": "普通房间"})
            assert third["type"] == "question" and third["question"]["id"] == "priority"
            fourth = await agent.chat("conversation", "调光方便", user_id="shopper",
                                      answer={"questionId": "priority", "value": "调光方便"})
            assert fourth["type"] == "question" and fourth["question"]["id"] == "budget"
            assert fourth["question"]["step"] == 4 and fourth["question"]["total"] == 4
            result = await agent.chat("conversation", "500 元以内", user_id="shopper",
                                      answer={"questionId": "budget", "value": "500 元以内"})
            assert result["type"] == "results" and len(result["items"]) == 3
            assert "逐款说清入选理由" in result["summary"]
            assert all(item["recommendation"] for item in result["items"])
            assert result["question"] is None
            assert all(filters.get("end_price") == 500 for _, filters in searches)
            assert result["memory"]["preferences"]["category"] == "台灯"
            count = len(searches)
            compared = await agent.chat("conversation", "这三款哪款便宜？", user_id="shopper")
            assert compared["type"] == "comparison" and len(searches) == count
            changed = await agent.chat("conversation", "我想买耳机", user_id="shopper")
            assert changed["type"] == "question" and "耳机" in changed["message"]
            assert len(searches) == count

    run(scenario())


def test_sunscreen_and_vague_browse_use_same_questionnaire(tmp_path):
    async def scenario():
        async def no_search(query, filters):
            raise AssertionError("questionnaire must precede search")

        async with ShoppingAgent(tmp_path / "flow.db", no_search) as agent:
            sunscreen = await agent.chat("sunscreen", "适合军训的防晒霜")
            assert sunscreen["type"] == "question"
            assert "肤质" in sunscreen["question"]["title"]
            assert len(agent.memory.load("sunscreen", None)["questionnaire"]["questions"]) == 4
            assert all("材质" not in q["title"] for q in agent.memory.load("sunscreen", None)["questionnaire"]["questions"])
            browse = await agent.chat("browse", "我只想逛逛，推荐一些桌面好物")
            assert browse["type"] == "question"
            assert browse["question"]["id"] == "category"

    run(scenario())


def test_questionnaire_stays_relevant_and_recommendation_is_grounded():
    sunscreen = default_questionnaire("防晒霜", {})
    table = default_questionnaire("餐桌", {})
    assert len(sunscreen) == len(table) == 4
    assert all("材质" not in row["title"] for row in sunscreen)
    assert "几个人" in table[0]["title"]
    item = normalize_product({"id": "s1", "title": "户外清爽防晒霜", "price": 79})
    reason = grounded_reason(item, {"category": "防晒霜", "maxPrice": 100,
                                    "answer_terms": ["户外", "清爽", "防水"]})
    assert "户外" in reason and "清爽" in reason and "¥79" in reason
    assert "没有可靠的实测依据" in reason
