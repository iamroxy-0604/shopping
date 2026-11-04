"""Install this component beside Wit's authenticated DirectPartnerEndpointComponent.

Never expose the Node internal adapter as a public unauthenticated AIP endpoint.
The verified peer and local identity come only from Wit's admitted transport.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from wit.acps.aip.partner import BasePartnerHandlerComponent, PartnerProtocolError


def plain(value):
    if isinstance(value, Mapping):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


class ShoppingPartnerComponent(BasePartnerHandlerComponent):
    name = "shiguang-shopping-partner"

    def __init__(self, *, token=None, endpoint="http://127.0.0.1:3000/internal/dingdang/session",
                 database="dingdang_adapter/.data/tasks.sqlite3", client=None):
        self.token = token or os.environ.get("DINGDANG_ADAPTER_TOKEN")
        if not self.token:
            raise ValueError("DINGDANG_ADAPTER_TOKEN is required")
        from urllib.parse import urlparse
        parsed = urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("The Node adapter must be on loopback")
        self.endpoint = endpoint
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(database)
        self.db.execute("CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY, fingerprint TEXT, envelope TEXT, owner TEXT, result TEXT)")
        self.db.commit()
        self.running = {}
        self.client = client

    async def teardown_handler(self, ctx):
        for task in list(self.running.values()):
            task.cancel()
        await asyncio.gather(*self.running.values(), return_exceptions=True)
        self.db.close()

    async def _run(self, key, envelope, owner):
        try:
            async def invoke(client):
                reply = await client.post(self.endpoint, headers={"Authorization": "Bearer " + self.token},
                                          json={"envelope": envelope, "owner": owner})
                reply.raise_for_status()
                value = reply.json()
                if value.get("protocol") != "dingdang.interactive-session" or value.get("sessionId") != envelope["sessionId"] or value.get("replyTo") != envelope["requestId"]:
                    raise ValueError("Mismatched adapter response")
                return value
            if self.client:
                result = await invoke(self.client)
            else:
                async with httpx.AsyncClient(timeout=345, trust_env=False) as client:
                    result = await invoke(client)
            self.db.execute("UPDATE tasks SET result=? WHERE key=?", (json.dumps(result, ensure_ascii=False), key))
            self.db.commit()
        except (httpx.HTTPError, ValueError):
            # A subsequent get retries the same envelope. Node's durable ledger prevents re-execution.
            pass
        finally:
            self.running.pop(key, None)

    async def _handle(self, inbound):
        if inbound.peer is None or inbound.local_entity is None or inbound.transport != "direct":
            raise PartnerProtocolError("Verified HTTPS peer and local identity are required")
        message = plain(inbound.message)
        command, task_id = message.get("command"), message.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise PartnerProtocolError("taskId is required")
        # Bind task records to both verified entities and the AIP session scope.
        owner = json.dumps([inbound.scope.local_aic, inbound.peer_aic], separators=(",", ":"))
        key = hashlib.sha256(json.dumps([owner, inbound.scope.session_id, task_id]).encode()).hexdigest()
        row = self.db.execute("SELECT fingerprint,envelope,owner,result FROM tasks WHERE key=?", (key,)).fetchone()
        if command == "start":
            envelopes = [i.get("data") for i in message.get("dataItems", []) if i.get("type") == "data"]
            if len(envelopes) != 1 or not isinstance(envelopes[0], dict) or envelopes[0].get("protocol") != "dingdang.interactive-session":
                raise PartnerProtocolError("One interactive-session envelope is required")
            envelope = envelopes[0]
            encoded = json.dumps(envelope, sort_keys=True, separators=(",", ":"))
            fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
            if row and row[0] != fingerprint:
                raise PartnerProtocolError("Task id reused with different input")
            if not row:
                self.db.execute("INSERT INTO tasks VALUES (?,?,?,?,NULL)", (key, fingerprint, encoded, owner))
                self.db.commit()
                row = (fingerprint, encoded, owner, None)
        elif command != "get":
            raise PartnerProtocolError("Use start/get; end the workspace with the interactive close envelope")
        if not row:
            raise PartnerProtocolError("Unknown task in this verified scope")
        if row[3] is None and key not in self.running:
            self.running[key] = asyncio.create_task(self._run(key, json.loads(row[1]), row[2]))
        now = datetime.now(timezone.utc).isoformat()
        result = {"type": "task-result", "id": str(uuid4()), "sentAt": now,
                  "senderId": inbound.scope.local_aic, "senderRole": "partner", "taskId": task_id,
                  "status": {"state": "completed" if row[3] else "working", "stateChangedAt": now}}
        if inbound.scope.session_id:
            result["sessionId"] = inbound.scope.session_id
        if row[3]:
            result["status"]["dataItems"] = [{"type": "data", "data": json.loads(row[3])}]
        return result
