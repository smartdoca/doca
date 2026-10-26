# 浏览器助手升级提示与版本化下载验收

日期：2026-10-26。扩展版本：0.2.7。

## 实现范围

- 新增只读的 `/api/v1/browser-clipper/release`，返回本站扩展包版本及文件名，来源为扩展的 `manifest.json`。
- 扩展弹窗、设置和 AI 侧栏显示新版提示，跳转当前 Doca 站点的浏览器助手下载页。设置中显示已安装版本，并提供手动检查与常驻下载入口；保持界面打开时每五分钟检查一次，连接刷新也受五分钟检查间隔限制。
- Doca 下载区的名称、按钮和完整文件名展示扩展版本。下载实际采用响应中的版本化文件名，格式为 `doca-browser-assistant-<version>.zip`。
- 检查接口不要求登录、不发送凭证。接口缺失、元数据无效或网络失败明确显示检查失败，不宣称已是最新版。版本按数字分段比较；已安装版本高于本站包时不提示降级。
- 此次只提供新版包提示，不增加协议兼容判断、强制升级、历史格式 reader、配置或队列迁移。既有认证、收录、待发送数据格式和原来的历史队列处理约定不变。旧扩展需手动更新一次才会获得检查功能。

## 验证结果

相关 Vitest 测试七个文件、166 项通过：

- `browser-extension-background.test.ts`：0.2.9 与 0.2.10 的数字比较、等价四段版本、较旧服务端包、无登录检查、不修改待发送状态、无效响应及失败路径、消息来源限制。
- `browser-extension-ui.test.ts`：弹窗、设置和侧栏提示，中英文切换，失败后的手动重试，切换站点后的下载入口。
- `browser-clipper-download.test.ts`：展示本站包版本，按实际响应文件名下载，元数据读取失败时禁用下载并可重试。
- `browser-clipper.test.ts`：隔离数据库下核对公开元数据、下载响应文件名和 ZIP 内 manifest 版本一致；原有收录、认证及包完整性测试。
- `clipper-destination-tree.test.ts`、`i18n.test.ts`、`i18n-coverage.test.ts`：相关界面与语言回归。

真实 Chromium Manifest V3 验证使用隔离扩展目录、浏览器配置及模拟站点 API，Doca 下载页挂载实际 `BrowserClipperSettings` 组件。将测试副本的已安装版本设为 0.2.6，本站实际打包版本为 0.2.7，验证：

1. 扩展设置和侧栏出现新版提示。
2. 点击提示打开当前配置站点的下载页。
3. 页面显示 0.2.7 及 `doca-browser-assistant-0.2.7.zip`。
4. 实际下载文件名和 ZIP 内 manifest 版本一致。
5. 版本接口返回 404 后显示检查失败，收录连接状态不被改成失败。

该浏览器验证通过，无页面脚本错误。检查过扩展设置和下载页面截图；未使用用户文档或生产数据库。执行脚本、截图、下载包、JSON 结果和日志均位于 `artifacts/verification/browser-extension-updates/`；单元测试日志为 `artifacts/verification/browser-extension-update-tests.log`。

## 全量验证限制

执行全量类型检查和 Web 生产构建时，同一工作区的编辑器依赖正由另一个任务更新。当前安装状态缺失 `@smartdoca/slate` 的多个导出，生产构建在解析 `@smartdoca/slate/headless` 时失败，类型检查也存在相应错误。本记录不宣称全量检查通过；整合发布前需在依赖安装完成后重新执行。未为此改写编辑器集成或回退依赖。

## 整合复核

Slate 0.4.26 正式包安装完成后，宿主类型检查与 Web 生产构建均已通过，安装中缺失依赖的限制已解除。扩展 0.2.7 与 Annual Reviews 收录修复一同整合到 0.2.20；实际浏览器收录、刷新与原站点恢复见 [Annual Reviews 验收](annualreviews-capture-2026-10-26.md)。
