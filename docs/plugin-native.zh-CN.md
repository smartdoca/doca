# App 插件缓存与附件能力

[English](plugin-native.md)

`host.ai.open` 在原生插件容器通过新增的 `assistant.open` 操作打开原生个人助手。参数和错误语义见[启动契约](plugin-assistant.md)。提示词/上下文不进入导航 URL，账号凭据不进入 WebView；预填请求在内存中按账号和一次性启动标识消费。

公开类型来自 `@smartdoca/plugin-sdk/native`，通过 `PluginWebHost.native` 使用。在 Web 为 null；App 插件容器中提供：

- `storage.get(key)` / `set(key, value)` / `remove(key)` / `clear()`：字符串缓存，单值最多 200 万字符，每个插件最多 2000 万字符。
- `attachments.save({path,name,mime})` / `share(...)`：path 是插件 API 下相对路径，例如 `/mailboxes/123/attachments/456?download=true`。

缓存命名空间由原生宿主绑定服务器、在线确认的用户 ID 和插件 ID，插件不能指定其他身份。数据保存在 App 持久目录，跨重启保留，退出或移除账号时清理对应服务器缓存。写入串行执行，新快照完成后再替换旧快照。WebView 保持临时隔离，登录 Cookie 不作为持久缓存方案。

原生先在线核验登录身份再加载插件。已有插件 IndexedDB 代码不会自动迁移或接管；插件应显式采用 native.storage。不支持完全离线冷启动，卸载 App 或系统清理存储不保证缓存保留。

附件下载经宿主内部鉴权派发，禁止插件重定向到外域；原生会话 token 不交给 WebView。最大附件 32 MiB。保存/分享结束清理临时文件。

Android save 使用系统目录选择，返回 completed 或 canceled。iOS save 和 share 打开系统分享面板，返回 presented；系统接口不提供可靠的最终保存/取消结果，因此 presented 不能当成保存成功。

页面卸载或账号切换取消正在执行的原生请求。邮箱绑定在 Web 完成，不提供原生 OAuth 流程。

当前已通过类型检查和协议/宿主下载测试，缓存持久性、系统分享及保存仍需 iOS/Android 真机验收。
