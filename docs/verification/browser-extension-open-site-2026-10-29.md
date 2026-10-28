# 浏览器工具条打开 Doca 网站

2026-10-29 验证 Doca 0.2.25 / 浏览器扩展 0.2.11。浮动工具条在助手和设置之间增加外链图标，中文提示「打开 Doca 网站」、英文提示「Open Doca website」。分隔线将收录/助手与站点/设置分组，原有拖动和收起操作保留。

后台处理 `openSite` 消息，只接受本扩展界面及受信的顶层网页脚本，复用现有 `siteConfig` / `validateConfig` / `originOf` 校验并打开当前配置的 origin。忽略消息传入的 URL；不要求登录、不发起收录或 AI 请求。不新增权限、API、配置字段、数据库列或持久化格式，现有版本验证及旧配置拒绝规则原样保留。未配置或无效配置转到插件设置，不改写原记录。

`tests/browser-extension-content.test.ts` 和 `tests/browser-extension-background.test.ts` 共 118 项通过，覆盖中英文标签、可信点击、失败提示、未配置/错误地址、站点切换、禁止子框架/外部扩展、待发送数据保留，以及打开网站不调用登录或网络接口。

`node tests/qa-browser-extension-open-site.mjs` 在隔离 Chromium 配置中加载实际 MV3 worker 和闭合 Shadow DOM 工具条，全部通过：

- 无授权时实际点击，在新标签页打开配置的 Doca 站点；所有 storage 和未发送材料一致。
- 切换配置地址和英文后刷新，按 Enter 打开最新地址。
- 390 × 260 短窗口内五个图标、拖动和收起控件均完整可见。
- 缺失配置和无效 `javascript:` 地址都打开扩展设置，损坏记录保留。
- 全程未发出收录、登录或 AI API 请求。

较早的综合 dock 脚本在站点跳转、三次收录、拖动及设置检查后，等待既有助手输入框时超时；不计作通过。该脚本 fixture 尚未提供已有的 `/release` 接口。此次新能力由独立真实浏览器用例验收，助手综合脚本的失败记录完整保留。

全部扩展单元/下载回归 171 项、类型检查、生产构建、104 页双语文档检查、6 项文档测试、编辑器正式 npm 来源核对和部署打包均通过。

运行日志、报告及已人工核对的桌面/短窗口截图位于忽略目录 `artifacts/verification/browser-extension-open-site/`；未操作用户文档或浏览器配置。
