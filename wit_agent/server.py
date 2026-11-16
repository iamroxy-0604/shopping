"""Minimal localhost HTTP sidecar; Node owns the public /api/chat bridge."""

import asyncio
import json
import os
import sys
from pathlib import Path

if os.getenv("WIT_FRAMEWORK_PATH"):
    sys.path.insert(0, os.environ["WIT_FRAMEWORK_PATH"])

from .agent import ShoppingAgent

MAX_BODY = 16_384


def json_response(status: int, data: dict) -> bytes:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    return (f"HTTP/1.1 {status} {'OK' if status < 400 else 'Error'}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\nContent-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n").encode() + body


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, agent: ShoppingAgent):
    status, payload = 500, {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "服务暂时不可用"}}
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        if len(header) > 8192:
            raise ValueError("headers too large")
        lines = header.decode("latin-1").split("\r\n")
        method, path, _ = lines[0].split(" ", 2)
        if method == "GET" and path == "/health":
            status, payload = 200, {"ok": True, "service": "wit-shopping-agent"}
        elif method != "POST" or path != "/internal/wit/chat":
            status, payload = 404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "接口不存在"}}
        else:
            fields = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    fields[key.lower()] = value.strip()
            size = int(fields.get("content-length", "-1"))
            if size < 0 or size > MAX_BODY or "chunked" in fields.get("transfer-encoding", "").lower():
                raise ValueError("invalid content length")
            body = await asyncio.wait_for(reader.readexactly(size), timeout=10)
            request = json.loads(body)
            if not isinstance(request, dict):
                raise ValueError("JSON object required")
            payload = await agent.chat(
                request.get("sessionId"), request.get("message"), request.get("userId"),
                new_conversation=request.get("newConversation", False), answer=request.get("answer"),
            )
            status = 200  # Node bridge relays application errors only for 2xx responses.
    except (ValueError, UnicodeError, json.JSONDecodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        status, payload = 400, {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "请求格式不正确"}}
    except TimeoutError:
        status, payload = 408, {"ok": False, "error": {"code": "TIMEOUT", "message": "请求超时"}}
    except Exception:
        pass
    writer.write(json_response(status, payload))
    try:
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def main():
    host = os.getenv("WIT_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("WIT_HOST must be loopback")
    port = int(os.getenv("WIT_PORT", "8765"))
    memory_path = Path(os.getenv("WIT_MEMORY_DB", str(Path(__file__).parent / "data" / "memory.sqlite3")))
    async with ShoppingAgent(memory_path) as agent:
        server = await asyncio.start_server(lambda r, w: handle(r, w, agent), host, port)
        print(f"Wit shopping sidecar listening on http://{host}:{port}", flush=True)
        async with server:
            await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
