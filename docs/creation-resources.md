# 插件模板与素材资源（SDK 0.1.5）

状态：源码已实现，未发布 npm 或部署；契约包 0.1.4。在线文档创建、插件公共客户端、宿主选择器和 AI 使用同一套资源服务。

## 本轮已确认的数据处理

移除管理员模板管理入口、旧 `/api/v1/templates` / `/api/v1/admin/templates` API、旧 `templateId` 创建字段和旧表 CRUD。`document_templates` 表、索引、定义和已有记录保持原状；没有迁移、删除、转换、双读双写，也没有将旧表注册为默认来源。未知旧字段明确拒绝。已创建文档保持自己的持久内容与素材。回退可使用上一版构建读取原表；新资源生成的文档仍是当前原生模型。

新宿主没有默认模板或素材提供者。只有在线文档消费者 `doca.documents.create`，没有邮箱/公众号等业务消费者。官方商城、企业库、网络服务或文件夹包装需要另装资源插件。本轮未实现商城远端协议、商城资源后台或官方内容。

## 服务与公共边界

从 `@smartdoca/plugin-sdk/creation-resources` 导入 `templatesServiceToken` (`templates.v1`)、`materialsServiceToken` (`materials.v1`) 及提供者/消费者类型。在 manifest 声明包含新增能力的最低 SDK 版本 `^0.1.5`，通过 `injections.required` 注入。轻量数据契约在 plugin-contracts；宿主业务服务在 core 的 creation-resources 模块。

- 模板：register / providers / tags / search / describe / read / registerConsumer / consumers / consume。
- 素材：register / providers / tags / search / describe / import。
- 服务端注册在 mount 中执行，返回 disposer，由 scoped lifecycle 自动持有；贡献 id 为 `${pluginId}.…`。零来源是正常情况。
- 服务按数据库 runtime scope 隔离，事务继承同一 scope。来源卸载/停止时释放贡献，不清理已消费文档和文件。
- 消费者声明消费契约和内容类型的精确版本组合、inputSchema 和 execute。模板消费者负责实际业务权限和副作用；宿主校验匹配、参数与账户状态。邮件发送/发布等动作由业务插件自己的授权流程处理。

消费者与内容分别描述版本：例如 `{contract:{id:'doca.document.rich_text',version:1}, contentType:{id:'doca.native.rich_text',version:1}}`。在线文档支持 rich_text、markdown、spreadsheet、canvas、presentation。契约均为 v1；presentation 原生内容类型为 v2，其余为 v1。自定义契约和内容类型使用插件命名空间，双方显式约定。相同扩展名不构成可消费保证。

## 提供者契约

提供者声明 id/pluginId/version:1/title/可支持 contracts/contentTypes/sorts；实现 tags、search、describe，以及模板的 read 或素材的 import。每次调用获得宿主身份 principal、requestId 和取消 signal。

`search` 入参是 contract/contentType/query/tags/providerId/sort/cursor/limit。提供者负责关键词匹配与所有标签的 AND 过滤、当前可发现权限及按指定排序返回轻量元数据；不得返回正文。`describe` 再次检查资源访问和 revision，隐藏/删除返回 null。标签也只能包含调用者可发现资源的标签。

卡片必须包含 ref `{providerId,id,revision}`、title、summary、tags、updatedAt、contract、contentType、parameters、license，模板必须提供 preview，素材的 preview 可选；usage、popularity 可选。preview 必须是模板实际样式的缩略图，不能使用通用图标代替，基础选择 UI 直接展示在卡片上，点击卡片立即放大查看，再按需加载原生内容预览。preview 只接受 PNG/JPEG/WebP data URL，编码后最多 180000 字符；远端服务由插件获取/校验预览后提供，不直接向浏览器暴露任意远端图像。parameters 使用 SDK 已有的 ObjectConfigSchema 子集，并非任意 JSON Schema；宿主拒绝未知 schema 字段，校验必填、类型、枚举与边界。基础 UI 支持简单输入，复合参数使用 JSON 输入；业务插件可以自建 UI。

标签包含稳定 id 和 `{zh,en}` 标题。公共标签用 `doca.tag.…`（如 `doca.tag.report` / `doca.tag.proposal`）；私有标签用插件命名空间。宿主按 id 去重，不按显示名称误合并。提供者应使用一致的公共标签文案，不能泄漏不可见标签。

## 排序与分页

每个来源必须支持 updated/name；可另声明 usage/popular。跨来源 updated 按时间降序，name 按名称排序，以 providerId/id 稳定打破平局，宿主归并有序流。usage/popular 只允许选择一个来源，数值由该来源定义，不宣称跨来源统一热度或宿主全局使用量。

UI 查询默认 24、最多 48 项；每次从来源读最多 24 项，正文按选中后读取。关键词/标签/类型/排序/来源变化重新开始。宿主不要求下载全目录再筛选。

宿主游标为实例内、不透明且绑定用户/规范化查询/来源集合的短期查询状态，15 分钟有效；过期、重启、来源变化后返回 410，需要重查，不承诺跨实例续页。最多 500 个未过期游标、100 个来源、每来源遍历 10000 项、单次聚合最多 100 次取页。每次来源调用 15 秒，搜索整体 30 秒预算。缓存候选在返回前调用 describe 复核访问和 revision；重复游标、重复资源、错序、异常来源报告 failures/complete:false，不用空结果掩盖失败。

这是一套 UI 浏览分页，不是冻结库存、同步删除清单或持久 change log。需要这些能力的提供者另行定义契约。本轮没有持久化资源目录镜像、统计表或资源升级迁移。

## 读取、素材导入与模板应用

模板 read 接收 `{ref,parameters}`，返回 `{contract,contentType,content,assets}`，最多 768 KiB。资源 revision 变化是冲突；不在旧 revision 下返回新内容。

素材 import 接收 `{ref,operationKey}`。提供者重新检查权限，通过 files.v1 导入或选取已授权文件，返回 `{fileId}`；远端导入必须把 operationKey 用作文件创建 idempotencyKey，上传使用 contentIdentity 和回执协议。同一次重试保持相同 key，不能拿临时 URL 作为长期引用。宿主再次检查 fileId 当前 ACL，向客户端返回 fileId/name/mime/size。

模板 assets 是最多 100 项 `{key,ref}`，ref 指向素材提供者。内容使用精确 `material:<key>` 字符串；Markdown 图片用 `](material:<key>)`。在线文档创建在写事务外获取并复核资源（插件可能调用其他数据库服务，不能在宿主写事务内调用），在事务内校验注册实例仍有效，再在新文档事务中建立宿主附件/文件引用，替换为本地 asset ID，校验权限、提及、大小和当前格式，初始化持久内容。任一初始化失败回滚新文档和其引用；提供者已经导入的用户文件保留，不作隐式删除。已有素材文件仍遵循其正常文件生命周期。

模板应用只初始化新资源，不覆盖已有文档、不修改协作协议。移除提供者后已绑定素材及已生成文档继续由宿主存储管理。原生预览支持无素材依赖模板；带素材依赖时使用提供者的预览图，预览不会隐式导入素材。

在线文档创建 HTTP：`POST /api/v1/resources` 可带 `template:{ref,parameters}`，与 markdown/initialContent 互斥。选空白时省略 template。`templates.consume` 的在线文档消费者输入为 title、可选 parentId/libraryId（根级省略），输出 id/title/format；普通创建仍用原资源创建入口。业务消费者可复用资源读服务或消费协议，自行保证业务操作幂等。

## 浏览器、插件与 AI

内部界面使用认证 `POST /api/v1/creation-resources/{templates|materials}/{operation}`；插件使用 `host.platform.templates` / `host.platform.materials`，后端沿用 `/api/v1/plugin-platform/{pluginId}/{operation}` allowlist 和 scoped WebView 身份通道。不存在任意 service dispatch；旧 host.request 仍只调用本插件 API。

宿主新增 `host.TemplatePicker` / `host.MaterialPicker`（与 FilePicker 同样注入宿主 React 组件）。TemplatePicker 接受 close/contract/contentType?/select(selection)/blank?；MaterialPicker 接受 close/contentType?/select(file)/accept?。选择器只负责选择和参数收集，实际消费由回调或业务 UI 完成。插件选择器实例使用本插件公共通道，不跨插件调用 ui.openView。

在线文档创建选择器固定提供空白创建，之后展示符合格式的全部插件模板、来源/关键词/标签/排序、加载更多、预览和参数。关闭选择界面不创建文档。没有来源或来源失败时仍可空白创建。上传/文件夹来源对话框增加素材库，选择后沿用业务现有上传/插入流程。

AI 使用 creation_resource_search / creation_resource_tags / template_describe / template_read / material_import；document_create 接受 template。模板创建保留原 AI 创建审批、资源范围与回执。素材 import 保留文件创建审批，返回稳定 fileId；它不是图片生成回执或 image_insert 的 assetId。业务模板通过对应插件工具消费。本轮没有模型语义搜索或新的 AI 公共执行服务。

## 验证

使用隔离数据库覆盖：零来源及旧表保留、旧路径拒绝、五格式初始化、素材权限和绑定、标签去重、排序归并与分页、来源异常、账户停用、revision 冲突、参数/消费者校验、插件归属/disposer、实例隔离及 HTTP 身份。SDK 构建与独立制品验证包括新子入口、公共客户端和 UI 类型。外部商城、企业服务和移动真机尚未联调。
