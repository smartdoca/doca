# 邮箱插件接入交接（2026-09-26）

本文件描述当前可用能力；不把目标规范等同于现有实现。邮箱侧原始需求见 `doca-mail/docs/PUBLIC_CAPABILITY_GAPS.md`，以本次边界决定修订该清单。

## 已确定的存储边界

Doca 不提供插件数据库、任意 SQL、键值业务存储或插件凭证仓库。`data.v1` 及 `plugin_data` 基线已删除；不开发 `data.v2`。插件自行管理数据库连接、索引、迁移锁、事务、outbox、OAuth 凭证加密、队列租约、重试和消费游标。部署密钥从插件自己的环境配置或外部密钥管理器取得，不写入浏览器产物、普通配置或日志。

生命周期已经可用：`discover` 注册服务；`initialize` 每次启动连接数据库并注册清理；`migrate` 取得迁移锁并执行不可改写的顺序迁移；`mount` 注册接口；`ready` 启动任务；`dispose` 停止并排空任务，关闭连接。数据库迁移版本以插件数据库自己的记录为准，不能依赖宿主传入的 previousVersion。打开连接后立即注册 `context.effect(() => cleanup)`，保证后续启动失败也可清理。清理必须幂等。`migrate` 在宿主已记录相同包版本时可能跳过，所以连接和每次启动的数据库完整性检查必须放在 `initialize`；需要每次启动核对自己的迁移历史时，也在 initialize 调用插件自身的幂等迁移函数。

插件安装目录与数据库目录分离。宿主升级、插件禁用和卸载不删除插件数据库。多实例迁移互斥及任务抢占由插件实现。跨插件数据库和 Doca 文件服务没有共同事务：先持久化操作意图，使用幂等标识，失败时补偿，定期清理无引用附件。

## 当前可用的接口

### HTTP：`@doca/plugin-sdk/platform`

`httpServiceToken.register(pluginId, routes)` 的路径为 `/api/v1/plugins/<pluginId>/...`。默认路由仍要求有效用户会话，支持 admin 限制。请求新增 `headers` 和精确 `rawBody: Uint8Array`，请求体上限 1 MiB。handler 第二个参数支持 `status(code)`、`header(name, value)` 和 `redirect(location, code)`；重定向默认 303。

外部回调声明 `auth: "external"`，必须提供 `verify(request)`。返回 true 才调用 handler；失败为 401。此时 `principal` 明确为 null，不借用浏览器已有登录身份。只有该路由免于宿主的浏览器 Origin 写入校验，Host 校验仍执行。OAuth 的一次性 state、过期、PKCE 和绑定用户保存在插件数据库，由 verify 原子消费；webhook 使用 rawBody 校验签名并自行防重放。

`http.callbackUrl(pluginId, path)` 使用配置的 Doca origin 构造绝对 URL，不读取请求 Host/Forwarded。OAuth 登录起点仍用默认会话路由。Cookie 请设置 HttpOnly、Secure（HTTPS）、SameSite 和最小 Path；不同插件使用各自 Cookie 名称。

```ts
await http.register(id, [{
  method: "GET", path: "/oauth/callback", auth: "external",
  verify: req => oauth.verifyAndConsumeState(req.query.state),
  async handle(req, res) {
    await oauth.exchangeCode(req.query.code);
    res.redirect("/mail", 303);
  }, {
  method: "POST", path: "/webhook", auth: "external",
  verify: req => webhook.verify(req.rawBody, req.headers),
  async handle(req, res) {
    await queue.acceptIdempotently(req.body);
    res.status(202);
    return { accepted: true };
  },
}]);
```

以上 oauth/webhook/queue 是插件自己的实现，不是 SDK 导出。外部回调提供者协议字段由插件校验。

### 文件与附件：`@doca/plugin-sdk/files`

插件通过 files.v1 上传/创建文件并保存 fileId；绑定写入必须拥有原文件写权限。安装插件只能写自己 ownerPlugin 命名空间的绑定。

注册 `permissions.v1` 授权器，pluginId 为插件 ID，resourceType 与 binding.ownerType 相同。宿主以 `(principalId, binding.ownerId, "file.read")` 调用授权器。邮箱实现将该动作映射为当前 mailbox.read，同时检查绑定对应业务记录仍有效。

调用 `files.content.read(context, {fileId, bindingId})` 可读取字节；`resolveContent` / `resolveDownload` 支持同一 bindingId，返回宿主 `/api/v1/plugin-file-bindings/<bindingId>/content` 地址。浏览器下载时宿主重新校验账号、绑定、当前注册的授权器和文件未删除状态。插件停用、撤销共享、解绑均不能继续下载。该路径不改变原文件 ACL；不传 bindingId 仍按原文件权限读取。

宿主文件服务是受控产品能力，不是开放数据库或对象存储路径。

### 用户与事件：`@doca/plugin-sdk/platform`

`users.list({after?, limit?})` 提供服务端分页校准，limit 默认 100、最大 500，按稳定用户 ID 返回 cursor；包含用户状态、资料和联系方式，不包含认证秘密。仅供可信插件服务器使用，禁止直接转发给浏览器。普通用户查找仍调用 users.search，遵守 all/related/none。

`events.read(after, limit)` 可读取持久事件。用户创建已移到创建事务内，覆盖密码、外部身份和联系方式注册入口；`user.created` 包含 userId。管理员启停和注册审核发出 `user.status.changed`（userId/status/previousStatus）；资料完成、更正和联系方式修改发出 `user.updated`（userId）。消费位置、重试和幂等保存到插件自己的数据库。后台发送及同步前检查当前账号和业务权限。

初次接入：先保存事件起点，再分页校准全部用户，最后重放起点之后的事件。校准过程中仍可能有变更，必须幂等重放并定期全量核对。当前宿主没有用户删除业务接口，不承诺未实现的删除前事件或异步删除阻塞协议。

用户关系投影保存在插件自己的数据库。registerDirectory 来源声明 schemaVersion: 1；related(principalId, {cursor, limit, signal}) 返回 {items, cursor}，items 是 {userId, relationId, revision}。verify(principalId, candidates, signal) 必须复核当前有效共享，并仅返回仍可见的 userId。每页最多 250 条、单次查询最多 40 页，总超时 2 秒；游标重复、超预算、超时、来源注销均丢弃该来源的候选。业务关系增量投影保存在插件自己的数据库，宿主不保存插件关系表。

### 搜索：`@doca/plugin-sdk/search`

`searchServiceToken` 的实际 ID 为 `search.v1`，提供 register、upsert、delete、rebuild、query。descriptor.pluginId 必须等于插件 ID。register 的 disposer 自动归属插件生命周期。查询上下文只包含 principalId 和 signal，不含宿主数据库；候选必须经 source.authorize 后才 hydrate。重建的 principalId 为 null，代表系统索引任务，不代表任意用户读取权限。

插件自行消费业务 outbox，幂等提交投影或删除。rebuild 从 source.projections 全量建立索引；禁用后来源注销，不可继续查询。查询必须通过宿主认可的请求上下文。已有搜索引擎配置需可用。当前接口支持插件自己的检索入口；全局搜索 UI 合并与 AI 自动检索插件来源不是已完成的承诺。

### 知识来源：`@doca/plugin-sdk/knowledge`

公开 knowledgeSourceRegistryToken（knowledge.sources.v1）以及配置、preview、pull、record/cursor 契约；来源 ownerPlugin 必须为本插件，注册随生命周期释放。知识契约包已纳入独立 JS/d.ts 构建，消除跨包源码导入。

注意：当前宿主的通用来源注册不等于知识库自动订阅已经接通。插件来源持久订阅、pull 调度、游标提交、撤权后的索引清理和知识 UI 还需单独实现验收；邮箱不能据此宣称已支持自动知识同步。

### Web：`@doca/plugin-sdk/web`

浏览器产物仍默认导出 `host => bundle`，React 必须使用 host.React。新增 host.useEnvironment() 获取响应式 locale/theme，host.navigate(path)、toast(message,tone)、confirm(message)、request(path,init) 及 FilePicker 组件。request 限于插件 apiBase，非成功响应抛出含 status/requestId 的错误。返回值应为 JSON（204 返回 null）。FilePicker 在页面里渲染，select 回调接收 file.id；调用方关闭组件。

宿主包装页面、设置、管理、AI 卡片、搜索结果、知识配置和文件选择贡献的 render，隔离同步及子组件渲染错误；异步事件错误仍由插件处理并提示。locale 变化只更新界面，不重建业务连接。插件自己维护 zh/en 文案。

### Mobile

首版仅承诺随 App 构建的原生插件：单独构建 Mobile bundle，注册到 MobilePluginRegistry，并显式接入 Expo Router 的路由和导航，随后重新构建发布 App。服务端 npm 安装不会运行下载来的原生 JS 或安装原生依赖。动态 WebView 方案尚未实现，不作为邮箱首版交付前提；尚未打包邮箱的客户端不显示邮箱入口。

## 验收边界

已经验证独立安装、外部回调的签名/状态拒绝与可信重定向、原始请求体、Host 约束，以及附件共享/撤销/原 ACL 不变。插件仍需自己的数据库恢复、邮件协议、OAuth 服务商、发送幂等与实际业务权限集成测试。宿主单元测试不能替代邮箱端到端验收。

## 本次验证

129 个测试文件通过，819 项通过、1 项跳过。SDK 已构建为 JS/d.ts，并通过仓库外独立安装及各公共入口导入验证；Web 构建通过。邮箱端需安装本次构建的包，不能继续使用之前缓存的 0.1.0 产物；当前未发布 npm。

本次本地构建包位于 Doca `.local/plugin-sdk-artifacts/2026-09-26/`，包含 plugin-sdk、plugin-contracts、files-capability、search-host、knowledge-capability、web-plugin-registry 六个 tgz。发布前在邮箱项目的 pnpm-workspace.yaml 为这六个 `@doca/<name>` 配置 overrides，指向对应 tgz 的绝对 `file:` 路径，再添加 SDK 依赖。这样传递依赖也来自同一批产物，不会访问尚未发布的 npm 版本或误用旧缓存。正式发布后移除本地 overrides，改用匹配的发布版本。
