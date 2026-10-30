# 淘宝联盟商品搜索后端

这是第一版购物智能体的商品检索服务。前端只调用自己的 `POST /api/products/search`，淘宝 AppSecret 只存在服务端环境变量中。

现在也包含一个可直接打开的 MVP 页面：启动服务后访问 <http://localhost:3000/>，即可输入需求、接收追问并查看商品卡片。

## 启动

需要 Node.js 18+（内置 `fetch`）。

```powershell
cd backend
Copy-Item .env.example .env
# 在 .env 中填写真实密钥，不要把 .env 提交到 Git
$env:TAOBAO_APP_KEY = "你的 App Key"
$env:TAOBAO_APP_SECRET = "你的 App Secret"
$env:TAOBAO_ADZONE_ID = "116324050165"
npm test
npm start
```

若要运行 Wit 3.0 版导购，请先按 [wit_agent/README.md](../wit_agent/README.md) 配好 Python 3.12 和本地 Wit 3.0 源码，然后在 `backend` 目录执行 `npm run start:wit`。该命令会启动本机 Python Wit Agent 与现有 Node 商品接口，页面仍在 <http://localhost:3000/>。普通 `npm start` 保留旧版 Agent 作为对照实验 A/B 的入口。

请求示例：

```json
POST http://localhost:3000/api/products/search
{
  "query": "我想找日系出租屋桌面灯，预算100元以内",
  "filters": { "has_coupon": 1, "sort": "_total_sales" }
}
```

对话入口：

```http
POST http://localhost:3000/api/chat
```

```json
{
  "sessionId": "demo-user-1",
  "message": "我想找日系出租屋桌面灯，预算100元以内"
}
```

手机端结构化对话也支持 `POST /api/chat/stream`。请求仍使用 `sessionId`、`message`，回答追问时增加 `answer: { "questionId": "skinType|budget", "value": "..." }`。接口以 SSE 返回真实执行的 `phase` 事件，随后返回 `result`：

```text
event: phase
data: {"id":"understand","label":"需求分析","status":"completed"}

event: result
data: {"ok":true,"type":"results","message":"卡片前说明","items":[],"summary":"卡片后归纳","followups":[]}
```

以防晒霜为核心的任务会动态确认肤质和单件预算；已经在原话中给出的条件会跳过。商品搜索完成后才会返回商品卡，价格或购买链接缺失时保持缺失，不生成占位信息。

`/api/chat` 是当前 MVP 的 Agent 入口。普通 `npm start` 使用旧版进程内 Agent，适合对照；`npm run start:wit` 使用 Wit 3.0 工作流、SQLite 记忆与同一个商品接口。Wit 模式下前端还会发送本地稳定的 `userId`：新对话保留用户偏好，但不会沿用上一轮可比较商品。用户可在记忆栏发送删除指令。

返回 `items` 中的统一字段：`id`、`title`、`imageUrl`、`price`、`originalPrice`、`coupon`、`promotionUrl`、`shopName`、`sales`、`source`。

## 目前范围

- 已实现淘宝联盟 `taobao.tbk.dg.material.optional` 的 POST 请求、北京时间戳、HMAC-MD5/MD5 签名函数。
- 兼容 `taobao.tbk.dg.material.optional.upgrade` 推广者物料搜索升级版，支持关键词、价格和类目筛选。
- 同时兼容 `taobao.tbk.dg.material.recommend` 物料精选接口；该接口需要 `TAOBAO_MATERIAL_ID`，不支持直接传自然语言关键词。
- 已实现中文查询中的基础预算提取；复杂意图识别仍应放在后续 Agent 层。
- 已实现淘宝错误、超时、网络失败、HTTP 429 的统一错误码。
- 未实现网页抓取、模拟登录、自动下单。

## 日志

服务启动后会把每次对话的关键链路写入 `backend/logs/app.log`，包括用户输入、LLM 解析结果、最终搜索词、淘宝召回数量、过滤后的商品和排序结果。日志文件只保存在本地，不会提交到 GitHub。

## 重要提醒

`TAOBAO_APP_SECRET` 不要写入前端、Markdown、截图或 Git。你刚才在聊天中贴出了真实 Secret，建议在淘宝开放平台立即轮换；本项目不会把它写入任何文件。

签名实现依据淘宝开放平台的官方协议：参数按 ASCII 排序并拼接，`sign_method=hmac` 使用 HMAC-MD5，`sign_method=md5` 使用 `MD5(secret + 拼接串 + secret)`。参考：[淘宝开放平台 API 调用协议](https://developer.alibaba.com/docs/doc.htm?articleId=101617&docType=1&treeId=153)。

## 权限排查记录

本项目调用的是 `taobao.tbk.dg.material.optional`（淘宝客-推广者-物料搜索），官方接口文档 ID 为 35896。`taobao.tbk.item.info.get`（官方文档 ID 24518）是另一支接口，只能根据商品 ID 查询详情，不能替代关键词搜索。若搜索接口返回 `isv.permission-api-package-limit`，需要在当前 AppKey 的权限包中单独确认物料搜索接口，而不是只确认“淘宝客公用物料信息查询”分类存在。

当前账号的“推广者商品物料获取”权限已实测支持 `taobao.tbk.dg.material.optional.upgrade`：输入“日系桌面灯”可以返回真实的日系灯具商品。不要把它误配成 `taobao.tbk.dg.material.recommend`，后者是固定物料精选接口，不支持 q 关键词。
## 相关内容搜索

此模块需要 Node.js 20.18.1+。`npm install` 安装 OpenCLI。`npm run start:wit` 同时启动 Node 和 Wit；小红书搜索还需要在本机 Chrome 登录小红书并启用 OpenCLI Browser Bridge。问卷完成后，Wit 会并行请求商品与帖子。帖子媒体下载到 `backend/data/content-media/`，通过受控的 `/api/content/media/` 路径展示；该目录不进入 Git。未登录、链接失效或媒体下载失败会返回可识别状态，不会伪造正文或媒体。

独立检查内容接口：向 `http://127.0.0.1:3000/internal/content/discover` POST `{"category":"台灯","scene":"书桌","limit":2}`。接口仅接受本机调用。运行 `npm test` 和仓库根目录下的 Wit pytest 测试可验证字段映射、追问与降级行为。

## 链接转接与 A2UI

先在 `link-bridge/` 执行 `npm install`，然后在 `backend/` 执行 `npm run start:wit`。启动脚本会将官方 `@a2ui/lit` Renderer 构建到购物页面。用户一次可粘贴最多 5 条公开 HTTP(S) 链接；后端复用 `link-bridge` 的解析器，按来源分别生成 `ContentRecord` 与 A2UI v0.9.1 消息，Wit 将记录留在当前会话。非商品内容显示为横向链接卡片，打开后在可滚动弹窗内切换；商品站点链接仅提供原商品页入口，不被当作已核验 SKU。

模型网关可用时，受控布局规划器根据实际文字和媒体选择文字优先、图片优先或视频布局；网关不可用时由确定性规则选择，并在弹窗标明“按内容类型编排”。页面只渲染受控的 A2UI basic 组件。自动搜索目前仍仅覆盖小红书，但其新检索记录也生成 A2UI；粘贴单条链接支持转接器已有的平台读取范围。旧会话在此改动前保存的内容记录没有 A2UI 消息，会显示普通预览。
