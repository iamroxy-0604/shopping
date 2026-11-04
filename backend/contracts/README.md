# Dingdang 协议来源

`interactive-session-v0.1.json` 原样来自用户提供的 `dingdang-v3-910b-20261104` 源码包：`backend/app/contracts/interactive-session-v0.1.json`。

参考发布：`v3.6.0-unified-quota-20261103-910b-r1`。请求与响应均使用此 JSON Schema 验证，不另造一套 DD 协议。

`../tests/fixtures/dd-interactive-web-surface.js` 原样来自同包的 `frontend/interactive-web-surface.js`，用于验证实际 `sandbox="allow-scripts allow-forms"`、CSP 与 MessageChannel 握手。
