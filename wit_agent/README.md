# Wit 3.0 shopping sidecar

Python 3.12+ service at `127.0.0.1:8765`. `GET /health` returns 200 once the WitAgent is running. Each `POST /internal/wit/chat` runs `WitAgent.invoke()` through a `WorkflowLoopComponent` graph. Node owns `/api/chat` and the public UI. The product search is a separate POST to `http://127.0.0.1:3000/api/products/search`.

## Start (PowerShell, from repository root)

Use the Wit 3.0 source tree supplied for this project. Create a Python 3.12+ virtual environment and install the sidecar's declared dependencies once:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r wit_agent\requirements.txt
```

Set `WIT_FRAMEWORK_PATH` to the folder containing `wit/__init__.py`. From `backend`, `npm run start:wit` starts both the Python sidecar and the Node product/UI service, using `backend/.env` for local credentials. The URL is <http://localhost:3000/>. Do not commit `.env` or the SQLite memory database.

For separate development processes, from the repository root:

```powershell
$env:WIT_FRAMEWORK_PATH='D:\chrome download\wit-main\wit-main'
.venv\Scripts\python.exe -m wit_agent.server
```

In another terminal, start the existing Node backend, then test:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/internal/wit/chat -ContentType 'application/json' -Body '{"userId":"visitor-1","sessionId":"demo-1","message":"想找100元以内的日系台灯"}'
```

Environment: `WIT_PORT` (default `8765`), `WIT_PRODUCT_URL`, `WIT_MEMORY_DB` (default `wit_agent/data/memory.sqlite3`). `WIT_FRAMEWORK_PATH` adds the external Wit source to Python's import path without writing into it. An equivalent `PYTHONPATH='D:\chrome download\wit-main\wit-main;.'` also works. Set `LLM_MODEL` plus `LLM_API_KEY` (or `OPENAI_API_KEY`) to enable Wit `OpenAIModelComponent(api="chat.completions")`; `LLM_BASE_URL` is an optional API root. Secrets stay in environment variables.

Request: `{userId,sessionId,message,newConversation?}`. `userId` is optional for compatibility and defaults to `sessionId`; send a stable `userId` with each new `sessionId` to carry preferences into a new conversation. A new session starts without current products. `newConversation:true` clears the current session's product context while retaining that user's preferences. Requests such as “忘记风格/预算/所有记忆” delete the relevant user memory; “忘记所有记忆” also clears that user's saved session contexts. The SQLite store migrates legacy session records when accessed with their original sessionId.

Explicit dislikes such as “不喜欢黑色金属感” are saved as negative preferences and matching product titles are excluded. A budget explicitly scoped to “这次/本次” is a session-only override; “按我平常预算” clears it, and another session sees the durable budget. This is a deliberately narrow language rule: ambiguous budget changes are treated as ordinary preferences rather than guessed to be temporary.

Response shape: `{ok,type,message,summary,followUp,narrativeSource,items,memory,emotion,policy}`. `items` contains at most three UI-compatible flat product fields plus `facts` and `semantic`; `memory.preferences` is compatible with the existing rail. A successful nonempty result has `narrativeSource: "ai"` and complete model-written copy. Follow-ups about current products reuse the same session snapshot without a new search. Without current products, references such as “第一款” or “这款” ask for a new category instead of searching from an earlier session.

With an LLM configured, the model interprets explicit user constraints, creates three category-specific questionnaire questions (plus a budget/detail question), proposes product search phrases from the full questionnaire, and chooses up to three IDs from the retrieved candidate pool. A vague browsing request first gets a model-generated category question. After selecting products, the model must write a complete conversational introduction, cross-product summary, distinct per-product recommendations and one relevant follow-up question. The result renderer never replaces these with category-specific copy. The model sees the selected products' source fields, preferences and questionnaire answers; output IDs, completeness and unsupported numeric specifications are validated. An invalid/failed narration gets one model retry. If that also fails or no model is configured, the API returns `NARRATIVE_UNAVAILABLE` with no product narrative, retaining the selected source items for a `重试生成推荐` request. Failure reasons, counts and timestamps (never credentials or prompts) are recorded next to the SQLite database in `memory.events.log`. Earlier model stages can still fall back to local question templates, search phrases and deterministic ranking. Product IDs, prices and links come from the search result. Product titles are seller descriptions, not verified efficacy or suitability; concrete claims must be checked on the source platform. For “日系餐桌”, chairs, tablecloths, wall art, accessories and conflicting styles such as 北欧 are excluded. Later searches seek up to three qualifying tables; if only one or two qualify, only those are returned.

Current-product questions and comparisons never trigger another search. Missing inventory, dimensions, material, future promotions, or performance data are reported as unknown rather than inferred from the title. Vague requests such as “桌上的东西” ask for a category before searching.

An explicit browse request such as “只想逛逛，推荐一些桌面好物给我看看” retrieves a small mix of desk lamps, organizers, and decor while keeping purchase pressure off. A follow-up such as “想要点日系的” refines that same browsing direction instead of treating “好物给我看看” as a product category. Existing sessions with that invalid saved category are cleaned up on their next turn. If only one or two relevant goods qualify, the agent does not pad the row with unrelated items.

Tests:

```powershell
$env:PYTHONPATH='D:\chrome download\wit-main\wit-main;.'
.venv\Scripts\python.exe -m pytest -q wit_agent/tests
```

The Node bridge sets `WIT_AGENT_URL=http://127.0.0.1:8765` in the combined launcher and forwards `{userId,sessionId,message}`. The browser keeps a random `userId` in local storage and rotates `sessionId` for a new conversation. Shopping preferences, questionnaires, product selections, and feedback are stored per session in SQLite; a new session starts without the previous session's shopping conditions. Browser history is stored in localStorage. Neither store currently has automatic expiry, and the browser UI has no per-conversation delete control. This is a local prototype identity, not account authentication; do not expose the service publicly without adding authentication and privacy controls.
