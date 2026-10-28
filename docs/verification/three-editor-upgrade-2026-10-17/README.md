# 三编辑器升级验收（2026-10-17）

Doca 主项目已适配 Slate 0.4.22、Slides 0.3.0-alpha.3，以及修复打包缺陷后的 Canvas 0.5.0。未发布、未部署，所有协作编辑使用临时账号、内存 SQLite 和临时存储，不接触用户文档。

## 安装与数据决定

- Slate 原有 DOCX 补丁内容不变，绑定到 0.4.22。codec、Yjs、headless 运行时代码与已安装 0.4.20 字节一致。
- npm Canvas 0.5.0 遗漏 Slate/纯文本编辑器注册，浏览器中可创建节点但无法打开文字编辑。AidCanvas 源码通过 `sideEffects` 声明保留两个注册模块。Doca 固定使用带 SHA-256 前缀的本地包，见 `vendor/README.md`（已移除的历史路径） 和 [审计结果](package-audit.json)。Docker 在依赖获取前复制该产物。
- 用户明确选择 Slides **只支持新文稿**。新文稿严格使用 `eppt-yjs-v6`，旧 v5 文稿和旧客户端拒绝接入，旧字节、增量、epoch、历史保留，不转换或改写编码。没有数据库结构变更。
- Canvas schema 1、Slate schema 3、Slides document schema 2、protocol 1 和原有 durable ACK/outbox 不变。Canvas 0.4.3 实际发布包生成的固定 checkpoint 在新包中原样恢复，查询/切只读不写入。

## 实际浏览器验证

Chrome 运行真实 Doca Web、服务端 WebSocket、资产服务和隔离数据库。

| 区域 | 已通过的浏览器操作 |
| --- | --- |
| Slate | 中文输入；图形标签全选替换；五页配色切换并应用；图形工作区取消/保存；思维导图设置、字号、节点增删；同账号双标签无回声；重载；只读预览与 60 秒无写入 |
| Canvas 宿主 | 思维导图及键盘子节点；原生文字编辑；富文本单元格与局部加粗；附件上传和宿主鉴权预览；图片上传；相对文字 presence 完整转发；双标签；checkpoint 重载；只读粘贴拒绝；SVG 下载内嵌已授权图片；60 秒零写入 |
| Canvas 全套 SDK | 222 项实际浏览器测试：便签/卡片/表格/容器、绘图、连线、对齐、图层选择、列表、样式、模板、剪贴板、撤销、资源错误/重试/取消、协作、只读与视口等。此套测试使用 SDK 源码；修复后的实际安装产物另由 Doca 宿主套件验证 |
| Slides 宿主 | 原生表格输入与 Tab、合并/拆分、整格加粗、插行；矩阵粘贴；撤销/重做；行高列宽鼠标拖拽；标题样式；字体搜索；字间距、独立文字边距；双标签与重载；只读；PPTX 下载后用真实解析器重导入；60 秒零写入 |
| 跨编辑器宿主 | 评论控件、区域评论、提及、弹层键盘行为、窄屏控件与空闲无写入回归 |

截图复核发现宿主 `.empty` 样式将 Slides 透明色芯片撑大；`surface.css` 已做局部重置，浏览器断言其尺寸不超过 28 × 28 px。正文投影与编辑器 DOM 均检查，导出不增加内容更新。

机器结果：[三编辑器](browser.json)、[Slides 补充交互](slides-native-browser.json)、[Slate 工作区回归](slate-regression-browser.json)、[宿主交互回归](interactions-browser.json)。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| Doca 20 个相关测试文件 | 161 通过，1 个原有条件用例跳过 |
| Doca 最终补充回归（含部署会话） | 22 通过 |
| Canvas SDK 浏览器 | 222 通过 |
| Canvas 模型/文字 presence | 30 通过 |
| Slate 包回归 | 53 文件 / 220 通过 |
| Slides 包回归 | 43 文件 / 198 通过，3 个 opt-in 集成用例跳过 |
| Doca TypeScript、生产构建 | 通过 |
| Canvas 库构建、应用/示例类型、lint | 通过 |
| diff 空白检查 | 通过 |

详见 [汇总 JSON](test-summary.json)。重跑入口：`node --import tsx scripts/qa-three-editor-upgrade.mts`、`node --import tsx scripts/qa-slides-native-upgrade.mts`。其他回归分别使用原有 `qa-slate-workspace-upgrade.mts` 和 `qa-editor-interactions.mts`，通过 `DOCA_QA_OUTPUT` 指定本次产物目录。

## 截图

![Canvas 宿主](canvas-host.png)

![Canvas 附件预览](canvas-attachment-preview.png)

![Slides 表格](slides-table.png)

![Slides 文字样式与边距](text-format.png)

![Slides 行列缩放](table-resize.png)

## 验证边界

未验证真实 Office/WPS 的视觉往返、全部系统输入法、生产网络/集群与外部 AI 服务，未构建/发布 Docker 镜像。Slides 表格仍是整格样式和纯文本；Canvas 富文本格式/媒体元数据仍是整字段 LWW，不承诺字符级格式 CRDT。Canvas 的通用业务富文本扩展 API 没有扩展 Doca 现有插件注册协议。已有历史读取/恢复辅助逻辑保持原路径，没有新增旧版数据转换。

恢复时保留原依赖、锁文件、补丁与产物；旧代码不保证理解新功能写入，不能用旧备份覆盖后续编辑。
