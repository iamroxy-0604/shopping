import asyncio
import functools
import json
import sqlite3

import pytest
from wit.messages import AssistantMessage
from wit.models import BaseModelComponent, ModelEvent, ModelResult

from wit_agent.agent import ShoppingAgent
from wit_agent.server import handle


def run_async(function):
    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))
    return wrapper


class MockModel(BaseModelComponent):
    def __init__(self, output="1"):
        super().__init__()
        self.output = output
        self.calls = 0
        self.requests = []

    async def _stream(self, request, invocation):
        self.calls += 1
        self.requests.append(request)
        output = self.output.pop(0) if isinstance(self.output, list) and self.output else self.output
        yield ModelEvent.final(ModelResult(AssistantMessage(output)))


@pytest.fixture
def catalog():
    calls = []

    async def search(query, filters):
        calls.append((query, filters))
        return {"ok": True, "items": [
            {"id": "1", "title": "日系台灯", "price": 89, "imageUrl": "https://example.test/1.jpg", "source": "sample"},
            {"id": "2", "title": "台灯", "price": 120, "source": "sample"},
            {"id": "3", "title": "日系收纳盒", "price": None, "source": "sample"},
            {"id": "4", "title": "台灯", "price": 50, "source": "sample"},
        ]}
    return search, calls


@run_async
async def test_search_compare_memory_and_reopen(tmp_path, catalog):
    search, calls = catalog
    path = tmp_path / "memory.sqlite3"
    model = MockModel("1")
    async with ShoppingAgent(path, search, model) as agent:
        result = await agent.chat("s1", "想找100元以内的日系台灯")
        assert result["ok"] and result["type"] == "results"
        assert len(result["items"]) <= 3
        assert all("台灯" in item["title"] for item in result["items"])
        assert result["items"][0]["price"] == 89
        assert all(x["price"] is None or x["price"] <= 100 for x in result["items"])
        assert "日系" in result["items"][0]["recommendation"]
        assert "¥89" in result["items"][0]["recommendation"]
        assert calls[0][1] == {"end_price": 100.0}
        assert model.calls == 2  # One interpretation and one constrained wording plan.
        first_search_count = len(calls)
        compared = await agent.chat("s1", "第一款和第二款哪个好？")
        assert compared["type"] == "comparison" and compared["items"] == []
        assert "日系台灯" in compared["message"]
        assert len(calls) == first_search_count
        redirected = await agent.chat("s1", "这些都不喜欢，改成工业风台灯")
        assert redirected["emotion"]["mood"] == "frustrated"
        assert redirected["policy"]["action"] == "search"
        if redirected["items"]:
            assert redirected["message"].startswith("抱歉")
        else:
            assert redirected["type"] == "results"
        assert redirected["memory"]["preferences"]["style"] == "工业风"
        other = await agent.chat("s2", "我今天无聊，只想逛逛，不想买")
        assert other["emotion"]["mood"] == "stop_selling"
        assert other["policy"]["push_purchase"] is False
        assert len(calls) > first_search_count
    async with ShoppingAgent(path, search) as agent:
        recalled = await agent.chat("s1", "你还记得我喜欢什么风格吗？")
        assert "工业风" in recalled["message"]
        assert recalled["memory"]["preferences"]["maxPrice"] == 100
        revised = await agent.chat("s1", "我现在喜欢工业风台灯，预算200元以内")
        assert revised["memory"]["preferences"]["style"] == "工业风"
        assert revised["memory"]["preferences"]["maxPrice"] == 200
        forgotten = await agent.chat("s1", "忘记我的风格")
        assert "style" not in forgotten["memory"]["preferences"]
        all_forgotten = await agent.chat("s1", "忘记所有记忆")
        assert all_forgotten["memory"]["preferences"] == {"memoryTags": []}
        assert agent.memory.load("s1")["current_items"] == []


@run_async
async def test_mock_model_cannot_inject_facts_and_search_failure_falls_back(tmp_path, catalog):
    search, calls = catalog
    async with ShoppingAgent(tmp_path / "m.db", search, MockModel("限时免费，立即购买")) as agent:
        result = await agent.chat("s", "找台灯")
        assert "免费" not in result["message"]
        assert "购买" not in result["message"]
    async def broken(query, filters):
        raise OSError("offline")
    async with ShoppingAgent(tmp_path / "m2.db", broken) as agent:
        result = await agent.chat("s", "找台灯")
        assert not result["ok"] and result["type"] == "error"
        assert result["error"]["code"] == "SEARCH_ERROR"
    async with ShoppingAgent(tmp_path / "m3.db", search) as agent:
        first = await agent.chat("s", "找台灯")
        count = len(calls)
        second = await agent.chat("s", "它的材质是什么？")
        assert second["type"] == "comparison"
        assert "材质未知" in second["message"]
        efficacy = await agent.chat("s", "这款真的护眼吗？")
        assert efficacy["type"] == "comparison"
        assert "无法判断" in efficacy["message"]
        assert len(calls) == count


@run_async
async def test_http_contract(tmp_path, catalog):
    search, _ = catalog
    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        server = await asyncio.start_server(lambda r, w: handle(r, w, agent), "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            body = '{"userId":"visitor","sessionId":"web","message":"找台灯"}'.encode()
            writer.write(b"POST /internal/wit/chat HTTP/1.1\r\nHost: localhost\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
            response = await reader.read()
            assert b"200 OK" in response.split(b"\r\n", 1)[0]
            assert b'"type": "results"' in response
            writer.close()
            await writer.wait_closed()
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
            await writer.drain()
            response = await reader.read()
            assert b"200 OK" in response.split(b"\r\n", 1)[0]
            assert b'"ok": true' in response
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()


@run_async
async def test_http_business_error_is_relayable(tmp_path):
    async def unavailable(query, filters):
        return {"ok": False, "error": {"code": "UPSTREAM_ERROR", "message": "商品源暂不可用"}}

    async with ShoppingAgent(tmp_path / "m.db", unavailable) as agent:
        server = await asyncio.start_server(lambda r, w: handle(r, w, agent), "127.0.0.1", 0)
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
            body = '{"sessionId":"web","message":"找台灯"}'.encode()
            writer.write(b"POST /internal/wit/chat HTTP/1.1\r\nHost: localhost\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
            response = await reader.read()
            assert b"200 OK" in response.split(b"\r\n", 1)[0]
            assert b'"ok": false' in response
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()


@run_async
async def test_japanese_table_keeps_style_and_excludes_chair_first(tmp_path):
    calls = []

    async def search(query, filters):
        calls.append(query)
        if len(calls) == 1:
            return {"ok": True, "items": [
                {"id": "chair", "title": "北欧实木餐椅搭配日系餐桌", "price": 399},
                {"id": "north", "title": "北欧实木餐桌家用日系餐桌椅", "price": 899},
                {"id": "poster", "title": "日系饭厅装饰画餐桌背景墙挂画", "price": 49},
                {"id": "japan", "title": "日式原木餐桌家用", "price": 1299},
            ]}
        return {"ok": True, "items": [
            {"id": "japan2", "title": "日系原木餐桌小户型", "price": 999},
            {"id": "japan3", "title": "日式实木餐桌简约", "price": 1199},
        ]}

    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        result = await agent.chat("s", "我想买一张日系原木餐桌，预算3000元以内")
        assert result["memory"]["preferences"]["style"] == "日系"
        assert result["memory"]["preferences"]["material"] == "原木"
        assert len(result["items"]) == 3
        assert all(item["id"] not in ("chair", "north", "poster") for item in result["items"])
        assert calls[1] == "日式餐桌"


@run_async
async def test_explicit_no_purchase_overrides_bored_exploration(tmp_path):
    async def unused(query, filters):
        raise AssertionError("exploration should not trigger product search")

    async with ShoppingAgent(tmp_path / "m.db", unused) as agent:
        result = await agent.chat("s", "今天有点无聊，只想随便逛逛，不打算买")
        assert result["emotion"]["purchase_intent"] == "none"
        assert result["policy"]["push_purchase"] is False


@run_async
async def test_user_preferences_cross_sessions_without_products_and_forget(tmp_path):
    calls = []

    async def search(query, filters):
        calls.append(query)
        return {"ok": True, "items": [{"id": "table", "title": "日式原木餐桌", "price": 899}]}

    path = tmp_path / "user-memory.db"
    async with ShoppingAgent(path, search) as agent:
        found = await agent.chat("old", "我喜欢日系餐桌，预算1000元以内", user_id="u1")
        assert [item["id"] for item in found["items"]] == ["table"]
        new = await agent.chat("new", "还记得我的偏好吗？", user_id="u1")
        assert "日系" in new["message"] and "1000" in new["message"]
        assert agent.memory.load("new", "u1")["current_items"] == []
        count = len(calls)
        orphan = await agent.chat("new", "第一款的材质呢？", user_id="u1")
        assert orphan["type"] == "question"
        assert "没有把上一轮商品带过来" in orphan["message"]
        deictic = await agent.chat("new", "这款材质是什么？", user_id="u1")
        assert deictic["type"] == "question"
        assert len(calls) == count
        reset = await agent.chat("old", "第一款呢？", user_id="u1", new_conversation=True)
        assert reset["type"] == "question" and len(calls) == count
        assert agent.memory.load("old", "u1")["preferences"]["style"] == "日系"
        await agent.chat("new", "忘记我的风格", user_id="u1")
        assert "style" not in agent.memory.load("old", "u1")["preferences"]
        await agent.chat("new", "忘记所有记忆", user_id="u1")
        assert agent.memory.load("old", "u1")["preferences"] == {}
        assert agent.memory.load("old", "u1")["current_items"] == []
        assert agent.memory.load("new", "u1")["current_items"] == []
        other = await agent.chat("old", "你记得我的偏好吗？", user_id="u2")
        assert "没有记下" in other["message"]
    async with ShoppingAgent(path, search) as agent:
        assert agent.memory.load("new", "u1")["preferences"] == {}


@run_async
async def test_model_interpretation_and_fact_locked_narration(tmp_path):
    model = MockModel([
        json.dumps({"query": {"style": "日系", "category": "餐桌", "material": "黄金"},
                    "memory": {"style": "日系", "imageFirst": True}, "intent": "search"}, ensure_ascii=False),
        json.dumps({"lead": "gentle", "reasons": [{"id": "good", "angle": "material", "price": 0,
                                                    "material": "黄金", "reason": "适合黄皮且护眼"}],
                    "items": [{"id": "fake", "price": 0}]}, ensure_ascii=False),
        json.dumps({"query": {"category": "护肤品", "style": "北欧"},
                    "memory": {"style": "北欧"}, "intent": "search"}, ensure_ascii=False),
        json.dumps({"lead": "direct", "reasons": [{"id": "skin", "angle": "image",
                                                       "reason": "适合黄皮，美白见效"}]}, ensure_ascii=False),
    ])

    async def search(query, filters):
        if "餐桌" in query:
            return {"ok": True, "items": [
                {"id": "good", "title": "日式原木餐桌", "price": 899,
                 "facts": {"title": "日式原木餐桌", "price": 899, "material": ["实木"]}},
                {"id": "chair", "title": "日式餐椅搭配餐桌", "price": 99},
            ]}
        return {"ok": True, "items": [{"id": "skin", "title": "黄皮显白护肤品", "price": 88}]}

    async with ShoppingAgent(tmp_path / "m.db", search, model) as agent:
        table = await agent.chat("s", "我喜欢日式餐桌，以后先看图", user_id="u")
        assert table["memory"]["preferences"]["style"] == "日系"
        assert table["memory"]["preferences"]["imageFirst"] is True
        assert [item["id"] for item in table["items"]] == ["good"]
        assert table["items"][0]["price"] == 899
        assert table["items"][0]["facts"]["material"] == ["实木"]
        assert "黄金" not in table["items"][0]["recommendation"]
        assert "黄皮" not in table["items"][0]["recommendation"]
        assert table["message"].startswith("先慢慢看")
        skin = await agent.chat("s", "我想找护肤品", user_id="u")
        assert skin["items"][0]["id"] == "skin"
        assert skin["items"][0]["price"] == 88
        assert "黄皮" not in skin["items"][0]["recommendation"]
        assert "显白" not in skin["items"][0]["recommendation"]
        assert "美白" not in skin["items"][0]["recommendation"]
        assert skin["memory"]["preferences"]["style"] == "日系"
        assert model.calls == 4


@run_async
async def test_malformed_model_plan_falls_back_without_changing_products(tmp_path):
    model = MockModel([
        json.dumps({"intent": ["search"], "query": {"category": ["台灯"]}}),
        json.dumps({"lead": [], "reasons": [{"id": ["lamp"], "angle": {"price": 0}}],
                    "items": [{"id": "forged", "price": 0}]}),
    ])

    async def search(query, filters):
        return {"ok": True, "items": [{"id": "lamp", "title": "台灯", "price": 88}]}

    async with ShoppingAgent(tmp_path / "m.db", search, model) as agent:
        result = await agent.chat("s", "找台灯")
        assert result["ok"]
        assert [item["id"] for item in result["items"]] == ["lamp"]
        assert result["items"][0]["price"] == 88


@run_async
async def test_mixed_table_candidates_return_only_two_relevant_items(tmp_path):
    calls = []
    irrelevant = [
        {"id": f"north{i}", "title": f"北欧实木餐桌 {i}", "price": 500 + i}
        for i in range(12)
    ] + [
        {"id": "chair", "title": "日式餐椅搭配餐桌", "price": 99},
        {"id": "poster", "title": "日系餐桌背景墙挂画", "price": 59},
        {"id": "cloth", "title": "日系餐桌桌布", "price": 39},
        {"id": "accessory", "title": "日系餐桌摆件", "price": 19},
        {"id": "neutral", "title": "实木餐桌", "price": 899},
    ]

    async def search(query, filters):
        calls.append(query)
        return {"ok": True, "items": irrelevant + [
            {"id": "real1", "title": "日式原木餐桌", "price": 1100},
            {"id": "real2", "title": "日系小户型餐桌", "price": 950},
        ]}

    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        result = await agent.chat("s", "想找日系餐桌")
        assert {item["id"] for item in result["items"]} == {"real1", "real2"}
        assert len(result["items"]) == 2
        assert len(calls) >= 2


@run_async
async def test_budget_does_not_treat_unknown_price_as_in_range(tmp_path):
    async def search(query, filters):
        return {"ok": True, "items": [
            {"id": "unknown", "title": "台灯", "price": None},
            {"id": "over", "title": "台灯", "price": 150},
            {"id": "known", "title": "台灯", "price": 89},
        ]}

    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        result = await agent.chat("s", "找100元以内的台灯")
        assert [item["id"] for item in result["items"]] == ["known"]
        assert "¥89" in result["items"][0]["recommendation"]


def test_legacy_session_memory_migrates_without_product_leak(tmp_path):
    from wit_agent.memory import MemoryManager

    path = tmp_path / "old.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("INSERT INTO sessions VALUES (?,?)", ("legacy", json.dumps({
            "preferences": {"style": "日系"},
            "current_items": [{"id": "old-product"}], "turns": 2,
        }, ensure_ascii=False)))
    memory = MemoryManager(path)
    old = memory.load("legacy")
    assert old["preferences"]["style"] == "日系"
    assert old["current_items"][0]["id"] == "old-product"
    assert memory.load("other", "legacy")["preferences"]["style"] == "日系"
    assert memory.load("other", "legacy")["current_items"] == []
    with sqlite3.connect(path) as db:
        stored = json.loads(db.execute(
            "SELECT data FROM chat_sessions WHERE session_id='legacy'"
        ).fetchone()[0])
    assert "preferences" not in stored


@run_async
async def test_persona_replies_acknowledge_state_with_one_useful_question(tmp_path):
    async def search(query, filters):
        return {"ok": True, "items": [{"id": "lamp", "title": "工业风台灯", "price": 99}]}

    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        bored = await agent.chat("bored", "今天无聊，想找点灵感")
        stop = await agent.chat("stop", "我先不买，只想逛逛")
        budget = await agent.chat("budget", "找100元以内的台灯")
        ready = await agent.chat("ready", "我想买台灯")
        await agent.chat("frustrated", "找台灯")
        frustrated = await agent.chat("frustrated", "上一轮不满意，改成工业风台灯")
        assert "随便看看" in bored["message"]
        assert "不考虑购买" in stop["message"]
        assert "预算上限" in budget["message"]
        assert ready["emotion"]["purchase_intent"] == "ready"
        assert "目标" not in ready["message"] and "台灯" in ready["message"]
        assert frustrated["message"].startswith("抱歉")
        for result in (bored, stop, budget, ready, frustrated):
            assert result["message"].count("？") == 1
            assert result["policy"]["question_count"] == 1
