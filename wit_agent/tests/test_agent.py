import asyncio
import functools

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

    async def _stream(self, request, invocation):
        self.calls += 1
        yield ModelEvent.final(ModelResult(AssistantMessage(self.output)))


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
        assert result["items"][0]["recommendation"] == "标题包含“台灯”；商品信息标有“日系”；标价 ¥89，在 ¥100 预算内"
        assert calls[0][1] == {"end_price": 100.0}
        assert model.calls == 1
        compared = await agent.chat("s1", "第一款和第二款哪个好？")
        assert compared["type"] == "comparison" and compared["items"] == []
        assert "日系台灯" in compared["message"]
        assert len(calls) == 1
        redirected = await agent.chat("s1", "这些都不喜欢，改成工业风台灯")
        assert redirected["emotion"]["mood"] == "frustrated"
        assert redirected["policy"]["action"] == "search"
        if redirected["items"]:
            assert redirected["message"].startswith("明白")
        else:
            assert redirected["type"] == "results"
        assert redirected["memory"]["preferences"]["style"] == "工业风"
        other = await agent.chat("s2", "我今天无聊，只想逛逛，不想买")
        assert other["emotion"]["mood"] == "stop_selling"
        assert other["policy"]["push_purchase"] is False
        assert len(calls) == 2
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
    search, _ = catalog
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
        second = await agent.chat("s", "它的材质是什么？")
        assert second["type"] == "comparison"
        assert "未列出的属性" in second["message"]


@run_async
async def test_http_contract(tmp_path, catalog):
    search, _ = catalog
    async with ShoppingAgent(tmp_path / "m.db", search) as agent:
        server = await asyncio.start_server(lambda r, w: handle(r, w, agent), "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            body = '{"sessionId":"web","message":"找台灯"}'.encode()
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
