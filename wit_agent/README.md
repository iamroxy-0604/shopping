# Wit 3.0 shopping sidecar

Python 3.12+ service at `127.0.0.1:8765`. `GET /health` returns 200 once the WitAgent is running. Each `POST /internal/wit/chat` runs `WitAgent.invoke()` through a `WorkflowLoopComponent` graph. Node owns `/api/chat` and the public UI. The product search is a separate POST to `http://127.0.0.1:3000/api/products/search`.

## Start (PowerShell, from repository root)

```powershell
$env:WIT_FRAMEWORK_PATH='D:\chrome download\wit-main\wit-main'
.venv\Scripts\python.exe -m wit_agent.server
```

In another terminal, start the existing Node backend, then test:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/internal/wit/chat -ContentType 'application/json' -Body '{"sessionId":"demo-1","message":"想找100元以内的日系台灯"}'
```

Environment: `WIT_PORT` (default `8765`), `WIT_PRODUCT_URL`, `WIT_MEMORY_DB` (default `wit_agent/data/memory.sqlite3`). `WIT_FRAMEWORK_PATH` adds the external Wit source to Python's import path without writing into it. An equivalent `PYTHONPATH='D:\chrome download\wit-main\wit-main;.'` also works. Set `LLM_MODEL` plus `LLM_API_KEY` (or `OPENAI_API_KEY`) to enable Wit `OpenAIModelComponent(api="chat.completions")`; `LLM_BASE_URL` is an optional API root. Secrets stay in environment variables. With no model, or if a configured model fails during a turn, deterministic replies still work. A configured model selects one of three prewritten safe openings and cannot add unsupported product claims.

Response shape: `{ok,type,message,items,memory,emotion,policy}`. `items` contains at most three UI-compatible flat product fields plus `facts` and `semantic`; `memory.preferences` is compatible with the existing rail. Session preferences and current products persist in SQLite across process restarts. User corrections overwrite preferences; “忘记风格/预算/所有记忆” removes them. Comparison and current-product questions reuse saved results without a new search.

Tests:

```powershell
$env:PYTHONPATH='D:\chrome download\wit-main\wit-main;.'
.venv\Scripts\python.exe -m pytest -q wit_agent/tests
```

The existing Node bridge should set `WIT_AGENT_URL=http://127.0.0.1:8765` and forward `{sessionId,message}` to this local endpoint.
