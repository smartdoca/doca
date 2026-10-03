# 插件模板与素材资源（SDK 0.1.6 源码）

状态：源码已实现，未发布 npm 或部署；契约包 0.1.6 源码。在线文档创建、插件公共客户端、宿主选择器和 AI 使用同一套资源服务。

## 本轮已确认的数据处理

移除管理员模板管理入口、旧 `/api/v1/templates` / `/api/v1/admin/templates` API、旧 `templateId` 创建字段和旧表 CRUD。`document_templates` 表、索引、定义和已有记录保持原状；没有迁移、删除、转换、双读双写，也没有将旧表注册为默认来源。未知旧字段明确拒绝。已创建文档保持自己的持久内容与素材。回退可使用上一版构建读取原表；新资源生成的文档仍是当前原生模型。

新宿主没有默认模板或素材提供者。只有在线文档消费者 `doca.documents.create`，没有邮箱/公众号等业务消费者。官方商城、企业库、网络服务或文件夹包装需要另装资源插件。本轮未实现商城远端协议、商城资源后台或官方内容。

## 服务与公共边界

从 `@smartdoca/plugin-sdk/creation-resources` 导入 `templatesServiceToken` (`templates.v1`)、`materialsServiceToken` (`materials.v1`) 及提供者/消费者类型。在 manifest 声明包含当前修订的最低 SDK 版本 `^0.1.6`，通过 `injections.required` 注入。轻量数据契约在 plugin-contracts；宿主业务服务在 core 的 creation-resources 模块。

- 模板：register / providers / tags / search / retrieve / describe / read / registerConsumer / consumers / consume。
- 素材：register / providers / tags / search / retrieve / describe / import。
- 服务端注册在 mount 中执行，返回 disposer，由 scoped lifecycle 自动持有；贡献 id 为 `${pluginId}.…`。零来源是正常情况。
- 服务按数据库 runtime scope 隔离，事务继承同一 scope。来源卸载/停止时释放贡献，不清理已消费文档和文件。
- 消费者声明消费契约和内容类型的精确版本组合、inputSchema 和 execute。模板消费者负责实际业务权限和副作用；宿主校验匹配、参数与账户状态。邮件发送/发布等动作由业务插件自己的授权流程处理。

消费者与内容分别描述版本：例如 `{contract:{id:'doca.document.rich_text',version:1}, contentType:{id:'doca.native.rich_text',version:1}}`。在线文档支持 rich_text、markdown、spreadsheet、canvas、presentation。契约均为 v1；presentation 原生内容类型为 v2，其余为 v1。自定义契约和内容类型使用插件命名空间，双方显式约定。相同扩展名不构成可消费保证。

## 提供者契约

提供者声明 id/pluginId/version:1/title/可支持 contracts/contentTypes/sorts；实现 tags、search、describe，以及模板的 read 或素材的 import。每次调用获得宿主身份 principal、requestId 和取消 signal。

`search` 入参是 contract/contentType/query/tags/providerIds/sort/cursor/limit。query 最多 1000 字符。提供者负责关键词匹配与所有标签的 AND 过滤、当前可发现权限及按指定排序返回轻量元数据；不得返回正文。`describe` 再次检查资源访问和 revision，隐藏/删除返回 null。标签也只能包含调用者可发现资源的标签。

卡片必须包含 ref `{providerId,id,revision}`、title、summary、tags、updatedAt、contract、contentType、parameters、license，模板必须提供 preview，素材的 preview 可选；usage、popularity 可选。preview 必须是模板实际样式的缩略图，不能使用通用图标代替，基础选择 UI 直接展示在卡片上，点击卡片立即放大查看，再按需加载原生内容预览。preview 只接受 PNG/JPEG/WebP data URL，编码后最多 180000 字符；远端服务由插件获取/校验预览后提供，不直接向浏览器暴露任意远端图像。parameters 使用 SDK 已有的 ObjectConfigSchema 子集，并非任意 JSON Schema；宿主拒绝未知 schema 字段，校验必填、类型、枚举与边界。基础 UI 支持简单输入，复合参数使用 JSON 输入；业务插件可以自建 UI。

标签包含稳定 id 和 `{zh,en}` 标题。公共标签用 `doca.tag.…`（如 `doca.tag.report` / `doca.tag.proposal`）；私有标签用插件命名空间。宿主按 id 去重，不按显示名称误合并。提供者应使用一致的公共标签文案，不能泄漏不可见标签。

## 排序与分页

每个来源必须支持 updated/name；可另声明 usage/popular。跨来源 updated 按时间降序，name 按名称排序，以 providerId/id 稳定打破平局，宿主归并有序流。usage/popular 只允许选择一个来源，数值由该来源定义，不宣称跨来源统一热度或宿主全局使用量。

UI 查询默认 24、最多 48 项；每次从来源读最多 24 项，正文按选中后读取。关键词/标签/类型/排序/来源变化重新开始。宿主不要求下载全目录再筛选。

宿主游标为实例内、不透明且绑定用户/规范化查询/来源集合的短期查询状态，15 分钟有效；过期、重启、来源变化后返回 410，需要重查，不承诺跨实例续页。最多 500 个未过期游标、100 个来源、每来源遍历 10000 项、单次聚合最多 100 次取页。每次来源调用 15 秒，搜索整体 30 秒预算。缓存候选在返回前调用 describe 复核访问和 revision；重复游标、重复资源、错序、异常来源报告 failures/complete:false，不用空结果掩盖失败。

这是一套 UI 浏览分页，不是冻结库存、同步删除清单或持久 change log。需要这些能力的提供者另行定义契约。本轮没有持久化资源目录镜像、统计表或资源升级迁移。

## 读取、素材导入与模板应用

模板 read 接收 `{ref,parameters}`，提供者返回 `{contract,contentType,content,assets}`，最多 768 KiB；宿主结果附加 source。资源 revision 变化是冲突；不在旧 revision 下返回新内容。

素材 import 接收 `{ref,operationKey}`。提供者重新检查权限，通过 files.v1 导入或选取已授权文件，返回 `{fileId}`；远端导入必须把 operationKey 用作文件创建 idempotencyKey，上传使用 contentIdentity 和回执协议。同一次重试保持相同 key，不能拿临时 URL 作为长期引用。宿主再次检查 fileId 当前 ACL，向客户端返回 fileId/name/mime/size/source。

模板 assets 是最多 100 项 `{key,ref}`，ref 指向素材提供者。内容使用精确 `material:<key>` 字符串；Markdown 图片用 `](material:<key>)`。在线文档创建在写事务外获取并复核资源（插件可能调用其他数据库服务，不能在宿主写事务内调用），在事务内校验注册实例仍有效，再在新文档事务中建立宿主附件/文件引用，替换为本地 asset ID，校验权限、提及、大小和当前格式，初始化持久内容。任一初始化失败回滚新文档和其引用；提供者已经导入的用户文件保留，不作隐式删除。已有素材文件仍遵循其正常文件生命周期。

模板应用只初始化新资源，不覆盖已有文档、不修改协作协议。移除提供者后已绑定素材及已生成文档继续由宿主存储管理。原生预览支持无素材依赖模板；带素材依赖时使用提供者的预览图，预览不会隐式导入素材。

在线文档创建 HTTP：`POST /api/v1/resources` 可带 `template:{ref,parameters}`，与 markdown/initialContent 互斥。选空白时省略 template。`templates.consume` 的在线文档消费者输入为 title、可选 parentId/libraryId（根级省略），输出 id/title/format；普通创建仍用原资源创建入口。业务消费者可复用资源读服务或消费协议，自行保证业务操作幂等。

## 浏览器、插件与 AI

内部界面使用认证 `POST /api/v1/creation-resources/{templates|materials}/{operation}`；插件使用 `host.platform.templates` / `host.platform.materials`，后端沿用 `/api/v1/plugin-platform/{pluginId}/{operation}` allowlist 和 scoped WebView 身份通道。不存在任意 service dispatch；旧 host.request 仍只调用本插件 API。

宿主新增 `host.TemplatePicker` / `host.MaterialPicker`（与 FilePicker 同样注入宿主 React 组件）。TemplatePicker 接受 close/contract/contentType?/select(selection,resource)/blank?，第二个回调参数是带 source 的完整卡片；MaterialPicker 接受 close/contentType?/select(file)/accept?，选择结果包含 source。选择器只负责选择和参数收集，实际消费由回调或业务 UI 完成。插件选择器实例使用本插件公共通道，不跨插件调用 ui.openView。

在线文档创建选择器固定提供空白创建，之后展示符合格式的全部插件模板、来源/关键词/标签/排序、加载更多、预览和参数。关闭选择界面不创建文档。没有来源或来源失败时仍可空白创建。上传/文件夹来源对话框增加素材库，选择后沿用业务现有上传/插入流程。

AI 使用 creation_resource_providers / creation_resource_retrieve / creation_resource_search / creation_resource_tags / template_describe / template_read / material_import；document_create 接受 template。模板创建保留原 AI 创建审批、资源范围与回执。素材 import 保留文件创建审批，返回稳定 fileId；它不是图片生成回执或 image_insert 的 assetId。业务模板通过对应插件工具消费。宿主不实现搜索引擎或语义模型；检索交给来源的 retrieve。

## 验证

使用隔离数据库覆盖：零来源及旧表保留、旧路径拒绝、五格式初始化、素材权限和绑定、标签去重、排序归并与分页、来源异常、账户停用、revision 冲突、参数/消费者校验、插件归属/disposer、实例隔离及 HTTP 身份。SDK 构建与独立制品验证包括新子入口、公共客户端和 UI 类型。外部商城、企业服务和移动真机尚未联调。

## 多来源与 AI 检索修订（2026-10-02）

用户已明确同意将查询旧单值 `providerId` 改为 `providerIds`。旧字段在服务、HTTP、公共插件客户端和 AI 工具中明确拒绝，不做适配或隐式转换。资源引用 `{providerId,id,revision}` 不变，模板参数、文件、文档、插件业务数据及旧 `document_templates` 表均不迁移或删除。没有来源偏好的持久化改造。回退构建须一并回退查询客户端；游标是实例内状态，重启或来源变化需重新查询。

一个提供者对应一个来源，`id` 是稳定身份，`title` 是插件声明的名称，可附带中英文 `description`（各最多 1000 字符）。同一插件可注册多个来源，Doca 不按网络、商城或生成分类或推断实现。省略 providerIds 查询全部符合类型的来源，[] 查询零来源；多个 ID 按 OR，与类型/标签按 AND。未知或卸载 ID 返回 404，绝不扩大范围。来源发现、列表、标签和检索共用这个选择；游标绑定去重排序后的来源集合。热度/使用量要求明确指定唯一来源。

宿主列表与 describe 返回 `CreationResourceResult`：原卡片加上宿主生成的 `source:{id,pluginId,title,description?}`。插件不能伪造来源。模板 read 与素材 import 的宿主结果也带 source，提供者自身的 read/import 返回协议不变。来源元数据是当前注册信息，不写入资源或文档内容。界面展示来源名称、说明及卡片来源标识。

`templates.retrieve` / `materials.retrieve` 接受：

```ts
{
  query: "找一份适合向管理层汇报季度经营情况的模板", // 非空，最多 1000 字符
  providerIds: ["example.templates.web", "example.templates.company"], // 可省略
  contract: {id: "doca.document.rich_text", version: 1}, // 可选
  contentType: {id: "doca.native.rich_text", version: 1}, // 可选
  tags: ["doca.tag.report"], // 可选，AND
  mode: "auto", // auto | keyword | semantic | hybrid，默认 auto
  topK: 8, // 默认 8，最多 20
}
```

提供者显式声明 `retrieval:{modes:["keyword","hybrid"]}` 并同时实现 `retrieve(context,input)`。auto 由提供者选择已声明模式并返回实际 mode；明确请求一种模式不得偷偷降级。不声明能力的来源返回 unsupported，不调用 search 遍历代替检索。提供者可使用数据库索引、Meilisearch、向量检索或远端 API；Doca 不维护其索引、模型、密钥或业务同步。

提供者 retrieve 返回 `{items,mode,hasMore}`。items 按本来源相关性排序，包含 ref/title/summary/tags/contract/contentType，可有 matchText（最多 500 字符），不得带正文、缩略图或参数 schema。宿主核验来源、类型、标签、重复 ID、当前权限及 revision，再附加 source 和来源内部 rank。摘要与匹配说明是数据，不是 AI 执行指令。

一次每个所选来源最多调用一次 retrieve，无游标遍历。单来源最多取 topK，多来源每个最多取 min(topK,5)。最多 4 个来源并发、整体 15 秒预算、每来源响应最多 100000 字节。跨来源按本地 rank 与稳定 ID 均衡展示，不比较不同引擎分数，也不声称统一全局相关性。最终不超过 topK 项；sources 记录成功来源、实际模式、候选数和是否还有候选。failures 用稳定 unsupported/failed/timeout 代码报告失败来源。complete 表示所选来源是否均成功，truncated 表示有未展示候选；空结果不扩大来源范围。

基础选择器提供关键词搜索和智能搜索；空查询继续分页浏览。智能搜索展示有限候选并按需获取卡片预览，不自动导入素材。失败来源和结果上限明确提示。来源可多选或清空，标签仅来自所选来源。两类选择器接受 providerIds 初始选择及 onSourcesChange 回调（undefined 表示全部，[] 表示无来源），插件可把用户选择传给自己的 AI/业务查询。

AI 先用 creation_resource_providers 按名称解析来源 ID，再用 creation_resource_retrieve 传关键词或完整需求句。两类资源共用工具和当前身份。AI 的检索结果没有缩略图，浏览工具还移除参数 schema；选中后用 describe/read/import 取详情。检索测试覆盖来源排除、空结果、不支持、失败、取消、权限复核、游标绑定、HTTP、插件公共通道与实际 AI 工具调用。
