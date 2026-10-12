"""The public Wit shopping flow: intake, search, refinement, and category switch."""

import asyncio
import json

from wit.messages import AssistantMessage
from wit.models import BaseModelComponent, ModelEvent, ModelResult

from wit_agent.agent import ShoppingAgent, default_questionnaire, grounded_reason, normalize_product, product_talking_point


def run(coro):
    return asyncio.run(coro)


class SequenceModel(BaseModelComponent):
    def __init__(self, outputs):
        super().__init__()
        self.outputs = iter(outputs)

    async def _stream(self, request, invocation):
        yield ModelEvent.final(ModelResult(AssistantMessage(json.dumps(next(self.outputs), ensure_ascii=False))))


def test_ai_questionnaire_search_terms_and_product_order(tmp_path):
    async def scenario():
        model = SequenceModel([
            {},
            {"questions": [
                {"title": "平时几个人一起吃饭？", "options": ["两人", "四人", "更多人"]},
                {"title": "餐桌准备摆在怎样的空间？", "options": ["小餐厅", "开放式厨房", "客厅一角"]},
                {"title": "这次更在意什么？", "options": ["方便打理", "原木氛围", "方便收纳"]},
            ]},
            {"queries": ["日式原木餐桌 小户型", "日系餐桌"]},
            {"ids": ["t2", "t1", "t3"], "lead": "gentle"},
        ])
        searches = []

        async def search(query, filters):
            searches.append(query)
            if query == "日式原木餐桌 小户型":
                return {"ok": True, "items": [
                    {"id": "t1", "title": "日式原木餐桌", "price": 899},
                    {"id": "t2", "title": "日系小户型餐桌", "price": 1199},
                    {"id": "cloth", "title": "日式餐桌布", "price": 39},
                ]}
            return {"ok": True, "items": [{"id": "t3", "title": "日式实木餐台", "price": 1599}]}

        async with ShoppingAgent(tmp_path / "ai.db", search, model) as agent:
            result = await agent.chat("session", "我想买日系餐桌", user_id="shopper")
            assert result["question"]["title"] == "平时几个人一起吃饭？"
            assert searches == []
            for question_id, value in (("use", "两人"), ("scene", "小餐厅"),
                                       ("priority", "原木氛围")):
                result = await agent.chat("session", value, user_id="shopper",
                                          answer={"questionId": question_id, "value": value})
                assert result["type"] == "question"
            result = await agent.chat("session", "3000元以内", user_id="shopper",
                                      answer={"questionId": "budget", "value": "3000元以内"})
            assert searches[0] == "日式原木餐桌 小户型"
            assert [item["id"] for item in result["items"]] == ["t2", "t1", "t3"]
            assert all(item["price"] <= 3000 for item in result["items"])
            assert result["question"] is None

    run(scenario())


def test_ai_can_ask_for_an_unlisted_product_category(tmp_path):
    async def scenario():
        model = SequenceModel([
            {},
            {"title": "想先逛哪种桌面小物？", "options": ["台灯", "收纳盒", "花瓶"]},
            {"questions": [
                {"title": "花瓶准备放在哪里？", "options": ["书桌", "餐桌", "玄关"]},
                {"title": "通常会插什么花？", "options": ["鲜花", "干花", "暂不确定"]},
                {"title": "更喜欢哪种摆放感？", "options": ["小巧", "有存在感", "都可以"]},
            ]},
        ])

        async def no_search(query, filters):
            raise AssertionError("search must wait for questionnaire")

        async with ShoppingAgent(tmp_path / "category.db", no_search, model) as agent:
            first = await agent.chat("s", "我只想逛逛，推荐一些桌面好物", user_id="u")
            assert first["question"]["options"] == ["台灯", "收纳盒", "花瓶"]
            second = await agent.chat("s", "花瓶", user_id="u",
                                      answer={"questionId": "category", "value": "花瓶"})
            assert second["question"]["title"] == "花瓶准备放在哪里？"
            assert second["task"]["category"] == "花瓶"

    run(scenario())


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
            assert "怎么挑" in result["summary"]
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
    point = product_talking_point(item, {"category": "防晒霜"})
    assert "户外" in point and "清爽" in point
    assert "商品标题写的是" not in point
    spray = normalize_product({"id": "s2", "title": "户外防晒喷雾", "price": 69})
    high_spf = normalize_product({"id": "s3", "title": "户外防晒霜 SPF50+", "price": 59})
    points = [product_talking_point(row, {"category": "防晒霜"}) for row in (item, spray, high_spf)]
    assert len(set(points)) == 3
    historical = [
        "【U先试用】梦丽多日婴童纯物理防晒霜运动专用高倍防晒旅行装3片",
        "蕉下物理防晒霜运动海边防水高倍防紫外线户外旅行次抛防晒乳液",
        "骆驼防晒霜三角形户外专业运动防水防汗防紫外线高倍防黑旅行30g",
    ]
    historical_points = [product_talking_point(normalize_product({"id": str(i), "title": title}),
                                              {"category": "防晒霜"}) for i, title in enumerate(historical)]
    assert len(set(historical_points)) == 3
    assert "婴童" in historical_points[0]
    assert "次抛" in historical_points[1]
    assert "防水防汗" in historical_points[2]
