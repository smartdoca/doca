# 邮箱插件接入交接（2026-09-26）

[English](plugin-mail-handoff.md)

本文件描述当前可用能力；不把目标规范等同于现有实现。邮箱侧原始需求见 `doca-mail/docs/PUBLIC_CAPABILITY_GAPS.md`，以本次边界决定修订该清单。

## 已确定的存储边界

Doca 不提供插件数据库、任意 SQL、键值业务存储或插件凭证仓库。插件自行管理当前数据库基线、事务、outbox、OAuth 凭证加密、队列租约、重试和消费游标。部署密钥从插件自己的环境配置或外部密钥管理器取得，不写入浏览器产物、普通配置或日志。

生命周期已经可用：`discover` 注册服务；`initialize` 每次启动连接当前基线数据库、校验结构并注册清理；`mount` 注册接口；`ready` 启动任务；`dispose` 停止并排空任务，关闭连接。结构不一致时在 `initialize` 拒绝启动，不执行转换。打开连接后立即注册 `context.effect(() => cleanup)`，保证后续启动失败也可清理；清理必须幂等。

插件安装目录与数据库目录分离。宿主升级、插件禁用和卸载不删除插件数据库。多实例任务抢占由插件实现。跨插件数据库和 Doca 文件服务没有共同事务：先持久化操作意图，使用幂等标识，失败时补偿，定期清理无引用附件。

## 当前可用的接口

### HTTP：`@doca/plugin-sdk/platform`

`httpServiceToken.register(pluginId, routes)` 的路径为 `/api/v1/plugins/<pluginId>/...`。默认路由仍要求有效用户会话，支持 admin 限制。请求新增 `headers` 和精确 `rawBody: Uint8Array`，请求体默认上限 1 MiB，可按路由指定 bodyLimit，最大 32 MiB。handler 第二个参数支持 `status(code)`、`header(name, value)` 和 `redirect(location, code)`；重定向默认 303。

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

宿主文件服务是受控产品能力，不是开放数据库或对象存储路径。文件/文件夹创建现已支持持久 idempotencyKey；绑定已有元组幂等。上传完成返回 contentIdentity，邮箱将它与稳定业务操作键保存到自己的 outbox，再调用创建。重启丢失 uploadId 时重新上传相同内容即可继续；completed 重放返回同一结果，异参为 409，删除/撤权后不会重建或继续返回历史结果。详见 [SDK 契约第 7.1 节](plugin-sdk-contract.zh-CN.md#71-文件创建持久幂等)。

```ts
const completed = await files.uploads.complete(ctx, { uploadId });
// 先在邮箱自己的 outbox 持久化 operationKey、目标目录、名称和 contentIdentity。
const file = await files.files.create(ctx, {
  uploadId: completed.id,
  folderId,
  name,
  idempotencyKey: operationKey,
  contentIdentity: completed.contentIdentity,
});
// 响应丢失或重启后的查询：
const receipt = await files.receipts.get(ctx, {
  operation: "file.create",
  key: operationKey,
});
```

回执不自动过期；pending 可以按原参数重试，completed 返回第一次结果快照。备用对象与中断临时文件已由宿主自动回收，和上传重试互斥并校验对象引用；邮箱侧仍保存自己的操作意图。

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

注意：当前宿主的通用来源注册不等于知识库自动订阅已经接通。宿主负责插件来源的知识订阅持久模型、pull 调度、订阅游标提交、撤权后的派生索引清理和知识 UI，仍需单独实现验收；插件负责账号、凭证、业务同步及授权事实；邮箱不能据此宣称已支持自动知识同步。

### Web：`@doca/plugin-sdk/web`

浏览器产物仍默认导出 `host => bundle`，React 必须使用 host.React。新增 host.useEnvironment() 获取响应式 locale/theme，host.navigate(path)、toast(message,tone)、confirm(message)、request(path,init) 及 FilePicker 组件。request 限于插件 apiBase，非成功响应抛出含 status/requestId 的错误。返回值应为 JSON（204 返回 null）。FilePicker 在页面里渲染，select 回调接收 file.id；调用方关闭组件。

宿主包装页面、设置、管理、AI 卡片、搜索结果、知识配置和文件选择贡献的 render，隔离同步及子组件渲染错误；异步事件错误仍由插件处理并提示。locale 变化只更新界面，不重建业务连接。插件自己维护 zh/en 文案。

### Mobile

首版仅承诺随 App 构建的原生插件：单独构建 Mobile bundle，注册到 MobilePluginRegistry，并显式接入 Expo Router 的路由和导航，随后重新构建发布 App。服务端 npm 安装不会运行下载来的原生 JS 或安装原生依赖。动态 WebView 方案尚未实现，不作为邮箱首版交付前提；尚未打包邮箱的客户端不显示邮箱入口。

## 验收边界

已经验证独立安装、外部回调的签名/状态拒绝与可信重定向、原始请求体、Host 约束，以及附件共享/撤销/原 ACL 不变。插件仍需自己的数据库恢复、邮件协议、OAuth 服务商、发送幂等与实际业务权限集成测试。宿主单元测试不能替代邮箱端到端验收。

## 2026-09-26 已有验证记录

以下是此前实现验证记录，本次需求文档调整未重新运行这些测试，也不代表完整邮箱 tgz 离线验收已通过。

129 个测试文件通过，819 项通过、1 项跳过。SDK 已构建为 JS/d.ts，并通过仓库外独立安装及各公共入口导入验证；Web 构建通过。邮箱端需安装本次构建的包，不能继续使用之前缓存的 0.1.0 产物；当前未发布 npm。

本次本地构建包位于 Doca `.local/plugin-sdk-artifacts/2026-09-26/`，包含 plugin-sdk、plugin-contracts、files-capability、search-host、knowledge-capability、web-plugin-registry 六个 tgz。发布前在邮箱项目的 pnpm-workspace.yaml 为这六个 `@doca/<name>` 配置 overrides，指向对应 tgz 的绝对 `file:` 路径，再添加 SDK 依赖。这样传递依赖也来自同一批产物，不会访问尚未发布的 npm 版本或误用旧缓存。正式发布后移除本地 overrides，改用匹配的发布版本。

## 调整后的接入需求与验收顺序

以下是待实施或待完整验收的要求，不是新增 SDK 导出。通用边界以 [SDK 契约第 7 节及第 13 节](plugin-sdk-contract.zh-CN.md) 为准。

| 分级               | 需求                           | 完成标准                                                                                                                      |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 已接入并验证       | 文件/文件夹创建持久幂等        | 同键并发、响应丢失及重启重试返回同一结果；异参冲突、权限复核、保留期限和故障恢复明确；插件邮件发送幂等仍独立负责              |
| 优先明确           | search.v1 与知识归属           | search.v1 是共享基础能力；插件内、全局、AI 入口独立启用。宿主管知识订阅和派生索引，插件管外部业务及授权事实                   |
| 交付门槛           | 实际 tgz 离线集成验收          | 仓库外使用宿主交付物、SDK、邮箱插件及完整依赖闭包；无源码链接、无未声明缓存、无包仓库访问；完成启动、Web 加载和业务端到端验证 |
| 交付基础           | 禁用、卸载、保留数据及当前基线 | 首次交付明确停任务、来源不可用、保留数据和数据库基线；结构不匹配时拒绝启动，管理 UI 可后置                                |
| 按产品承诺         | 外部知识自动订阅               | 若首版承诺邮件自动同步知识库，须交付持久订阅、调度、批次/游标一致性、重启恢复、来源删除及撤权立即不可检索；独立副本另行定义   |
| 按产品承诺         | 全局联邦搜索                   | 若首版承诺全局搜索邮件，须接通 endpoint、来源选择、排序分页、超时/部分失败、UI 和 renderer 降级；不自动开启 AI 来源           |
| 随账号删除功能     | 用户删除生命周期与异步清理     | 宿主持久协调撤权、插件清理确认及完成状态；覆盖停用/卸载/故障插件；超时不算成功，不采用分布式两阶段提交                        |
| 随移动端免发版需求 | 动态 WebView shell             | 短期一次性 ticket 兑换受限会话，限制来源/导航及最小原生桥；当前原生构建模式仍为首版边界                                       |

完整 tgz 验收需覆盖空插件、单插件及组合、缺失依赖、版本冲突、权限撤销、实例隔离、重试、重启恢复、禁用/卸载保留数据及数据库基线拒绝。外部邮件/OAuth 服务可使用测试服务；真实服务商测试由邮箱插件另行负责。测试只能使用隔离数据库、用户和文档，保留包版本、校验和、锁文件及测试结果作为验收证据。

后续增加默认插件数据目录（不托管数据库）、脱敏结构化日志、健康状态和最近任务错误、后台任务及 outbox backlog 管理页。任务状态通过插件公开接口提供，宿主不直读插件数据库。显式清除数据与卸载分离，需明确范围和确认；不得误删共享附件。

不做通用插件 SQL/data.v2、跨插件数据库分布式事务、默认开放所有来源给 AI，以及在原生进程动态执行 npm 插件代码。

## 通知补充

已公开 notificationsServiceToken（notifications.v1），提供幂等 publish 和 withdraw。插件注册业务资源的 notification.read 授权器，宿主在发布、展示、未读数和点击时复核；停用或撤权后隐藏。点击通过鉴权端点跳转站内 path。后台任务另可使用 users.status(userId) 即时复核账号状态。具体字段见插件开发规范；这不表示系统邮件或移动端推送已支持。

## 2026-09-27 文件幂等及包验证增量

文件/文件夹幂等已实现。相关 6 个测试文件、18 项测试通过，覆盖同键并发、异参冲突、复制、关闭数据库后重放、上传状态丢失、字节写入后提交失败恢复、插件作用域隔离、删除结果和账号停用。本轮文件改动的 TypeScript 检查及 SDK JS/d.ts 构建曾通过；最终复核时，同时变动的 knowledge/subscriptions.ts 出现 subscribeKnowledgeSource/persist 递归返回类型推断错误（TS7023），当前仓库类型检查未通过。当前全量结果为 131 个文件通过、1 个失败，839 项通过、1 项失败、1 项跳过；失败为 knowledge-records 中机器人成员检索已发布知识返回空列表，单独复跑亦失败，不能记为全量通过。

新 SDK 六包及当前邮箱 0.2.0 的实际 tgz、哈希和安装日志位于 `.local/plugin-sdk-artifacts/2026-09-27/`，此前同版本包必须替换。邮箱包取自现有 dist，未修改邮箱源码，也未宣称已接入新增幂等协议。首次离线安装发现依赖未缓存；随后联网准备了专用 pnpm store，再删除 node_modules，从空目录用 offline + frozen-lockfile 重装，56 包复用、0 下载。此验证使用明确准备的缓存，不能据此声称只靠六个 SDK tgz 即可完整离线部署；交付必须同时携带匹配锁文件和依赖 store。

`scripts/verify-mail-package.ts <安装目录>` 验证实际包扫描、启动、认证 status、Web JS 资源响应、关闭后禁用/重新启用，以及独立 mail.sqlite 保留。安装目录中的邮箱没有源码符号链接。验证运行宿主源码，尚不是宿主生产交付物的完全离线验收；没有浏览器渲染、真实收发、OAuth 提供商或附件 outbox 验收。

## 2026-09-27 邮箱 0.3.0 接入验收（最新）

本节覆盖前面的历史未完成记录。新增 notifications.v1、users.status、路由 bodyLimit；文件暂存对象已支持保守定时回收。插件目录可在 `.env` 设置 DOCA_PLUGINS_DIR；缺失、空白回退 `${DOCA_DATA_DIR:-./data}/plugins`，重启生效。

已接手相邻 doca-mail 并接入持久附件意图、文件夹/文件幂等、绑定授权、收件箱 UID 游标、通知 outbox 与深链接、发送去重及后台账号复核。数据库由插件自己管理，只接受当前空库基线；未知发送结果不自动重发。

实际邮箱 tgz 在仓库外安装，第三方依赖来自明确准备的离线 store，邮箱没有源码符号链接。隔离 IMAP/SMTP 端到端已覆盖收件、正文、并发附件导入和下载、发送重放、重启游标及通知恢复、账号撤权和禁用保留数据。浏览器已验证通知打开对应正文、侧栏入口和列表；修复了宿主模块导入时提前缓存插件导航的问题。

邮箱类型检查、构建和包校验通过，7 个测试文件、18 项通过；宿主插件专项 4 个文件、8 项通过。详细范围见相邻邮箱仓库 `docs/DOCA_CONTRACT_ACCEPTANCE.md`。不将本次使用宿主源码的验证描述为生产宿主交付物/Docker 完全离线验收，也未测试真实服务商 OAuth、真实邮件投递或数据库降级恢复演练。全局邮件搜索、自动知识订阅、用户删除协调和动态 Mobile 仍按产品承诺另行验收。

最终复核：宿主类型检查通过；134 个测试文件通过、882 项通过、1 项跳过；Web 构建通过。PDF 附件测试已改用有效文档并验证当前解析结果，搜索测试区分正常后台投影更新与全量重建，避免把后台更新误判为配置触发重建。实际邮箱包另通过无插件安装目录启动（模拟卸载）、保留数据后重新加载验证。所有验收均使用隔离数据。
