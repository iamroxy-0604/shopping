# 拾光 · Dingdang 电脑端接管版

本次版本：2026-11-04。分支 `codex/dingdang-desktop-shopping`，基于原 `codex/react-a2ui-module`。

## 交付

- 独立电脑端：`backend/public/desktop/`，默认入口 `/`，演示入口 `/desktop/?demo=1`。原移动端保留在 `/mobile/`。
- DD 内嵌：同一份界面打包为 `{html,css,script}`，由 DD 原版隔离宿主载入。握手严格校验宿主来源、会话、nonce 和 MessagePort。
- 商品、需求问卷、AI 导购、比较追问、商品详情、收藏、浏览器历史、会话结束摘要。DD 内嵌收藏仅在工作区内暂存，独立端保存在本浏览器。
- 新入口源头跳过帖子搜索，输出采用商品字段白名单，不返回帖子、视频或内容 A2UI 块。旧移动端接口没有改成新协议。
- DD `open/input/sync/close`、表单动作、共享参考资料、版本冲突、幂等重放、持久快照、过期检查、身份隔离、交回摘要。

## 运行

```powershell
cd backend
npm ci
npm run start:desktop
```

沿用 `backend/.env` 的商品与模型服务配置。默认端口 3000；可设置 `PORT` 与 `WIT_PORT`。原启动器通过 `WIT_FRAMEWORK_PATH` 和 `PYTHON_EXECUTABLE` 定位本地 Wit 与 Python。仅启动 Node 可用 `npm start`，但会使用原 Node 导购回退实现。

演示模式始终有明确标识，数据来自页面内样例，不会写入正式会话或收藏。正式模式不在外部服务失败时替换成演示商品。

## DD 服务端接入

DD 分享包里的 Wit ACPs 代码依赖 Linux 的 `fcntl`。将本适配器放在 Linux/WSL 的已认证 Wit Partner 服务中，使用分享包对应的 Wit 3.0 源码。

1. Node 服务与 Partner 运行在同机。两边设置同一个随机 `DINGDANG_ADAPTER_TOKEN`；只放环境变量，不提交仓库。
2. 在现有已完成身份签发、注册与 mTLS 接入的 Partner `WitAgent` 上，安装本组件替代该服务原有的 `PARTNER_HANDLER`。已有的 `DirectPartnerEndpointComponent`、身份目录、TLS 服务等继续由宿主部署负责：

```python
from dingdang_adapter.partner import ShoppingPartnerComponent

agent.install(ShoppingPartnerComponent(
    endpoint="http://127.0.0.1:3000/internal/dingdang/session",
    database="dingdang_adapter/.data/tasks.sqlite3",
), required=True)
```

3. 用真实 AIC、HTTPS endpoint 和 `skill-card.json` 的能力描述注册购物智能体。DD 根据描述中的 `dingdang.interactive-session/0.1` 和可验证的 HTTPS callable 能力识别接管入口。`skill-card.json` 是能力描述模板，不包含虚构身份。
4. DD 调用 AIP `start`，数据项为交互封套；适配器迅速返回 `working`，后台完成导购；DD 通过 `get` 读取 `completed`。响应包含标准 dataItem。DD 中的“临时问叮当”“共享范围”“交回叮当”由 DD 宿主管理。

Node 内部接口只接受 loopback、无浏览器 Origin、有效 Bearer token 的请求。`owner` 来自 Python 适配器的已验证双方 AIC，不能由网页提供。不要将此内部接口直接暴露公网。独立电脑端沿用项目本地开发服务模式，上线须在入口层配置用户认证。

持久目录 `backend/data/dingdang-sessions/` 与 `dingdang_adapter/.data/` 已忽略。模型调用前写入操作标记，完成后原子写入结果。进程异常后不盲目重做不确定操作；恢复核对会显示未知状态，用户可结束并新开会话。当前适配器按单个 Node 服务实例设计，不支持多实例并发写同一目录。

## 验收

```powershell
cd backend
npm test
node tests/preview-dd-host.mjs
```

第二条命令启动 4319 端口的**测试宿主**，使用原样保留的 DD 沙箱渲染器和明确标记的测试商品。它不接入线上 DD，也不产生真实订单。

Python：设置对应 Wit 源码的 `PYTHONPATH` 后运行 `python -m pytest wit_agent/tests -q`；在 Linux 使用分享包 Wit 运行 `python -m pytest dingdang_adapter/tests -q`。后者会调用 Wit 原版 AIP 响应校验函数。

## 本次实际验证与边界

- Node 后端 48 项测试通过，含新增 8 项接管协议、购物字段与身份兼容测试。
- 原购物 Python Agent 38 项测试通过，含新增“不调用帖子检索”测试。
- Linux/WSL 下使用 DD 随附 Wit 源码的 Partner 适配测试 2 项通过，包含原版 AIP 响应校验、轮询、重复请求与身份隔离。
- 浏览器验证了电脑端、窄屏、收藏、详情及 DD 原版沙箱中的问卷、商品结果、恢复和交回摘要。
- 首次验收的一次淘宝请求在 8 秒内未返回。后续复查使用相同配置和未修改的淘宝调用代码，344 毫秒返回 3 件真实商品。原始日志不足以确定那次超时原因。
- 补充验收已跑通真实四题问卷 → 3 件淘宝商品 → AI 归纳与后续引导 → 原商品价格比较。详见 `功能完整性复核.md`。
- 分享包没有线上 DD 的注册身份、证书、生产凭据；本次没有登录、部署或发布到线上 DD。代码和本地协议验收不等于线上联调完成。

## 参考素材

橙红色和布局参考用户提供的 `shopping-takeover.html`；DD 形象、图标、三张示例商品图均从该 HTML 的内嵌素材抽出，仅用于本次界面与演示。未上传整个 DD 源码包、私人配置、数据库或其他未跟踪原型。改版前交接见仓库根目录 `交接汇总_改版前现状_2026-11-04.md`。
