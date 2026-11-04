import asyncio
from types import SimpleNamespace

import httpx
import pytest
from wit.acps.aip.direct.protocol import _partner_result_document
from wit.acps.aip.partner import PartnerProtocolError
from dingdang_adapter.partner import ShoppingPartnerComponent


def inbound(command="start", peer="dd-peer", purpose="买台灯"):
    return SimpleNamespace(peer=SimpleNamespace(aic=peer), local_entity=SimpleNamespace(aic="shopping"),
                           transport="direct", peer_aic=peer,
                           scope=SimpleNamespace(local_aic="shopping", session_id="aip-session", group_id=None),
                           message={"command": command, "taskId": "task-one", "dataItems": [
                               {"type": "data", "data": {"protocol": "dingdang.interactive-session", "version": "0.1",
                                                         "sessionId": "shopping-session", "requestId": "request-one",
                                                         "body": {"purpose": purpose}}}]})


def test_partner_start_get_replay_and_wit_wire_validation(tmp_path):
    async def scenario():
        calls = []
        async def handle(request):
            import json
            body = json.loads(request.content)
            calls.append(body)
            return httpx.Response(200, json={"protocol": "dingdang.interactive-session", "version": "0.1",
                                            "kind": "snapshot", "sessionId": "shopping-session",
                                            "replyTo": "request-one", "body": {"revision": 1}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            partner = ShoppingPartnerComponent(token="test-token", database=str(tmp_path / "tasks.db"), client=client)
            first = await partner._handle(inbound())
            assert first["status"]["state"] == "working"
            _partner_result_document(first, inbound(), "shopping")
            await asyncio.gather(*partner.running.values())
            result = await partner._handle(inbound("get"))
            assert result["status"]["state"] == "completed"
            _partner_result_document(result, inbound("get"), "shopping")
            await partner._handle(inbound())
            assert len(calls) == 1
            assert "dd-peer" in calls[0]["owner"]
            with pytest.raises(PartnerProtocolError):
                await partner._handle(inbound(purpose="换一个任务"))
            with pytest.raises(PartnerProtocolError):
                await partner._handle(inbound("get", peer="other-peer"))
            await partner.teardown_handler(None)
    asyncio.run(scenario())


def test_unverified_transport_is_rejected(tmp_path):
    async def scenario():
        partner = ShoppingPartnerComponent(token="test-token", database=str(tmp_path / "tasks.db"))
        request = inbound()
        request.peer = None
        with pytest.raises(PartnerProtocolError):
            await partner._handle(request)
        await partner.teardown_handler(None)
    asyncio.run(scenario())
