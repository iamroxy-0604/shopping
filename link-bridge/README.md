# 链接转接台

独立的链接读取与预览界面，不依赖购物智能体的会话、问卷或商品搜索代码。

## 启动

在本目录运行：

```powershell
npm install
npm start
```

浏览器打开 `http://127.0.0.1:3100/`。运行 `npm test` 执行解析与接口测试。

## A2UI 实验台

打开 `http://127.0.0.1:3100/a2ui.html`。页面使用官方 `@a2ui/react` Renderer 和自定义“拾光内容 Catalog”，组件内部复用 MUI、Radix Dialog 和 Embla Carousel。不同来源会被编排为视频、图集或长文详情，并可在暖橙风和千禧数码风之间切换。

React 版使用 `POST /api/react-compose`。原有 `POST /api/compose` 和 Lit 购物端 Bundle 保留，因此改造不会改变已接入的购物智能体。`npm start` 会先构建 React Renderer Bundle，再启动链接转接服务。

当前是独立演示，不连接购物智能体，也没有 LLM 参与界面选择。官方基础 `Video` 组件只接收真实视频文件地址；B 站等官方嵌入播放器不当作视频文件，演示页会退回封面、提示和原链接。`POST /api/compose` 接收现有记录和 `mode`（`overview` 或 `detail`），由受控规则选择组件；其他智能体可以单独使用原 `/api/resolve` 内容接口。

## 读取流程

1. 按链接选择 OpenCLI 的单条内容命令：小红书 `note`、B 站 `video`、YouTube `video`、微博 `post`、知乎 `answer-detail` / `question`。
2. 小红书、无专用单条内容命令的平台，以及站点命令未取得关键字段时，尝试 OpenCLI Browser Bridge 读取页面。使用 Browser Bridge 需要在 Chrome 中启用 OpenCLI 扩展；对应网站需要登录时，请在同一 Chrome 配置中登录。
3. 缺少标题、正文或封面时，读取公开网页元信息作为补充。MP4 / WebM 直链直接识别为视频文件。

卡片中的“读取方式”显示实际成功取得信息的路径。OpenCLI 站点命令失败时，Browser Bridge 和公开网页解析仍可回退；不能访问的字段会明确标记，原链接始终保留。

B 站和 YouTube 视频页使用平台官方嵌入播放器，是否可播放由平台决定；这与取得 MP4 / WebM 文件不同。小红书视频没有可用播放地址时只显示实际取得的封面、正文和原帖链接。这里不分析图像或视频语义。

本服务只监听 `127.0.0.1:3100`。对输入链接拒绝本机及私有网络地址；读取公开网页时限制重定向、响应体大小和等待时间。
