# 编辑器集成与文件交换

[English](editor-integration.md)

当前宿主 0.1.11 已接入五种编辑器。按安装包真实导出使用接口，目标能力与未实现项不能作为已有 API；详细职责见[接入参考](../skills/doca-editor-integration/references/integration.md)及[协同契约](collaboration-sdk-contract.zh-CN.md)。

## 已安装包与宿主适配

| 格式 | 当前安装包 | 宿主入口 |
| --- | --- | --- |
| 富文本 | @smartdoca/slate 0.4.13 | document-editor.tsx |
| Markdown | @smartdoca/markdown 0.4.3 | markdown-editor.tsx |
| 表格 | @smartdoca/sheet 0.2.0-rc.19 | spreadsheet-editor.tsx |
| 画布 | @smartdoca/canvas 0.4.2 | canvas-editor.tsx |
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
