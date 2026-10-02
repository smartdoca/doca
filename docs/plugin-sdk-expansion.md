# 插件 SDK 公共能力与界面扩展重构

日期：2026-10-02。状态：A–D 首轮实现完成；源码 SDK 0.1.4。实际导出、位置和限制见 [已实现接口说明](plugin-extensions.md)。E/F 继续保留为后续目标，本文设计示意不是完整实现清单。

本轮只处理插件与 SDK。素材库、远端模板管理另行讨论。

## 1. 已对齐的范围与版本处理

用户已同意公共能力统一、多位置注册的方向，并明确当前两个个人自用插件只注册常规页面。采用新增方法、新增可选贡献集合的方式，不强制现有插件注册新能力。

当前源码 SDK 为 `0.1.3`，根项目为 `0.1.6`。旧文档里宿主镜像 `0.1.4` 是文档记录，不能据此认定部署实例版本。实际部署和两个独立插件的安装包需在集成验收时记录。

本轮明确采用：

- 现有页面、导航和已发布方法保持调用语义；没有新贡献集合，就没有该插件的新卡片、操作或视图。
- 新方法由新版宿主实现。使用新增方法的插件声明包含该能力的最低 SDK 版本；旧宿主按现有 SDK 范围校验拒绝，不增加私有接口适配或缺失方法回退。
- 新能力的实现者必须完整实现其声明的契约。“按需注册”不意味着服务内部可以缺方法却声称支持该版本。
- 保留当前导航 `schemaVersion: 1`、插件包声明和插件 `dataVersion`；当前设计不需要改变它们。
- 保留已有文档、附件、知识来源、用户关系和插件业务数据。不转换旧文档、不增加双读双写、不以卸载或清空数据解决升级。
- 首轮视图位置采用默认排序和已有导航布局，不新增卡片布局持久化。个人布局持久化如确需新表或配置形状，另列具体设计再确认。
- 回退使用上一版宿主及插件构建。新增只读 API 和运行时注册不改写已有数据；使用新能力的插件随宿主回退停用。新文档写入必须保持当前模型，不能因回退丢失内容。

仓库 [AGENTS.md](../AGENTS.md) 的兼容约定继续适用。若实施发现需要调整现有持久化结构、替换旧方法语义、转换模型或引入适配，先列明实际版本、存储形状、校验与回退，再取得具体同意。

### 已发现的现有行为

这些行为仅列入审计，不在准备阶段调整：

- 用户目录采用用户级管理员覆盖，再取系统设置；目前缺省目录值存在 `all` 回退。
- `users.get` 的公开资料投影中有 `publicId`、profile 和 profileRevision 的缺省处理。
- 导航会将超额入口移到更多、将尚未放置的插件入口补到更多，并在保存时过滤已不支持的位置。需在新 UI 中区分“未配置”和“明确隐藏”，不能无意改变现有行为。
- SDK 仍导出 `knowledge.sources.v1`；当前 `content.v1` 不自动适配它。本轮不删除旧来源。
- `docs/plugin-sdk-contract.md` 第 3、7 节与第 13 节对卸载数据保留的文字存在冲突。本轮不改卸载流程；发布前另核实实现并统一描述。

## 2. 架构与责任

```text
内部界面 / 插件界面 / AI 工具 / 授权后台任务
                  ↓
          公共应用服务与契约
                  ↓
      身份、系统策略、资源权限、业务校验
                  ↓
        内置提供方 + 插件提供方
```

SDK 提供公共类型、服务令牌和前端调用封装。宿主提供应用服务、鉴权和持久化。内部模块直接调用同一应用服务，HTTP 与插件注入是同一业务实现的入口。

内置模块使用同一种来源/贡献契约，但不要求变成可安装业务插件。插件提供方只能贡献自身关系、资源和业务能力，不能改写宿主目录策略或放宽资源权限。

公共业务类型应放在合适的契约包，SDK 再对外导出。避免宿主基础业务长期依赖 SDK 实现；也不一次性搬迁全部内部类型。先迁移真实复用的用户目录、文档读取与界面上下文类型。

所有注册拥有稳定 ID、归属、版本与 disposer，属于一个宿主实例和插件生命周期。来源停止或注册失败后释放贡献，不删除业务数据。

## 3. 当前实现清单

下表是源码调查结果，不等同于独立插件或真实设备验收。

| 能力 | 当前公开面与实现 | 本轮工作 |
| --- | --- | --- |
| 用户目录 | `users.v1` 有 get/status/list/search；SDK 搜索和宿主用户搜索共用 visibleUsers | 抽出公共用户目录服务，增加分页、批量解析和提交校验 |
| 交互关系 | permissions.v1.registerDirectory；related/verify；当前内置关系 SQL 在聚合器中 | 内置与插件共用来源注册和复核机制 |
| 文档纯内容 | content.v1 的 list/read/resolve/search，内置文档与文件来源 | 保持语义，继续给搜索、总结、分析使用 |
| 文档资源 | documents-capability 与服务端 adapter 有资源 CRUD、权限和协作类型 | 审计实际行为后通过公开 SDK 提供业务能力；不直接暴露内部协作适配 |
| 文档完整内容 | 内部恢复/读取与 AI 文档读取已有实现；公开 SDK 无完整快照入口 | 增加原生模型只读快照及支持能力声明 |
| 知识库结构 | 内部资源查询、知识服务已有实现 | 形成权限与发现策略一致的目录公共接口 |
| 文件 | files.v1 提供文件夹、文件、上传、绑定、内容和回执 | 复用现有服务，核对前端调用与批处理需求 |
| 资源权限 | 插件 authorizer 注册及 authorize；内置 ACL 与共享流程 | 补齐可执行操作查询，后续开放共享/邀请业务流程 |
| 搜索 | search.v1 与 content.v1 已有公开入口，职责不同 | 文档中明确索引查询与统一内容检索范围 |
| 最近访问、通知 | activity.v1 注册来源，notifications.v1 发布/撤回 | 复用来源聚合和当前权限复核，不另建插件数据库镜像 |
| AI | ai.v1 公开工具/技能注册 | 模型调用、任务执行另列契约，不能宣称已有公开执行 API |
| 事件 | events.v1 读取持久事件流 | 核实字段范围、消费权限、取消和后台执行身份 |
| 评论、引用、历史 | 内部有评论、引用与历史服务 | 逐项开放业务读写；永久锚点按编辑器实际支持范围声明 |
| Web 宿主 | React/request/navigate/toast/confirm/FilePicker/useEnvironment/native | 添加类型化公共能力客户端和展示容器 |
| Web 贡献 | routes/navigation/adminPanels/settingsFields/aiBlocks/searchResults/knowledgeSources/filePickers | 新增操作、视图及挂载位置，可选注册 |
| App | 受控 WebView、native 缓存和附件保存/分享 | 每个新位置显式声明实际支持，不能承诺原生动态代码 |

关键源码：

- [platform.ts](../packages/plugin-sdk/src/platform.ts)、[宿主平台提供方](../apps/server/src/plugins/platform.ts)、[安装插件作用域](../apps/server/src/plugins/scope.ts)。
- [目录策略与聚合](../packages/core/src/modules/discovery/directory.ts)、[现有用户搜索](../packages/core/src/modules/interactions/community.ts)。
- [文档能力契约](../packages/documents-capability/src/index.ts)、[文档宿主适配](../apps/server/src/plugins/documents-capability-adapter.ts)。
- [资源读取](../packages/core/src/modules/resources/reads.ts)、[资源查询](../packages/core/src/modules/resources/queries.ts)、[AI 文档读取投影](../packages/core/src/modules/ai/document-read.ts)。
- [Web 贡献注册](../packages/web-plugin-registry/src/index.ts)、[Web 宿主](../apps/web/src/plugins/web-host.tsx)、[导航](../apps/web/src/plugins/navigation.tsx)。

## 4. 用户目录与关系来源

### 4.1 调用语义

| 有效目录模式 | 行为 |
| --- | --- |
| none | 搜索其他用户返回空；读取自己走独立方法；不调用关系来源 |
| all | 搜索当前可展示的有效站内账户；不调用关系来源 |
| related | 调用全部有效内置/插件关系来源，复核并按用户 ID 取并集，再统一查询用户 |

管理员用户级覆盖优先于系统设置。普通插件不得传入 mode 强行改变策略。

服务统一管理展示字段、账户状态、过滤、去重、排序、分页和当前可选择性校验。发现某用户不代表可以读取完整资料或访问该用户的业务资源。

### 4.2 已新增调用方法

以下方法已在源码 SDK 0.1.4 导出：

```ts
users.me(context)
users.searchPage(context, { query, cursor, limit })
users.resolveDirectory(context, { ids })
users.validateSelection(context, { ids })
```

- me 返回调用者有权读取的自身资料；浏览器客户端只拿所需展示投影。
- searchPage 返回 `items`、`nextCursor` 和 `complete`。不返回过滤前总数。旧 search 保持当前结果数组与最多 20 项的语义，复用公共查询实现。
- resolveDirectory 用于已选 ID 的头像/名称展示，重新校验目录可见性；不是通过猜 ID 绕开搜索策略的资料读取。
- validateSelection 供真正提交共享、提及、指派等操作前验证。资源权限和各业务指派规则仍由对应业务服务校验。
- 当前 users.list 是可信服务端初始校准，可能返回完整资料且没有普通用户目录上下文；不可包装成浏览器“获取所有用户”接口。

分页游标绑定调用者、查询和有效模式；改变条件从第一页重新开始。每页重新校验当前策略和关系，不能拿历史候选集代替授权。目录搜索分页不承诺跨多次请求的全量稳定快照。

### 4.3 来源契约

优先复用已发布 DirectorySource 的 related/verify、关系 ID 和 revision。内置文档/文件关系提供方也进入同一注册机制。没有贡献的模块不注册。

聚合器负责调用、预算、来源隔离和去重；提供方负责自身关系索引、当前事实和撤销验证。只接受站内用户 ID，不把外部邮箱、文本中的名字或同域账户当成交互关系。

related 模式中来源失败或超限：该来源不给出未经完整验证的候选；新分页接口报告 `complete: false`，允许返回其他成功来源的结果，不称为全量。旧 search 不改返回形状，保持现有失败不扩大可见性的行为。

当前来源预算是每页 250、最多 40 页、单来源 2 秒。迁移注册实现时先保留实际预算；扩大预算和大规模关系查询优化另据测试决定，不能用无界扫描替代。

### 4.4 验收

- none/all 不调用任何关系来源；related 调用内置与插件来源。
- 同一用户来自多个来源只出现一次；统一过滤停用账户。
- 用户级覆盖、空查询、分页、同名用户和查询条件变化正确。
- 撤销关系、停止来源、来源异常、重复游标、超限不会扩大可见范围。
- 结果解析和提交再次校验，无法靠旧 ID 绕开策略。
- 宿主用户选择器、插件选择器和 AI 相关工具使用同一服务。
- 两个宿主实例不共享注册；来源 disposer 清理正确。

## 5. 完整文档与目录读取

### 5.1 与 content.v1 并列

完整文档是供处理工具使用的格式原生结构，不从纯文本反推。每种格式保留自身模型，模型转换和序列化由编辑器/codec 实现负责。

源码 SDK 0.1.4 已公开 `documents.read.v1` 与 `libraries.v1`；实际方法如下（目录每页沿用宿主 100 项，不接受 limit）：

```ts
documents.get(context, { documentId })
documents.readSnapshot(context, { documentId, expectedRevision? })
documents.capabilities(context, { documentId })
documents.references(context, { documentId })
libraries.list(context, { query?, cursor? })
libraries.children(context, { libraryId, parentId, cursor? })
libraries.path(context, { resourceId })
```

文件与文件夹使用现有 files.v1，不增设另一套存储。

### 5.2 快照契约

快照包含 documentId、format、codec、schemaVersion、内容修订、原生 content、素材引用。内容修订使用明确的 epoch/seq 或 codec 事实，不把 resource.version 当成正文版本。

服务端快照在只读事务内恢复已持久化完整内容和修订事实。文档变化与预期修订不符时报冲突；读取不生成正文事务、历史、ACK 或新 epoch。

不直接透出 Yjs 内部状态给普通处理插件，不要求插件加入协作会话才能读取正文。

完整响应须有大小限制；超限明确失败或走真实实现的快照下载接口。不能将 AI documentReadPayload 的字符截断当作完整读取。若采用分页下载，全部页必须对应同一快照且过期明确失败。

素材采用宿主稳定文件 ID 和授权读取，不把临时签名 URL 持久化，也不向普通插件返回存储密钥或物理路径。

当前编辑器上下文可另提供当前模型读取和选区快照，明确 `persisted` 与当前编辑状态；不能无声混合未确认修改。

### 5.3 目录契约

保留现有“可发现”与“可读取”的区分。知识库节点标题展示跟随现有知识库策略；打开正文仍检查节点权限。公共接口不能暗中扩大个人列表或搜索发现范围。

children 返回直接子节点与可执行操作；批处理通过分页遍历，正文按需读取。不把整个知识库递归正文打包为默认列表响应。

现有 documents-capability-adapter.list 先取 `limit * 4 + 1` 个候选再鉴权，若这一批大量不可见，可能返回 null 游标而遗漏后续可见记录。先用隔离测试复现并修正分页，再作为公共 API 基础。

搜索型分页每页复核；需要完整批处理清单时另提供绑定范围的一致性标识，变化或过期明确失败。未实现快照遍历前不宣称“完整稳定库存”。

### 5.4 文档写入的后续边界

先完成只读快照和目录，再开放能力声明对应的修改命令。写入进入当前宿主编辑/协作链路，检查当前身份、资源权限、策略和修订，保留撤销/历史语义。

公众号转换等独立导出默认读快照并生成输出；创建转换副本时新建资源，不把导入初始化接口用作已有文档的全量保存。

逐格式记录真实能力，暂不支持的返回明确状态。永远不以富文本选区、临时 A1 坐标或 DOM 偏移假装全部格式的稳定锚点。

实施按 [编辑器集成契约](editor-integration.md)、[协作契约](collaboration-sdk-contract.md) 和项目对应技能执行。若改动契约，同步其技能引用；只读服务不重写现有协作协议。

### 5.5 验收

- 各已支持格式原生模型完整读取、中文/图片/表格/公式/页面结构不被摘要化。
- 未授权、停用用户、回收站、源内容撤销按当前访问规则处理。
- 快照与修订原子配对；并发编辑导致明确冲突而非混合版本。
- 读取前后正文提交、历史、保存状态不变。
- 大量无权限候选之后的可见节点仍可分页到达。
- 目录发现规则和正文读取规则分别验证；附件重新鉴权。

## 6. 操作、视图与挂载位置

### 6.1 注册设计

WebPluginBundle 增加可选 `commands`、`views`、`placements`。没有这些字段的页面插件继续正常加载。先保持现有泛型上下文可用，避免增加必填类型字段迫使页面插件改代码。

```ts
// SDK 0.1.4 的关系示意；精确字段与支持位置见 plugin-extensions.md。
commands: [{ id, pluginId, title, supportedContexts, execute }]
views: [{ id, pluginId, title, supportedContexts, render }]
placements: [{ id, pluginId, slot, commandId?, viewId?, order, conditions }]
```

每个 placement 引用一个 command 或 view，不能两者都填；引用必须存在且归属匹配。一个操作可以放在多个位置，插件无需复制业务实现。

视图按容器调用，操作按用户触发执行。visible/conditions 只决定显示，不能代替服务端授权；支持声明式平台、格式、资源类型、选区类型和能力条件，不执行远端下发条件脚本。

宿主负责容器、排序、溢出、错误边界、加载状态、返回和取消。React 与现有组件生命周期由宿主统一；插件业务内容在其贡献中渲染。

### 6.2 位置与上下文

| 位置 | 注入上下文 | 展示 |
| --- | --- | --- |
| global.more / global.commands | 宿主平台、当前界面与用户展示信息 | 操作或页面导航 |
| home.cards / home.actions | 当前用户、宿主环境 | 卡片、快捷操作 |
| document.toolbar / document.menu | 文档 ID、类型、可执行操作 | 按钮、菜单 |
| document.sidebar / document.status | 文档上下文、取消信号 | 面板、状态信息 |
| document.selection / document.block | 实际支持的选区或块句柄 | 上下文操作 |
| editor.insert | 当前格式、合法插入上下文 | 内容插入操作 |
| library.toolbar / library.nodeMenu | 知识库、节点 ID 与权限 | 操作、节点菜单 |
| folder.toolbar / folder.rowMenu | 文件夹、文件引用与权限 | 操作、列表菜单 |
| resource.bulkActions | 选中资源集合、业务能力 | 批量操作 |
| resource.details | 资源类型和稳定引用 | 详情视图 |
| ai.results / search.results | 类型化结果和授权定位能力 | 结果视图及操作 |
| settings.extensions / appearance | 当前环境、设置权限 | 设置、主题预览 |

弹窗、抽屉、侧栏是容器，不为每个业务工具硬编码独立入口。已新增 `host.ui.openView({ viewId, presentation, context })`；presentation 为 dialog/drawer/sidebar；page 继续使用原 route。

上下文只携带明确 ID、能力与短期句柄，不默认包含全文、整个用户目录或全部知识库。真实内容通过公共 API 按需获取。

选区句柄绑定文档会话和实际格式。切换文档、关闭视图或取消后失效，迟到结果不能插入到新选区。

### 6.3 右上角更多

复用 web.more 导航槽位，采用应用图标和弹出面板。权限、平台、运行状态过滤后为空即不渲染。避免左侧和右上角同时显示相同更多入口；保留已有管理员导航范围。

导航入口与新命令入口明确去重键，不能仅凭标题去重。命令不自动成为独立页面；只有卡片的插件不被强制加入全局导航。

### 6.4 宿主前端 API 与移动端

现有 host.request 限定插件自身 API namespace。新增宿主公共客户端走明确的类型化服务通道；不把旧 request 的路径语义扩大到任意宿主 URL。

Web 服务和浏览器客户端保持同一权限语义。App 端沿用受控 WebView，先核实宿主公共调用如何走原生认证；不得复制浏览器 Cookie 或把 native bearer token 交给插件。

每个位置分别声明 Web/App 支持。尚未实现的移动原生位置明确不可用，不以 Web 编译通过代替设备验收。

### 6.5 外观

主题贡献优先覆盖颜色、字体、圆角、密度、背景与图标资源；限定主题作用域和变量，支持预览、应用与恢复。第一轮可用已有主题选择作为入口，不持久化未知配置形状。

任意全局 CSS/DOM 改写不作为默认公共契约。现有插件是可信代码，渲染错误边界不等于安全沙箱。

### 6.6 验收

- 仅有旧 routes/navigation 的插件仍正常加载，未注册的位置不出现。
- 卡片、操作和视图可以分别注册；一个操作多位置复用。
- 重复 ID、越权 namespace、缺失引用、非法位置注册失败并清理。
- render、事件、异步操作错误分别隔离；取消、关闭、切换文档不留失效操作。
- 弹窗、抽屉和侧栏遵循键盘焦点与返回行为，不重建编辑器。
- 更多为空隐藏，权限过滤正确，同一导航入口不重复。
- App 所宣称位置和身份通道在实际设备验证。
- 新界面文案遵循项目 i18n 技能与稳定英文 key。

## 7. 实施拆分与完成标准

| 批次 | 修改范围 | 完成标准 |
| --- | --- | --- |
| A 用户目录 | 公共契约、内置关系来源、聚合服务、SDK 方法、HTTP/内部选择器入口 | all/related/none、分页、复核、错误和生命周期完整验证 |
| B 真实内容 | 只读快照、资源目录分页修正、公开 SDK 导出、权限查询与浏览器客户端 | 多格式完整读取、目录遍历、当前权限和修订验证 |
| C 贡献注册 | registry commands/views/placements、上下文和容器、生命周期 | 仅页面插件与新贡献插件均正常工作，无必填注册 |
| D 页面接入 | 右上角更多、主页卡片、文档菜单和侧栏、目录操作 | 插件无需修改宿主路由即可展示和调用公共能力 |
| E 按格式扩展 | 选区、插入、文档修改、评论与历史、主题 | 每个开放能力有实际包接口、宿主实现与隔离验收 |
| F 其他公共模块 | AI 执行、事件范围、后台任务、共享邀请等 | 逐项形成契约与实现，不以盘点表声称已完成 |

每批按“契约 → 宿主服务 → SDK 导出/构建 → 内部调用 → 独立插件 → 文档状态”交付。

新增接口要同时检查：package.json exports/publishConfig、build-plugin-sdk 脚本、依赖闭包、作用域 namespace 检查、生命周期清理、宿主服务目录、README 与开发说明。仅添加 TypeScript 类型不算交付。

准备阶段不修改安装流程、不发布 npm 包、不操作两个现有插件业务数据。后续可先用临时独立示例插件验证注册与真实内容读取，再核验实际两个插件安装包。

## 8. 验证与状态记录

测试数据库、文档和安装目录必须隔离。独立插件验收使用构建后的 SDK JavaScript 与 .d.ts，不能依赖 @core/@web/@server 或源码链接。

准备阶段基线检查（2026-10-02）：

- `pnpm typecheck`：通过。
- `pnpm exec vitest run tests/plugin-platform.test.ts tests/plugin-sdk.test.ts tests/web-plugin-registry.test.ts tests/capability-documents.test.ts tests/plugin-content.test.ts`：5 个测试文件、32 项测试通过。
- 这些结果证明现有相关基线可用，不证明本文新增接口已实现，也不替代独立插件或设备验收。

实施后按范围运行相关集成测试、SDK 构建和 Web 构建。协作/编辑操作另按对应技能执行双端与断线验收；只读接口不因此改用户文档。

本文件作为本轮实施清单；`docs/plugin-sdk-contract.md` 继续是 SDK 总契约，已实现能力以其状态表、实际导出和验收记录为准。每完成一批再更新对应“已实现”状态，不能提前把本文拟议接口放进可运行开发示例。

实施验证（2026-10-02）：相关 11 个测试文件 68 项通过，SDK 和 Web 构建通过；构建后的公共 JavaScript/.d.ts 独立消费验证通过。隔离浏览器实例已验证主页卡片、更多、文档工具栏/菜单、侧栏与快照弹窗。源码版本 SDK 0.1.4 / contracts 0.1.3 / registry 0.1.2；未发布 npm、未部署、未操作两个现有插件的数据；移动仅验证 HTTP 会话边界。完整测试结果和后续边界见已实现接口说明。

完整检查：`pnpm typecheck`、`pnpm test`（162 个测试文件；1021 项通过、3 项跳过）、`pnpm build:plugin-sdk`、独立 SDK 消费验证、`pnpm build` 和 `git diff --check` 通过。Web 构建仍有原有大块与混合静态/动态导入提示。

## 9. 模板／素材会话协调：按最终实现接入

2026-10-02。与「梳理模板与素材库方案」会话对齐的实施约束。本节只记录公共基础和后续接入方案，不实现模板／素材，不授权旧模板存储或 API 的兼容处理。精确已实现接口见 [plugin-extensions.md](plugin-extensions.md)。

### 9.1 实际版本与已实现服务

源码宿主为 `0.1.6`，SDK `0.1.4`，`@smartdoca/plugin-contracts` 为 `0.1.3`，`@smartdoca/web-plugin-registry` 为 `0.1.2`。已通过构建后独立 JavaScript/.d.ts 消费验证；没有执行 npm 发布或部署验收。未来模板／素材方法需要随实现提升 SDK，并声明包含该方法的最低 sdkRange，不能仅依赖 `^0.1.4` 就声称获得尚不存在的服务。

| 当前可用 token | service ID | 模板／素材可复用部分 |
| --- | --- | --- |
| usersServiceToken | users.v1 | 自身资料、按系统策略搜索用户、解析及提交校验 |
| permissionsServiceToken | permissions.v1 | 插件业务授权贡献、可选用户交互关系贡献 |
| documentReadServiceToken | documents.read.v1 | 五种格式持久化原生快照、权限能力及引用读取 |
| librariesServiceToken | libraries.v1 | 知识库分页与路径 |
| filesServiceToken | files.v1 | 文件夹、文件、内容流、绑定和上传等既有公共能力 |
| contentServiceToken | content.v1 | 纯内容检索与知识订阅；不等同模板／素材目录 |
| httpServiceToken | http.v1 | 插件自己的认证 HTTP 入口 |

当前没有模板／素材资源注册服务、资源消费者服务、跨提供者标签聚合或资源排序服务。新 token 的名称和协议由模板／素材会话确定，需避开已有服务 ID；不要覆盖 users.v1/content.v1，也不要把内部 documents.v1 当作公开 SDK 的原生读取服务。

### 9.2 契约、宿主实现与归属

真实复用的描述、引用、分页和内容版本类型放在合适的公共契约包。轻量共用类型可以新增到 `packages/plugin-contracts/src/` 并从 index 导出；若要独立能力包，需要同时纳入 SDK 依赖和发布闭包。SDK 新增独立子入口，导出服务接口与 defineService token；内部模块不能依赖 SDK 的 Provider 实现，更不能让插件导入 @core/@web/@server/@db。

服务按稳定字符串 ID 查找，一个 service ID 对应一个宿主 Provider。多个资源提供者、消费者注册到该服务自己的贡献 registry，而不是各自 provide 同一个公共 token。插件自有服务使用自身命名空间。

已确认的后续产品边界：宿主提供空的资源注册／消费服务，默认没有资源提供者；插件可贡献模板／素材，也可实现消费者。官方商城只是提供者之一。资源消费契约、内容格式/schema 及各自版本必须分别声明，不能把相同文件扩展名视作可消费保证。服务名称、方法、消费者执行协议、参数 schema、标签公共标识和跨来源排序尚待该会话形成精确契约。

核心 modules 不得反向引用 workflows 或 server/Fastify。把资源业务校验放在合适的核心模块／应用层，HTTP 与 SDK 注入调用同一实现；文档创建等上层流程从外部编排它。注册资源服务不自动提供文档修改、AI 执行或邮箱业务实现。

### 9.3 注册、版本与生命周期

提供者和消费者应有稳定 id、pluginId、明确协议版本与 disposer。贡献 ID 属于 `${pluginId}.…`；引用携带提供者身份和资源稳定 ID，不能只按标题或远端 URL 去重。冲突、非法版本、归属不匹配或缺少声明的必需方法应拒绝注册，并撤回同一轮已注册贡献，不自动适配旧协议。

服务 registry 按宿主实例创建；若内部事务需要同一服务，沿用数据库 runtime scope 的继承机制。不要把 registry 或临时查询缓存放到 globalThis/Symbol.for；两个隔离数据库／宿主实例不共享贡献。这里“空资源服务”不得照搬目录 registry 自动添加内置来源的步骤。

目前 `scopeInstalledPlugin` 只对列出的公共注册服务自动执行归属检查并用 context.effect 持有 disposer。新增资源注册 token **不会自动获得这套处理**：实施时必须在 `apps/server/src/plugins/scope.ts` 为它增加明确的归属检查和生命周期包装，再由宿主提供方注册服务。异步注册沿用 effectAsync 并实际返回可释放句柄。释放贡献不删除私有业务数据；是否启用／停用仍按当前实例启动配置，不承诺热卸载。

SDK 版本、服务协议版本、内容 schema、资源 revision 和插件 dataVersion 各有不同职责，不能互相替代。模板／素材资源更新本身不要求修改插件私有数据库 dataVersion。

### 9.4 身份、权限与调用

当前服务端 PluginRequestContext 实际必填字段为 requestId/principal/signal，principal 包含宿主认证的 id/displayName/publicId/admin。不能把总契约中的未来 jobId/turnId 等字段当作当前必填导出。普通 HTTP 的身份来自宿主会话，输入不接受用户身份或管理员标志；后台消费的授权身份与权限复核还需业务任务契约，不凭一个持久化 userId 获得永久授权。

提供者对列表、标签、预览、取完整内容和实际消费分别检查当前业务权限和用户状态。宿主统一调用与校验，不能把已显示的候选或 UI conditions 当授权。标签目录只汇总当前用户有权发现的资源，不泄漏隐藏标签和过滤前总量。文件／文档读取继续使用各自宿主 ACL；对外输出稳定引用，不输出凭证、存储路径或默认持久化临时签名 URL。

若业务需要搜索用户，复用 users.searchPage/resolveDirectory/validateSelection，跟随 none/all/related；资源提供者没有权限修改目录模式。若要贡献实际业务交互关系，单独按 permissions.v1.registerDirectory 注册，不把“下载过同一模板”直接当作权限交集。

### 9.5 分页、排序、修订与取消

当前公共基础并非一套万能分页协议：用户目录分页绑定调用者/查询/有效模式，每页复核且有 complete；知识库分页每页复核，未冻结库存；content.v1 的完整清单要求同一 snapshot。原生文档 readSnapshot 使用 expectedRevision 检查完整持久化内容，不能拿目录游标或 metadata version 替代内容修订。

未来资源目录应明确绑定关键词、标签、消费契约/内容格式、排序和提供者范围；改变条件重新从第一页开始。列表只读元数据，选择后再取完整内容，并按明确 revision 校验。枚举用于库存核对、批量同步或删除判断时，必须单独定义一致快照和过期行为；不要把每页复核的 UI 浏览分页称作稳定全量清单。

提供者声明自己支持的排序方式。跨来源热度、使用量的可比较口径、稳定 tie-breaker、来源游标合并和来源失败后的排序语义仍是模板／素材设计，现有 registry 的 order 只是静态 UI 贡献排序，不能用于全局资源排名。每插件标签列表与公共标识去重也是新增业务能力，当前 SDK 没有通用标签服务。

每次提供者调用传 AbortSignal；提供者应停止网络请求和流读取。聚合器需定义可配置预算、超时、重复游标检查及来源失效规则。可以复用目录聚合的取消／隔离方式，但不能无条件复制它的 2 秒/40 页预算到远端素材。失败或部分结果必须可识别，不用空数组伪装全量完成。

### 9.6 Web 客户端与可复用 UI

已实现的 `host.platform` 只包含明确列出的 users/documents/libraries 和 files 元数据读取方法。新增资源服务应扩展类型化客户端和后端 allowlist，沿用 `/api/v1/plugin-platform/{pluginId}/{operation}`，复用认证/取消/no-store 处理；它不是按任意 service ID 动态分发的 RPC。旧 host.request 仍只调用插件自身 API namespace。

App WebView 目前允许本插件 namespace 的公共 POST 调用，继续受限会话和资源鉴权；没有向插件交付 native bearer token。扩展到非 JSON 内容或其他 HTTP 路径需明确范围，不能仅凭前端拿到 URL 就放宽移动会话。

已实现 commands/views/placements、dialog/drawer/sidebar，以及 Web 主页/文档/知识库/文件位置。资源提供方无需创建独立页面才能放入口；业务消费者可以复用这些位置和容器。原位视图随资源上下文卸载取消；打开的宿主面板拥有独立导航生命周期，关闭、路由切换或换面板取消。没有可用的编辑器选区/插入句柄或通用主题能力。

**当前没有公开 TemplatePicker 或模板选择方法。** 内部旧创建模板界面不是已发布的可复用宿主组件。已确认的在线文档基础模板选择 UI 应在模板会话实现后，按 FilePicker 的宿主注入模式新增公共组件及 props（例如名称待定的 host.TemplatePicker），或提供同等明确的专用宿主方法。这是建议的接入方向，不是 0.1.4 的现有导出。保留空白创建、按实际文档格式过滤、分批加载和关键词/标签查找；邮箱等业务仍由插件提供自己的消费者与 UI。

不要用 `host.ui.openView` 跨插件打开 `doca.…` 内置视图来模拟公共选择器：当前控制器只允许打开调用插件自己的已注册 view。复用宿主选择器应有正式组件/方法契约；插件也可以把该组件放在自己注册的 view 里。

### 9.7 service catalog、构建与交付

这里的 service catalog 指实际 SDK token/方法、宿主 Provider 和文档实现清单的一致性。**本轮没有导出动态 serviceCatalog.v1、运行时通用服务枚举或任意公共服务 dispatch API。** 文档中“公开服务目录已实现”不能据此推断存在这些方法。插件商店 catalog 也不是 SDK 服务目录。

新增子入口必须同步 SDK package.json 的 exports/publishConfig、实际生成 JavaScript/.d.ts、契约包 index、SDK 依赖闭包与 `scripts/build-plugin-sdk.mjs` 编译根。新增宿主 Provider 时核查 `platform.ts`/composition 的提供时机和 required injection；新增公共调用时更新 `client.ts`、PluginWebHost、`routes/plugin-platform.ts`，注册贡献还需更新 scope.ts。一个文件的类型定义不算可用接口。

完成时同步 SDK README、plugin-development、plugin-sdk-contract 中英文及实现状态清单；UI 文案遵循 doca-i18n。用独立制品检查依赖与 `.d.ts`，扩充 `scripts/verify-plugin-sdk.mjs` 对新子入口的消费；以隔离数据库、临时安装包和测试文档验证零提供者、多个来源、归属冲突、当前权限/撤权、游标失效、取消与 disposer、两个实例隔离和消费者真实执行。已有制品验证不是未来资源服务的验收。

### 9.8 文件分工与旧模板边界

模板／素材会话先独立维护方案与未来专属契约、服务、提供者/消费者模块，不重写本轮已完成公共基础。现在本轮没有继续修改代码的后台任务；后续正式实施时，公共文件需要追加接口，可以按上面检查清单集中修改，不需要私有替代通道。

应复用并谨慎增补的公共文件包括：

- `packages/plugin-sdk/src/{platform,web,client,documents}.ts`、SDK package.json 与 README；新增资源契约优先独立子入口，不把资源方法塞进 users/documents。
- `packages/plugin-contracts/src/index.ts`、`packages/web-plugin-registry/src/{index,extensions}.ts`；现有位置命名和 view 归属规则保持一致，不把公共选择器建成任意跨插件 view 调用。
- `apps/server/src/plugins/{platform,scope,composition}.ts`、`apps/server/src/routes/plugin-platform.ts` 及 create-app 的移动会话边界。
- `apps/web/src/plugins/{web-host,extension-ui,extensions}.tsx/.ts`、SDK 构建/独立消费验证脚本、公共开发与契约文档。

暂不改变本轮用户目录策略、文档原生 codec/协作链路、content.v1 快照语义、files.v1 存储和附件授权；不要为模板提供方增加私有表查询或全局桥接。涉及创建/插入的实施须遵循实际编辑器和协作契约，不能直接重写已有文档状态。

后续模板会话已获得用户明确同意：移除旧模板 API、管理员模板 UI 和 templateId 创建路径，保留 `document_templates` 表定义、索引与历史数据，不删除、迁移、自动转换、双读双写，也不把旧表注册成默认提供者。当前实施状态见第 10 节与资源契约。

## 10. 创作资源后续实施

2026-10-02：本会话按第 9 节对齐规范新增 SDK 0.1.5 / contracts 0.1.4 的模板与素材服务，准确状态与旧库退役边界见 [creation-resources.md](creation-resources.md)。此前 A–D 的 SDK 0.1.4 验收记录保持原义。
