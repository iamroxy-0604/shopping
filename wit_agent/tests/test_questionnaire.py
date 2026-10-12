"""The public Wit shopping flow: intake, search, refinement, and category switch."""

import asyncio
import json

from wit.messages import AssistantMessage
from wit.models import BaseModelComponent, ModelEvent, ModelResult

from wit_agent.agent import ShoppingAgent, default_questionnaire, normalize_product
from wit_agent.llm import NarrativeGenerationError, recommendation_plan
from wit_agent.tests.narrative_stub import EvidenceNarrator
from wit_agent.policy import extract_updates


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
            {"intro": "想找有日系氛围的餐桌，我挑了三张不同价位的给你慢慢看。",
             "summary": "第一张偏小户型，第二张强调原木氛围，第三张是实木餐台方向；实际尺寸要看详情。",
             "followUp": "你更在意桌面大小，还是木色的感觉？",
             "items": [
                 {"id": "t2", "reason": "标题写着小户型，想留出更多活动空间的话可以先看看尺寸。"},
                 {"id": "t1", "reason": "原木方向很贴近你说的氛围，建议对照家里的地板颜色。"},
                 {"id": "t3", "reason": "这张餐台的标价更高，可以先比较它和前两张的尺寸与材质说明。"},
             ]},
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
            assert result["narrativeSource"] == "ai"
            assert "日系氛围" in result["message"]
            assert "小户型" in result["items"][0]["talkingPoint"]
            assert result["followUp"].startswith("你更在意")
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

        async with ShoppingAgent(tmp_path / "flow.db", search, narrator=EvidenceNarrator()) as agent:
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
            assert "商品页核对" in result["summary"]
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


def test_questionnaire_stays_relevant_and_normalization_preserves_facts():
    sunscreen = default_questionnaire("防晒霜", {})
    table = default_questionnaire("餐桌", {})
    assert len(sunscreen) == len(table) == 4
    assert all("材质" not in row["title"] for row in sunscreen)
    assert "几个人" in table[0]["title"]
    item = normalize_product({"id": "s1", "title": "户外清爽防晒霜", "price": 79})
    assert item["facts"]["title"] == "户外清爽防晒霜"
    assert item["price"] == 79
    assert "recommendation" not in item


def test_product_category_drops_chinese_classifier():
    assert extract_updates("我想买一条日系裤子，预算300元以内")["category"] == "裤子"


def test_narration_failure_has_no_template_and_retry_reuses_products(tmp_path):
    async def scenario():
        searches = []

        async def search(query, filters):
            searches.append(query)
            return {"ok": True, "items": [
                {"id": "pants-a", "title": "日系休闲裤子", "price": 128},
                {"id": "pants-b", "title": "日系宽松裤子", "price": 89},
            ]}

        async with ShoppingAgent(tmp_path / "retry.db", search, questionnaire_enabled=False) as agent:
            failed = await agent.chat("s", "我想买一条日系裤子，预算300元以内")
            assert failed["type"] == "error" and failed["error"]["code"] == "NARRATIVE_UNAVAILABLE"
            assert failed["items"] == [] and failed["summary"] == ""
            assert "各有自己的看点" not in failed["message"]
            stored = agent.memory.load("s")
            assert stored["preferences"]["category"] == "裤子"
            assert stored["current_items"] == []
            assert len(stored["pending_result"]["items"]) == 2
            search_count = len(searches)
            agent.narrator = EvidenceNarrator()
            recovered = await agent.chat("s", "重试生成推荐")
            assert recovered["type"] == "results" and recovered["narrativeSource"] == "ai"
            assert {item["id"] for item in recovered["items"]} == {"pants-a", "pants-b"}
            assert all(item["recommendation"] for item in recovered["items"])
            assert len(searches) == search_count
            assert agent.memory.load("s")["pending_result"] is None

    run(scenario())


def test_narration_retries_incomplete_model_output_and_rejects_hallucinated_specs():
    class FlakyNarrator(EvidenceNarrator):
        def __init__(self):
            self.calls = 0

        async def complete(self, request, invocation):
            self.calls += 1
            if self.calls == 1:
                return ModelResult(AssistantMessage('{"intro":"不完整"}'))
            return await super().complete(request, invocation)

    class UnsupportedNarrator(EvidenceNarrator):
        async def complete(self, request, invocation):
            result = json.loads((await super().complete(request, invocation)).final_text)
            result["items"][0]["reason"] = "这款防晒霜经实测具有SPF50防护效果，适合敏感肌使用。"
            return ModelResult(AssistantMessage(json.dumps(result, ensure_ascii=False)))

    async def scenario():
        item = normalize_product({"id": "s1", "title": "户外防晒霜", "price": 79})
        flaky = FlakyNarrator()
        result = await recommendation_plan(flaky, None, "找防晒霜", {"category": "防晒霜"}, [], [item])
        assert flaky.calls == 2 and result["items"]["s1"]
        try:
            await recommendation_plan(UnsupportedNarrator(), None, "找防晒霜", {"category": "防晒霜"}, [], [item])
        except NarrativeGenerationError as exc:
            assert str(exc) == "invalid_product_reasons"
        else:
            raise AssertionError("unsupported product claims must not be shown")

    run(scenario())
