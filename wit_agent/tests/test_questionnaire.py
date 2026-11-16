"""The public Wit shopping flow: intake, search, refinement, and category switch."""

import asyncio
import json
from types import SimpleNamespace

from wit.messages import AssistantMessage
from wit.models import MODEL, BaseModelComponent, ModelEvent, ModelResult

import wit_agent.agent as agent_module
from wit_agent.agent import (ShoppingAgent, default_questionnaire, normalize_product,
                             product_source_name)
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


def test_questionnaire_log_contains_only_session_source_and_content(tmp_path):
    questions = default_questionnaire("卤味", {})
    agent = ShoppingAgent(tmp_path / "memory.sqlite3")

    agent._log_questionnaire("session-123", "fallback", questions)

    log_path = tmp_path / "questionnaire.events.jsonl"
    record = json.loads(log_path.read_text(encoding="utf-8").strip())
    assert record == {
        "sessionId": "session-123",
        "source": "fallback",
        "questions": questions,
    }


def test_questionnaire_generation_logs_llm_or_fallback_source(tmp_path, monkeypatch):
    agent = ShoppingAgent(tmp_path / "memory.sqlite3")
    generated = default_questionnaire("snack", {})[:3]
    ctx = SimpleNamespace(
        state={"session_id": "llm-session"},
        invocation=SimpleNamespace(component_context={MODEL: object()}),
    )

    async def llm_plan(*_args):
        return generated

    monkeypatch.setattr(agent_module, "questionnaire_plan", llm_plan)
    run(agent._questions_for_goal(ctx, "snack", {}, "find snacks"))

    ctx.state["session_id"] = "fallback-session"

    async def fallback_plan(*_args):
        return []

    monkeypatch.setattr(agent_module, "questionnaire_plan", fallback_plan)
    run(agent._questions_for_goal(ctx, "snack", {}, "find snacks"))

    records = [
        json.loads(line)
        for line in (tmp_path / "questionnaire.events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert [record["source"] for record in records] == ["llm", "fallback"]
    assert [record["sessionId"] for record in records] == ["llm-session", "fallback-session"]
    assert all(set(record) == {"sessionId", "source", "questions"} for record in records)


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
             "emphasis": ["第一张偏小户型", "原木氛围"],
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
            assert result["emphasis"] == ["第一张偏小户型", "原木氛围"]
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


def test_yuemai_keeps_one_initial_match_while_taobao_follows_refinements(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            source = filters.get("_source")
            calls.append((source, query, dict(filters)))
            if source == "yuemai":
                return {"ok": True, "source": "yuemai", "items": [
                    {"id": "yuemai:y1", "title": "小胡鸭辣味卤味礼盒", "price": 60.9,
                     "source": "yuemai"},
                ]}
            return {"ok": True, "source": "taobao", "items": [
                {"id": "taobao:t1", "title": "五香牛肉卤味", "price": 29.9,
                 "source": "taobao"},
                {"id": "taobao:t2", "title": "原味豆干卤味", "price": 16.9,
                 "source": "taobao"},
                {"id": "taobao:t3", "title": "麻辣鸭脖卤味", "price": 19.9,
                 "source": "taobao"},
            ]}
        search.supports_product_sources = True

        async with ShoppingAgent(tmp_path / "source-mix.db", search,
                                 questionnaire_enabled=False,
                                 narrator=EvidenceNarrator()) as agent:
            first = await agent.chat("mix", "我想买卤味")
            assert [product_source_name(item) for item in first["items"]] == [
                "yuemai", "taobao", "taobao",
            ]
            assert first["items"][0]["selectionScope"] == "initial_request"

            refined = await agent.chat("mix", "我不喜欢辣的，重新找")
            assert [product_source_name(item) for item in refined["items"]] == [
                "yuemai", "taobao", "taobao",
            ]
            assert refined["items"][0]["id"] == "yuemai:y1"
            assert all("辣" not in item["title"] for item in refined["items"][1:])
            assert len([call for call in calls if call[0] == "yuemai"]) == 1

    run(scenario())


def test_questionnaire_budget_only_filters_taobao_not_initial_yuemai_match(tmp_path):
    async def scenario():
        calls = []

        async def search(query, filters):
            source = filters.get("_source")
            calls.append((source, query, dict(filters)))
            if source == "yuemai":
                return {"ok": True, "source": "yuemai", "items": [
                    {"id": "yuemai:y1", "title": "小胡鸭卤味零食礼盒", "price": 60.9,
                     "source": "yuemai"},
                ]}
            return {"ok": True, "source": "taobao", "items": [
                {"id": "taobao:t1", "title": "牛肉卤味礼盒", "price": 29.9,
                 "source": "taobao"},
                {"id": "taobao:t2", "title": "原味豆干卤味", "price": 16.9,
                 "source": "taobao"},
                {"id": "taobao:t3", "title": "海带片卤味", "price": 15.9,
                 "source": "taobao"},
            ]}
        search.supports_product_sources = True

        async with ShoppingAgent(tmp_path / "questionnaire-source-mix.db", search,
                                 narrator=EvidenceNarrator()) as agent:
            result = await agent.chat("mix", "我想买卤味")
            for question_id, value in (
                ("use", "自己吃"),
                ("scene", "追剧"),
                ("priority", "口味"),
            ):
                result = await agent.chat(
                    "mix", value,
                    answer={"questionId": question_id, "value": value},
                )
            result = await agent.chat(
                "mix", "20元以内",
                answer={"questionId": "budget", "value": "20元以内"},
            )

            assert [product_source_name(item) for item in result["items"]] == [
                "yuemai", "taobao", "taobao",
            ]
            assert result["items"][0]["price"] == 60.9
            assert all(item["price"] <= 20 for item in result["items"][1:])
            yuemai_call = next(call for call in calls if call[0] == "yuemai")
            assert "end_price" not in yuemai_call[2]
            assert all(call[2].get("end_price") == 20
                       for call in calls if call[0] == "taobao")

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


def test_yuemai_normalization_preserves_source_description_media_and_order_metadata():
    item = normalize_product({
        "id": "yuemai:1001", "title": "悦买零食礼盒", "price": 75,
        "imageUrl": "https://img.example/cover.jpg", "source": "yuemai",
        "description": "多种卤味组合",
        "media": {"images": [{"url": "https://img.example/cover.jpg", "role": "cover"},
                              {"url": "https://img.example/detail.jpg", "role": "detail"}]},
        "facts": {"title": "悦买零食礼盒", "price": 75, "brand": "示例品牌",
                  "sellingPoint": "多种卤味组合", "category": "休闲食品", "goodsId": "1001"},
        "providerData": {"goodsId": "1001", "skus": [{"skuId": "2001", "stock": 8}]},
    })
    assert item["imageUrl"] == "https://img.example/cover.jpg"
    assert item["description"] == "多种卤味组合"
    assert item["facts"]["sellingPoint"] == "多种卤味组合"
    assert item["facts"]["category"] == "休闲食品"
    assert len(item["media"]["images"]) == 2
    assert item["providerData"]["goodsId"] == "1001"


def test_product_category_drops_chinese_classifier():
    assert extract_updates("我想买一条日系裤子，预算300元以内")["category"] == "裤子"
    assert extract_updates("我要买一件裙子")["category"] == "裙子"
    assert extract_updates("想买一条裙子")["category"] == "裙子"
    assert extract_updates("换成裙子")["category"] == "裙子"
    assert extract_updates("我想买一把雨伞")["category"] == "雨伞"
    assert "category" not in extract_updates("我想买点东西")


def test_new_session_and_explicit_category_switch_reset_shopping_task(tmp_path):
    async def scenario():
        async def no_search(query, filters):
            raise AssertionError("questionnaire must precede search")

        async with ShoppingAgent(tmp_path / "sessions.db", no_search) as agent:
            umbrella = await agent.chat("old", "我想买一把雨伞，预算100元以内", user_id="same")
            assert umbrella["task"]["category"] == "雨伞"
            dress = await agent.chat("new", "我要买一件裙子", user_id="same")
            assert dress["type"] == "question"
            assert dress["task"]["category"] == "裙子"
            assert "雨伞" not in dress["message"] + dress["question"]["title"]
            assert agent.memory.load("new", "same")["preferences"].get("maxPrice") is None
            assert agent.memory.load("new", "same")["current_items"] == []
            changed = await agent.chat("old", "换成裙子", user_id="same")
            assert changed["type"] == "question"
            assert changed["task"]["category"] == "裙子"
            assert "雨伞" not in changed["message"] + changed["question"]["title"]
            assert agent.memory.load("old", "same")["preferences"].get("maxPrice") is None
            unknown = await agent.chat("unknown", "我想买点东西", user_id="same")
            assert unknown["task"]["category"] == ""
            assert unknown["question"]["id"] == "category"

    run(scenario())


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
            assert len(failed["candidateItems"]) == 2
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


def test_narration_does_not_repeat_timed_out_gateway_request():
    class TimedOutNarrator(EvidenceNarrator):
        def __init__(self):
            self.calls = 0

        async def complete(self, request, invocation):
            self.calls += 1
            raise asyncio.TimeoutError()

    async def scenario():
        item = normalize_product({"id": "s1", "title": "户外防晒霜", "price": 79})
        narrator = TimedOutNarrator()
        try:
            await recommendation_plan(narrator, None, "找防晒霜", {"category": "防晒霜"}, [], [item])
        except NarrativeGenerationError as exc:
            assert str(exc) == "model_timeout"
        else:
            raise AssertionError("timed out model request must fail")
        assert narrator.calls == 1

    run(scenario())


def test_narration_keeps_valid_model_fields_when_repairing_a_rejected_summary():
    class PartialNarrator:
        def __init__(self):
            self.calls = 0

        async def complete(self, request, invocation):
            self.calls += 1
            if self.calls == 1:
                result = {"intro": "我先按你的预算整理这款商品，看看它有哪些可核对的信息。",
                          "summary": "这款商品具有SPF99防护效果，可以直接作为选购结论。",
                          "followUp": "你还想确认商品的哪项具体信息？",
                          "items": [{"id": "s1", "reason": "商品标题写明是户外防晒霜，价格已列出；具体效果仍需查看原商品页。"}]}
                return ModelResult(AssistantMessage(json.dumps(result, ensure_ascii=False)))
            if self.calls == 2:
                return ModelResult(AssistantMessage("not json"))
            return ModelResult(AssistantMessage(json.dumps({
                "summary": "目前能确认的是商品标题和标价，具体防护表现没有独立依据，需要到原页面核实。"
            }, ensure_ascii=False)))

    async def scenario():
        item = normalize_product({"id": "s1", "title": "户外防晒霜", "price": 79})
        narrator = PartialNarrator()
        result = await recommendation_plan(narrator, None, "找防晒霜", {"category": "防晒霜"}, [], [item])
        assert narrator.calls == 3
        assert "SPF99" not in result["summary"]
        assert result["intro"] and result["followUp"] and result["items"]["s1"]

    run(scenario())
