# 编辑器集成与文件交换

[English](editor-integration.md)

当前工作区已接入五种编辑器。按安装包真实导出使用接口，目标能力与未实现项不能作为已有 API；详细职责见[接入参考](../skills/doca-editor-integration/references/integration.md)及[协同契约](collaboration-sdk-contract.zh-CN.md)。

## 已安装包与宿主适配

| 格式 | 当前安装包 | 宿主入口 |
| --- | --- | --- |
| 富文本 | @smartdoca/slate 0.4.20 | document-editor.tsx |
| Markdown | @smartdoca/markdown 0.4.3 | markdown-editor.tsx |
| 表格 | @smartdoca/sheet 0.2.3 | spreadsheet-editor.tsx |
| 画布 | @smartdoca/canvas 0.4.3 | canvas-editor.tsx |
| 幻灯片 | @smartdoca/slides 0.3.0-alpha.2 | presentation-editor.tsx |

入口位于 [文档 feature](../apps/web/src/features/documents)。包负责模型、编辑命令、撤销、格式渲染、选择与转换；宿主负责身份、ACL、上传下载、引用、用户卡片、导航、评论和协同连接。语言只影响界面，不翻译用户正文，不重建编辑器。

## 引用、资源与查找

内部文档引用保存稳定 UUID 和 `#/r/{id}` 相对位置；提及保留用户 UUID，候选使用当前用户目录策略。引用及反向引用按当前阅读权过滤，引用本身不授予访问权。

图片、附件和素材使用宿主资源回调。上传进度、取消、错误和迟到回调需绑定原目标；下载通过 `assets/:id/content?download=1` 鉴权，不把物理存储地址当永久引用。

富文本与表格向实际安装包传入稳定的 `onAttachmentPreview` 回调。富文本提供 `AttachmentElement.path/name/mimeType`；表格原生行内附件提供 `event.node.refId/label`。宿主将资产 UUID 解析为鉴权内容端点，打开共用的 `DocumentFilePreview`，只读、历史及回收站视图也接入并保留各自访问参数。富文本编辑模式先点击选中，再点击或使用预览按钮打开；只读模式单击预览。表格点击原生附件标签触发预览，现有整单元格对象渲染仍可用。预览不修改模型、协同会话或持久化格式。

查找替换通过各编辑器的模型或原生能力完成。富文本使用宿主 Slate 模型适配；其他格式使用实际安装包提供的 find/replace 或原生面板。只读、断线及演示状态不提供正文替换。没有通用公开编辑器任意修改句柄，不承诺所有格式具有相同文本范围或正则能力。

## 文件导入导出

| 格式 | 导入 | 导出与限制 |
| --- | --- | --- |
| 富文本 | DOCX、Markdown、PDF | DOCX、Markdown、PDF；复杂布局可能简化，不支持旧 DOC |
| Markdown | Markdown、PDF（转换） | Markdown、PDF；不打包完整离线素材 |
| 表格 | XLSX | XLSX；不支持对象可降级并告警，不承诺完整 Office 保真 |
| 画布 | PNG/JPEG/WebP/SVG 图片素材 | PNG/SVG；导入不恢复原生图层 |
| 幻灯片 | PPTX（最大 30 MB） | PPTX；基础文字、图形、表格和图片，复杂母版/动画可简化，不支持旧 PPT |

导入创建新文档和新谱系，资产重新授权绑定；不覆盖正在编辑的文档。转换警告向用户展示。PDF 导出走浏览器/组件生成链路，不代表完整 Office 排版还原。实现见 [file-transfer.tsx](../apps/web/src/features/documents/file-transfer.tsx)，职责和验收见[文件交换契约](editor-file-exchange-contract.zh-CN.md)。

## 评论与业务扩展

永久锚点与在线光标不同。五种格式按各自协议提供内容评论；表格使用稳定行列 ID 与原生 capture/resolve/reveal 方法，校验结构变化与已删除目标。未知插件元素保留原有不透明数据并展示错误占位，不自动转换或删除。

模板、素材和文档元素由已安装提供者贡献，默认没有提供者。富文本原子行内和表格整单元格插件元素已实现，不提供通用块或表格浮动对象。见[元素契约](plugin-editor-elements.zh-CN.md)和[模板素材](creation-resources.zh-CN.md)。

## 验证范围

升级前核对安装产物的 README、导出类型和 schema；使用隔离文档验证真实文件往返、只读、素材授权、双页同步、回执和重载。不能从单个单元格测试推断全部表格操作收敛，也不能从构建通过推断设备验收完成。早期接入与验收记录保留在[研发资料](research.zh-CN.md)。

## 富文本图块与上传 — 2026-10-10

工具栏通过已安装 0.4.13 的 `commands.insertBlock` 插入完整流程图和思维导图元素，不用 `toggleBlock` 把段落变成缺少图数据的块。图块评论和 AI 引用使用现有整块锚点，不在图内标签里增加用户提及。上传适配器将实际已传输字节转成 `UploadContext.onProgress` 的 0–1 比例；服务端成功前不显示完成，保留原生占位、取消、重试和撤销流程。

AI 修改先读完整图块，不能从大纲标签重建。节点填充、边框、文字颜色分别用 `fillColor`、`color`、`textColor`；连线颜色、粗细用 `color`、`thickness`。自由端点按当前 SDK 使用空 source/target ID 与 `sourcePoint`/`targetPoint` 数值坐标，非空未知 ID 仍拒绝。修改 nodes、edges 或 mindData 时，在同一原生事务中使生成的 SVG 及派生边界失效；仅改显示宽度保留预览。不增加旧格式适配、自动转换或迁移，既有历史读取代码保持原样。

## 已发布表格包对接 — 2026-10-10

宿主 0.1.18 锁定 npm 制品 `@smartdoca/sheet` 0.2.0-rc.19。工具栏「数据验证」与「插入 → 下拉列表」分别使用各自入口。公开声明及 Yjs/model/XLSX 入口与 rc.18 字节一致；宿主继续使用已导出的菜单扩展、资源、稳定锚点和协作 API。宿主同步已导出的 `session.setReadOnly` API，模式切换后绘制前刷新能力快照，不重建工作簿或 Y.Doc。插件元素插入通过原生菜单扩展接入 `SPREADSHEET_MENU_PATHS.toolbarEnd`。这次仅对接界面与制品，不改变 codec、schema、epoch、outbox，不转换持久化数据或新增兼容行为。已有历史读取与显式宿主基线维护命令保持原规则。包与宿主回归使用隔离工作簿和文档，构建成功不代表全部表格操作已完成协作验收。

## Slate 与 Canvas 发布包接入 — 2026-10-13

宿主 0.1.23 锁定 npm 实际产物 `@smartdoca/slate` 0.4.14 与 `@smartdoca/canvas` 0.4.3。Slate codec/Yjs/headless/conversion 字节及公开入口映射不变，Canvas model/IO 字节及公开入口映射不变。DOCX 补丁绑定新版 Slate 产物。宿主保持稳定会话与资源回调，权限、presence、锚点、原始 checkpoint、epoch 和待确认消息 ID 的归属不变。包在视图中重绘过期图形预览，不产生内容写入。

用户明确选择不保证旧流程图兼容；不增加宿主旧节点适配、自动转换、历史字段回填或数据删除。新版图形、实心箭头几何、手动 routeMode/vertices 和端点锚点使用已发布的原生模型，AI 校验与手册接收并保留这些字段。旧编辑器不保证显示新字段，应保留旧部署及升级前备份；宿主数据库回退另按已审定的知识册存储流程执行。原有历史读取与规范化辅助代码仍在原路径，本次不重新设计它们。

隔离宿主回归覆盖原生字段校验、持久与重复 ACK、远端无回声、撤销重做、checkpoint 恢复、画板引擎单例注册及 DOCX 往返。浏览器及最终发行检查写入 0.1.23 验证附件；模型测试不代表已验收每个新版图形手势或全部画板操作。

Canvas 0.4.3 还包含用户已明确同意的视图规则：0.8 到 3 的数值文字行高按字号倍数显示，其他数值仍是像素。加载、选区、尺寸和空闲不回写模型，普通文字编辑保留原数值，仅用户显式修改行高时保存原生百分比值。不增加宿主迁移、回填或存量数据删除。浏览器验收验证 32 px 字号的 1.5 行高显示为 48 px、文字编辑后原数值保留、空闲零写入、双副本同步与重载；回退时不保证旧界面呈现。

## Slate 与表格包升级 — 2026-10-14

当前工作区锁定 npm 实际产物 `@smartdoca/slate` 0.4.15 与 `@smartdoca/sheet` 0.2.1。公开入口映射和依赖不变；Slate codec/Yjs/headless/conversion 字节不变，现有 DOCX 样式补丁绑定 0.4.15。AI 节点校验接收有限数值的 `angle`（度），编辑手册保留该字段。原生图片首次点击选中、再次点击预览，点击其他位置后重新从选中开始。

用户明确同意：CRDT 追加工作表（包括升级前追加的）及虚拟空恢复工作表采用默认行高 18 px、列宽 72 px。不可变 baseline 中已有工作表保留原尺寸字段，缺省字段也不回填；显式行列尺寸继续覆盖默认值。宿主新建工作表同样采用 18/72。此决定只改变投影及默认显示，不回写、转换或删除已有 seed、baseline、checkpoint、epoch、评论和待确认消息 ID。schema 6 与精确协议拒绝规则不变。既有最后工作表的虚拟恢复、历史读取和规范化辅助代码留在原路径，不重新设计。

延续此前已确认的不保证旧流程图兼容，不增加旧节点适配或字段回填。旋转使用已发布原生模型；旧编辑器可能忽略角度，旧表格包可能显示不同默认尺寸。保留上一版 registry 制品、依赖版本、补丁和锁文件用于包回退，服务端和 Web 一起更新；宿主数据库回退另遵循已审定的存储流程。

验收使用真实 rc.19 包生成的不可变样本、隔离宿主数据库和浏览器文档，覆盖原字节保留、已批准尺寸、旋转字段校验/ACK/无回声/撤销/恢复、稳定锚点、只读、文件往返及空闲选区零写入。制品审计及检查结果记录在 `docs/verification/editor-package-upgrade-2026-10-14/report.json`，源码升级记录见[待发布说明](releases/pending-editor-package-upgrade.zh-CN.md)。不据此声称全部图形手势、所有表格操作或原生设备已验收。

## 表格超链接补丁 — 2026-10-15

宿主 0.1.25 锁定实际 npm 制品 `@smartdoca/sheet` 0.2.2。与 0.2.1 相比，公开入口、依赖契约和类型声明不变，Yjs／model／XLSX 运行 JavaScript 字节相同（部分 source map 有差异）。超链接弹窗取消后正确恢复原生草稿，原生移除链接命令沿用 inlineLink 能力及只读检查。宿主继续使用稳定编辑器／会话、资源回调、原生操作和持久 ACK 队列。本补丁不改变 schema 6、不可变 baseline、epoch、checkpoint 或待确认更新身份，不增加数据转换或兼容适配；回退保留原依赖锁定及 lockfile。制品审计和隔离验证记录见 `docs/verification/sheet-package-upgrade-2026-10-15/`。

## 原生编辑器升级 — 2026-10-16

宿主 0.1.27 锁定实际 npm 制品 `@smartdoca/slate` 0.4.18 和 `@smartdoca/sheet` 0.2.3。入口及依赖契约不变，Slate codec/Yjs/headless/conversion 字节与 0.4.15 相同；原 DOCX 补丁内容不变，绑定到 0.4.18。宿主接收新增原生图形、节点／连线样式及可选 `canvasSettings`，AI 命令校验并保留这些字段。原生图示编辑采用新版工作区、纸张自动扩展、焦点草稿 Ctrl/Cmd+S 保存及浮动工具栏选择修复。

用户已明确同意新版 19.8／79.2 默认尺寸和图形行为。新建宿主文档、CRDT 追加工作表（含历史追加表）及虚拟恢复表采用行高 19.8／列宽 79.2 像素。不可变 baseline 原字段及其缺省状态保留，显式行列尺寸保留；不转换 baseline、seed、checkpoint、epoch、序号、待确认消息身份及单元格数据。打开旧图不改写原字段，缺省画布设置仅影响原生视图，明确保存图示才写入新版图形字段／设置。预览重绘仅更新视图。富文本 schema 3、表格 schema 6 和持久 ACK／outbox 语义不变；已有历史读取器及规范化器保留，不重新设计。

回退保留原依赖、lockfile、补丁和部署。旧编辑器可能显示不同默认尺寸／样式或忽略新增字段，不新增历史流程图兼容承诺。恢复时保留后续写入；恢复旧备份会丢失升级后编辑。包含真实已发布 0.1.26 数据库的隔离验证见 `docs/verification/editor-package-upgrade-2026-10-16/`。

## 思维导图工作区升级 — 2026-10-16

宿主 0.1.29 锁定实际 npm 制品 `@smartdoca/slate` 0.4.20，包含 0.4.19 的图形／媒体交互修复。公开入口、依赖和宿主组件／handle 声明不变；codec、Yjs、headless、conversion 运行时代码与 0.4.18 字节相同，原 DOCX 补丁内容不变并绑定到 0.4.20。AI 指导保留完整原生思维导图，包括 `structure`、`theme`、`background`、节点 `fontSize`／`bold` 和 `style:"underline"`。

用户已明确同意新版原生思维导图默认显示作用于已有文档。打开旧图或重新生成版本 6 预览只改变视图，不回写原节点、checkpoint、epoch 或待确认更新身份。工作区打开后不保存关闭不产生内容提交；明确保存才通过现有 Slate/Yjs outbox 与落库 ACK 提交原生草稿和预览。不迁移、不补写历史字段、不新增旧样式适配；现有历史读取及规范化辅助逻辑保留原路径，不重新设计。schema 3 与精确协议检查不变，没有 SQL 变更。

保留 0.1.28 部署、原包制品、版本锁定、补丁和 lockfile 供回退。旧编辑器可能忽略新样式／设置或显示不同默认值。恢复时保留后续写入；恢复升级前备份会丢失其后的编辑。测试只使用隔离的合成文档／数据库；范围及限制见 `docs/verification/slate-workspace-upgrade-2026-10-16/`。
