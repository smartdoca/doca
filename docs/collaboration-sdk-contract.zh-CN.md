# Doca 编辑器协同接入契约

[English](collaboration-sdk-contract.md)

适用：富文本、Markdown、在线表格、画布、幻灯片及未来文档类型。初始约定日期为 2026-09-11，下方实现增量保留各自日期与版本；已安装包见[当前编辑器矩阵](editor-integration.zh-CN.md)。

目标：平台维护一套连接、权限、增量存储、落库确认、重连和在线会话逻辑；组件负责各自的数据模型和渲染。统一行为不意味着把 Excel 强制转换成富文本数据结构。

## 1. 分层与版本

| 层/字段                        | 统一职责                               | 组件差异                                        |
| ------------------------------ | -------------------------------------- | ----------------------------------------------- |
| 传输                           | 同源 WebSocket、统一信封、服务端认证   | 无                                              |
| 保存                           | 本地增量 → outbox → 数据库提交 → ACK   | 无                                              |
| format / codec / schemaVersion | 标识类型和数据结构兼容性               | 富文本节点 CRDT；表格稳定行列/单元格命令        |
| epochId                        | 同一 CRDT 数据谱系，不兼容重建时才改变 | 表格另需与 epoch 绑定的不可变 workbook baseline |
| seq                            | 当前 epoch 中有效提交的单调序号        | 无                                              |
| checkpointSeq                  | 完整 Yjs checkpoint 已覆盖的提交序号   | 不得删除组件仍需回放的逻辑命令                  |
| resource.version               | 业务元数据乐观锁                       | 不用于 Yjs 合并                                 |
| 历史版本 ID                    | 用户查看/回滚的业务快照                | 不等于每个网络更新                              |
| state vector                   | 同步差异摘要                           | 不是完整保存确认，尤其不覆盖删除集合的确认语义  |

当前各格式协同使用 epochId 表示谱系；定期保存 Yjs checkpoint 不改变 epoch。表格只使用当前 Yjs session 与 checkpoint sequence。

## 2. 平台与组件边界

平台：一个页面一个实时会话，socket、ACL、增量队列、ACK、重连、业务快照、评论、通知、资产权限。组件不再自行开启另一套 HTTP autosave 或 socket。

组件：一个文档会话只创建一次 Y.Doc 和编辑器；本地内容操作映射到 Yjs，远端事务投影到视图；提供 readiness、错误、格式状态、选区和锚点接口。修改 props、只读状态、光标、尺寸、保存提示都不能重建共享文档。

后端可将格式差异收敛在 codec 插件：
初始化、验证合并结果、生成业务投影、导入导出、历史回滚。通用房间/权限/存储流程不理解工具栏或单元格 DOM。

## 3. 统一消息与生命周期

建议公共信封：

- protocolVersion: 1。
- type、id（消息 ID）、room（资源 UUID）、epochId。
- 初次 join 可不带 epochId，服务端返回后，后续写入必须携带。
- 身份、sessionId、用户名和颜色由服务端决定，不能信任客户端自报值。

1. join：提供支持的 codec/schemaVersion、已知 epoch 和 vector。
2. sync-response：返回 epochId、codec、schemaVersion、seq、checkpointSeq、rank、update、vector；Excel 额外返回原子绑定的不可变 baseline。
3. 校验基线、补齐 Yjs、完成视图投影后才进入 ready，不先展示可编辑空文档再覆盖。
4. update：id、room、epochId、Yjs bytes（现有 JSON 通道用 base64）。只传实际本地内容增量。
5. ack：相同 id、epochId、提交后的 seq，可附 changed 和业务元数据。事务提交之后才发，不是“已收到数据”。
6. 有效更新广播给其他仍有权限的会话；远端应用不能回声生成本地写入。
7. sync-request / sync-response：只补拉差异，不是 ACK。不能清空未确认队列，也不能每次补拉后无条件上传。
8. leave / 断线清除本会话选区；鉴权、epoch、schema 错误明确区分，不一律当普通网络重试。

同一次未确认写入，重试保持原始 bytes 和消息 ID。Yjs 合并必须幂等，重复投递不增加 seq、审计、通知或历史。当前 Doca 使用 editor_receipts、markdown_receipts 持久去重，键包含 (resourceId, epochId, messageId)，同 ID 不同 payload 必须拒绝。

## 4. 保存状态机

连接状态：loading → syncing → ready；异常进入 disconnected / error。
保存状态独立：clean / dirty / saving / error。

- 只有本地内容事务进入 outbox。初始化、选区、滚动、焦点、尺寸、在线人数、心跳、远端重放、只读开关不得生成内容更新。
- outbox 空且完成同步才能显示“已保存到云端”；有待确认写入才显示“正在保存”。
- 队列串行发送；只有精确匹配队首 ID 的 ACK 才能出队。未知/迟到/重复 ACK 不能误清后续输入。
- 断线保留 bytes 与 ID。重连先补拉远端，再重试未确认增量。
- 不依据 encodeStateAsUpdate(doc, vector).length 判断 dirty：相同状态也可能返回历史 delete set，长度大于 2 不代表有新写入。
- epoch 不一致暂停旧队列，允许导出/生成独立恢复副本，不把旧增量强行套到新文档。
- 当前宿主适配器通过 `offline-replica.ts` 持久化原 checkpoint 和待提交消息 ID。离线编辑要求已有授权副本和成功的浏览器存储，不提供完整离线应用壳；缓存先展示的刷新边界见下文 2026-10-12 增量。

本轮两个宿主均使用 `apps/web/src/features/documents/update-outbox.ts`。该队列不依赖文档类型，保留实际本地事务增量，sync-response 不触发无条件回传。

## 5. 建议组件 API

所有组件共同提供：

- connect({ doc, epochId, baseline? })，完成初始化后返回 ready。
- setReadOnly(boolean)，不修改 CRDT。
- dispose()，完整清理监听和临时绘制。
- onSelectionChange(callback)，返回取消订阅。
- renderRemoteSelections([{ sessionId, userId, name, color, selection }])。
- clearRemoteSelections()。
- onError(callback)，提供可区分的错误码。

富文本再提供 onFormatStateChange / queryFormatState：
marks、blockType、alignment、canUndo、canRedo。固定和悬浮工具栏使用同一个状态源，不用 DOM 猜格式。本轮通过现有 onChange 和 query 接口更新固定工具栏。

组件与平台必须约定 transaction origin：local、remote、bootstrap。只有 local 被当作用户写入。禁止在 remote apply 的过程中重新包装命令生成新的 operationId。

## 6. 在线选区

统一 selection 判别联合：

- text：anchor/focus 为相对文本位置。
- cells：sheetId、startRow/endRow/startColumn/endColumn（零基闭区间）、editing。
- null：不再展示。

规则：

- sessionId 按连接区分；在线人数按 userId 去重，绘制只排除当前 session，不排除同账号其他页面。
- editing=true 代表正在输入；选中但未输入为 false。切换工作表、编辑开始/结束均发事件。不传单元格值、公式或键盘内容。
- 100～150ms 节流并去重，不写数据库、不增加版本、不影响撤销。
- 只在编辑模式发布和绘制。页面内焦点离开编辑器、离开文档、断线、撤权清除；服务端每条消息检查 ACL。切换浏览器标签页/窗口保留仍在线会话的最后编辑位置，不能把浏览器后台状态当成离开文档（2026-09-12：Markdown 宿主已适配；其他格式需分别验收）。
- 表格显示颜色边框、用户名标签，只画当前 sheet，滚动/缩放由组件定位。
- 数值坐标是临时 presence，在并发插删行列期间可短暂过时；长期评论锚点必须使用稳定行列 ID，不能直接复用 A1 坐标。
- 后续可增加 TTL 防止连接存活但 UI 已失效时的陈旧选区。

当前实现位于 `apps/web/src/features/documents/spreadsheet-editor.tsx`，通过表格编辑器现有的选区状态和实时同步接口发布、接收并绘制 presence；不把单元格内容、公式或键盘输入写入 presence。
后续若将表格编辑能力继续下沉到独立 Excel 包，应保持上述 selection 联合类型和生命周期约定，宿主不长期依赖底层 facade 的细节。

## 7. 快照、回滚、区域评论

Yjs checkpoint 保存原 CRDT 的完整编码，不能用 JSON 投影重建并丢弃身份。Excel 必须保存“不可变 baseline + 同 epoch 命令”；不得拿最新 workbook.save() 的结果作 baseline 后再次重放旧命令。

定期 checkpoint 保持 epoch；用户历史按关键节点创建。历史记录保存自身 format、codec、epoch、baseline 和资产依赖，不能用当前 baseline 解释旧版本。回滚优先产生当前 epoch 的新变更并保留回滚前历史；组件若只能重建，必须显式切换 epoch、处理未确认写入，再加载新谱系。

核心按成功写入记录历史，策略与会员等级无关。自动、手动、AI 和回滚前快照共用持久化与事务边界，失败必须回滚。经用户明确同意的宿主保留策略为：最近 20 个完整快照留在数据库；更早快照每凑满 10 个，只把其中最新 1 个保留为私有文件恢复点。不可变文件上传、读回校验成功后，才在同一事务中登记索引并移除这一组数据库记录，另外 9 个按规则抽稀。未满一组或存储失败时保留数据库原件。用户只看到统一分页的普通快照列表，版本 ID 不变，不返回存储位置字段。快照原字节、独立恢复信息与附件不改写；在线协同检查点和未覆盖增量不参与抽稀。业务策略不能在已同意规则之外隐式删除数据。各格式现有回滚能力保持独立，见[存储运维](storage.zh-CN.md#历史快照存储与显式升级)。

评论作者/正文/回复/解决状态属于平台数据库。组件需提供 captureAnchor、resolveAnchor、renderAnchors、onAnchorClick。富文本是相对文本位置，Excel 应为稳定行列范围，随插删变换；完全删除或解决后不高亮。

当前表格包和宿主已实现区域评论，使用稳定行列身份、capture/resolve/reveal API、标记渲染、epoch 校验与删除目标处理。已支持的行列插入、排序和工作表变化由 `tests/editor-sessions.test.ts`、`tests/sheet-axis-sizes.test.ts`、`tests/sheet-collection.test.ts` 隔离测试覆盖。永久协议与临时单元格 presence 分开。

## 8. 两个组件必须共用的验收清单

1. 打开已有数据静置 60 秒、选择、滚动、调整窗口，零新增内容提交/历史。
2. A 编辑 B 接收，B 不回声提交，最终投影一致。
3. 同账号两页有不同颜色和用户名；文本选区与单元格输入状态准确；只读不发布/显示。
4. ACK 丢失、重复、延迟，重连及收包同时输入：无数据丢失、不提前显示已保存。
5. 纯删除后反复同步不重复上传 delete set。
6. baseline/epoch/schema 不匹配明确拒绝，重复初始化不生成新内容。
7. Excel 并发行列增删、单元格编辑、公式、合并、排序/筛选、撤销逐项验收；不支持的操作要声明或禁用，不能笼统声称全部收敛。
8. 重启后由 checkpoint+增量恢复，与在线投影一致；日志压缩后仍一致。
9. 编辑中撤权、禁用、匿名、越权 room、伪造身份和越界选区均被隔离。
10. 固定/悬浮工具栏格式一致，保存状态更新不重建编辑器、不丢焦点。

## 9. 当前实现与提案的边界

当前宿主已接入富文本、Markdown、表格、画板和演示文稿，共用可靠提交队列及持久 ACK；空闲同步不回传正文，选区与用户名由各格式适配器处理。五种格式支持历史读取；仅富文本和 Markdown 支持管理者恢复，表格、画板、演示文稿返回 `canRestore:false`。这不是所有格式已具备统一组件回滚 API 的承诺。

平台当前已实现 epoch、协议校验、提交回执与历史恢复元数据，具体支持范围见上文及各组件集成文档。无 Redis 时使用单进程广播和 presence；配置 Redis 后，文档更新、服务端刷新、权限失效、通知和 presence 跨实例传播。数据库提交仍是 ACK 边界和正文事实来源，Redis 重连后由服务端向本实例活动房间重新下发权威状态，不把 Pub/Sub 当持久日志，也不在 Redis 故障时静默退回本机总线。

后续仍需组件和平台共同落地：正式组件选区 API、完整离线应用启动和跨格式统一回滚能力。当前宿主持久队列不代表组件自身已导出离线传输；组件未导出的能力仍属于目标契约，Excel 基线验证继续保留。

现有服务协议仍见 [collaboration.md](collaboration.zh-CN.md)。本契约包含目标 API 与已实现清单；不能将全部目标字段和能力视为当前包已导出。

## 插件元素增量（2026-10-02）

宿主已实现 SDK 0.1.6 可选 Web 元素注册表。富文本通过永久 `custom:plugin-element` 原子行内 codec 保存不透明 JSON envelope。表格在原生 `ICellData` 的 `custom.docaElement` 保存配置，以 `v` 保存静态文本投影；整单元格画布渲染器只读取配置，不改持久值。两种格式继续使用原生模型、检查点、撤销和同一个可靠 outbox。

未知类型和不匹配的精确 envelope/data 版本显示不支持占位，保留原始有界 JSON。不提供适配、迁移、转换或自动重置。现有内部引用读取规则保持。原生插入、配置、删除参与剪贴板、撤销和协同。配置表单重新检查实时富文本范围或稳定单单元格锚点，目标已删除或并发变化时拒绝。画布计时器只刷新视图，最多每秒一次，只有绘制了可见计时单元格后才安排下一次刷新；隐藏页面暂停。渲染、选区和空闲变化不得增加正文 seq 或历史。

隔离自动验收覆盖原生持久化与重载、未知 payload 原样保存、富文本原子删除/撤销/剪贴板、表格行插入/锚点/复制/删除/撤销、重复 ACK 重放、两副本收敛且不回声、只读拒绝和超限 payload 回滚。不编辑用户文档。本增量不保证通用块支持、全部表格操作、跨格式无损导出、永久离线队列或原生设备验收。精确字段与限制见仓库 `docs/plugin-editor-elements.md`。

## Markdown 初始化修复（2026-10-03）

宿主先将服务端权威 checkpoint 恢复到空副本，再调用当前 Markdown 包的会话工厂。加载期间不再写入客户端元数据，以免首次正文更新依赖从未提交到服务端的 CRDT 项。状态快照保留同一 doc/text/awareness/undo 对象。不改变 schema、epoch 或存储格式，不转换或清空已有待提交编辑。隔离验收覆盖首次编辑持久恢复、远端/初始化无回声、稳定状态句柄，以及浏览器连续输入、跨实例更新、重载和空闲检查。

## 富文本图块锚点 — 2026-10-10

宿主在当前 `@smartdoca/slate` 0.4.13 上使用既有整块锚点（`kind:"block"`、稳定 `blockId`、当前 `epochId`）支持流程图和思维导图评论及 AI 引用。服务端从已授权图块的节点标签或根主题生成引用文字。样式修改和检查点恢复保留锚点，删除图块后锚点不再解析。当前定位整幅图，不把图内节点或连线 ID 当作永久评论锚点。捕获选区、展示评论和引用给 AI 不产生内容写入；协议、文档格式、谱系和历史评论不做转换或迁移。

## 已发布表格包对接 — 2026-10-10

宿主 0.1.18 锁定 npm 制品 `@smartdoca/sheet` 0.2.0-rc.19。工具栏「数据验证」与「插入 → 下拉列表」分别使用各自入口。公开声明及 Yjs/model/XLSX 入口与 rc.18 字节一致；宿主继续使用已导出的菜单扩展、资源、稳定锚点和协作 API。宿主同步已导出的 `session.setReadOnly` API，模式切换后绘制前刷新能力快照，不重建工作簿或 Y.Doc。插件元素插入通过原生菜单扩展接入 `SPREADSHEET_MENU_PATHS.toolbarEnd`。这次仅对接界面与制品，不改变 codec、schema、epoch、outbox，不转换持久化数据或新增兼容行为。已有历史读取与显式宿主基线维护命令保持原规则。包与宿主回归使用隔离工作簿和文档，构建成功不代表全部表格操作已完成协作验收。

## 文档缓存先展示 — 2026-10-12

按用户确认的方案，宿主新增精确格式版本 1 的 `doca.document-startup.v1` 展示元数据，保存当前登录账号及最近 12 个已缓存文档。只包含公开启动字段、文档和所属文库元数据，不包含凭证、评论、授权名单或第二份正文投影。不修改或转换既有 Yjs checkpoint、不可变 baseline、epoch、schema/codec 协议、消息 ID 和持久 ACK。旧宿主没有页面元数据，需先联网打开一次建立缓存；未知或损坏格式不使用、不转换、不覆盖，回退代码保留正文及未同步修改。

缓存文档刷新时，应用壳和原副本在插件发现、启动信息及文档详情返回前挂载。用户明确选择按上次权限允许离线编辑。实时校验和重试在后台运行，临时网络故障保留同一编辑器。重连合并远端变化并按原字节/ID 重放，只有精确服务器 ACK 才清理对应更新。退出/切换账号及明确会话/资源拒绝会停止展示对应元数据，不删除持久正文或待同步修改；谱系不匹配继续按原精确协议暂停。

这要求已有元数据、成功的浏览器存储和可用的应用静态资源，不是完整离线 PWA。评论、上传和权限修改仍需联网。宿主既有副本默认参数和历史读取规则未调整，也未新增旧格式适配器。隔离验收由 `tests/document-startup-cache.test.ts`、`scripts/qa-document-startup.mts` 记录；基础缓存恢复不代表各格式全部操作均已完成收敛验证。详见[存储与恢复边界](access-offline-events.md#页面缓存先展示--2026-10-12)。

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

## 思维导图工作区升级 — 2026-10-16

宿主 0.1.29 锁定实际 npm 制品 `@smartdoca/slate` 0.4.20，包含 0.4.19 的图形／媒体交互修复。公开入口、依赖和宿主组件／handle 声明不变；codec、Yjs、headless、conversion 运行时代码与 0.4.18 字节相同，原 DOCX 补丁内容不变并绑定到 0.4.20。AI 指导保留完整原生思维导图，包括 `structure`、`theme`、`background`、节点 `fontSize`／`bold` 和 `style:"underline"`。

用户已明确同意新版原生思维导图默认显示作用于已有文档。打开旧图或重新生成版本 6 预览只改变视图，不回写原节点、checkpoint、epoch 或待确认更新身份。工作区打开后不保存关闭不产生内容提交；明确保存才通过现有 Slate/Yjs outbox 与落库 ACK 提交原生草稿和预览。不迁移、不补写历史字段、不新增旧样式适配；现有历史读取及规范化辅助逻辑保留原路径，不重新设计。schema 3 与精确协议检查不变，没有 SQL 变更。

保留 0.1.28 部署、原包制品、版本锁定、补丁和 lockfile 供回退。旧编辑器可能忽略新样式／设置或显示不同默认值。恢复时保留后续写入；恢复升级前备份会丢失其后的编辑。测试只使用隔离的合成文档／数据库；范围及限制见 `docs/verification/slate-workspace-upgrade-2026-10-16/`。

## 三编辑器升级 — 2026-10-17

Doca 固定安装实际 npm 包 `@smartdoca/slate` 0.4.22、`@smartdoca/slides` 0.3.0-alpha.3。Canvas 使用不可变的 `vendor/smartdoca-canvas-0.5.0-75e637df1a75.tgz`：npm 0.5.0 的库构建误删了 Slate 与纯文本内部编辑器注册模块，AidCanvas 源码已通过 sideEffects 声明修复，宿主使用重建产物。这个修复包和源码改动尚未发布 npm。

Slate 新增五页元素配色，进入图形标签编辑时全选文字。codec/Yjs/headless 字节与 0.4.20 一致，原有 DOCX 补丁原样绑定到 0.4.22。Canvas 保持 `aidcanvas-yjs` schema 1；图片和附件回调保存稳定资产 ID，传递真实进度和取消信号，并接入宿主鉴权预览，包括历史、回收站、审计只读视图。服务端校验新增富文本媒体引用属于当前文档。临时画布 presence 完整转发经过校验的相对文字位置和场景鼠标坐标，身份及颜色仍由服务端决定；支持仅鼠标消息，不复用永久评论锚点。

Slides 要求 codec revision 6。客户端与服务端统一严格协商 `eppt-yjs-v6`，文档 schema 2 / protocol 1 不变。用户明确选择**只支持新文稿**：旧 `eppt-yjs-v5` 文稿和旧客户端拒绝打开或接入，原 checkpoint、增量、epoch、历史和待提交消息标识原样保留。不增加旧 codec 读取、编码标识改写、自动转换、迁移或 SQL 结构变更。宿主接受原生文字边距与表格字段；AI 表格命令通过原生 controller 支持合并/拆分、样式、尺寸、清空、粘贴与批量删行列。单元格仍是纯文本加整格样式。

部署时服务端与 Web 必须同步更新。保留旧部署、版本锁定、补丁、锁文件与安装产物；旧程序不承诺读取新功能写入，恢复前须保留后续数据。本次没有修改用户数据库或部署。隔离验收、哈希、截图和边界见 `docs/verification/three-editor-upgrade-2026-10-17/`。

## Canvas 0.5.2 正式包对接 — 2026-10-17

Doca 0.1.31 锁定正式 npm 包 `@smartdoca/canvas` 0.5.2，替代上文临时 0.5.0 tarball；临时包退出运行依赖和构建路径，上一源代码快照保留恢复依据。公开导出、依赖和声明签名相同，声明差异只有一处表格布局注释；模型运行代码逐字节一致。不增加历史读取器、原场景转换、字段补写、codec/schema 变更或 checkpoint/outbox 替换。

新包修复连续中文输入、平移缩放时工具条跟随，并按内容撑高表格行。文字与行几何通过同一原生协同撤销事务保存。宿主继续使用稳定模型、已认证资源与 presence 回调、持久化 ACK 队列。源码、浏览器、镜像及发布证据位于 `docs/verification/release-0.1.31/`；此前 0.5.0 记录保留为当时的验收依据，不代表 0.5.2 全部操作均已验证。

## Canvas inline integration and Slate upgrade — 2026-10-18

Doca 0.1.32 pins the published Slate 0.4.23 and the published registry artifact `@smartdoca/canvas` 0.5.4, which includes Canvas 0.5.3. Slate public declarations, codec/Yjs/headless/conversion bytes match 0.4.22; the identical DOCX patch is rebound. The owner approved current Leafer mind-map display defaults for existing maps. Open/close and preview regeneration remain view-only; explicit save uses the native tree.

Canvas `richTextExtensions` now supports `inline:true`, optional `suggestions:{trigger,search(query,{signal})}` and `matchPaste`/`paste(text,{signal})`. Inline nodes store `{type:'inline',inline:{id,type,label,data},children:[{text:''}]}` in schema-1 rich paragraphs and one U+FFFC marker in native text. The package owns selection, live insertion ranges, debouncing, menu keys, atomic clipboard/deletion/undo, label rendering/export and unknown opaque JSON. Doca supplies directory/ACL checks, user cards, stable reference UUIDs, same-origin document title lookup, notifications and reference indexing. Pending lookup/paste, UI and resolved URLs remain view state. Closed/deleted/readonly targets cannot accept late insertion. Formatting and inline metadata retain existing whole-field LWW semantics.

Active and readonly/history/trash/audit surfaces supply stable `onAttachmentPreview` callbacks to the shared authorized viewer; images retain `onResourcePreview`, and download URLs remain host-authorized. No new transport, autosave, schema/codec, DDL, migration, backfill, historical adapter or epoch/checkpoint/outbox rewrite is introduced. The owner approved no older-client rendering guarantee for new inline metadata. Preserve existing and later data and retain the 0.1.31 deployment, pins, patch and lockfile for recovery. Verification is recorded in `docs/verification/release-0.1.32/` and the native Canvas browser tests; no user documents or databases are used.

## Canvas 0.5.6 与 Sheet 0.2.4 对接 — 2026-10-20

当前代码锁定正式 npm 包 `@smartdoca/canvas` 0.5.6、`@smartdoca/sheet` 0.2.4。公开入口及宿主使用的声明不变；Canvas model 和 Sheet model/Yjs/XLSX 与上一版逐字节一致。Canvas 私有渲染声明和 IO 分包引用有变化；Sheet 将已有 0.25.1 运行时的 `@univerjs/drawing-ui`、`@univerjs/sheets-filter` 声明为直接依赖。

用户明确同意上游对旧图形的视图规则：包含 diagram-body、仅有 frame/diagram-node 名称且没有冲突 kind/显式容器角色的包装识别为图形，隐藏重复外框填充/描边和生成的 Frame 标题，并令图形、文字尺寸跟随包装；显式容器和无形状名的自定义路径保留其角色与轮廓。已有椭圆/菱形端点按新轮廓显示，原四个中点端口索引不变并新增八个端口。打开、选中、视口变化和关闭不得回写原模型/checkpoint；显式缩放或编辑通过原生协同事务与撤销栈保存。不批量转换、不补字段、不变更 DDL、schema/codec、epoch、checkpoint 或待确认消息身份。Canvas 保持 aidcanvas-yjs/schema 1，Sheet 保持 exlsx-cell-registers/schema 6，未知版本继续精确拒绝。

Canvas 图片先选中再预览；复制 PNG 像素通过宿主 resolveDownloadUrl 鉴权，阅读模式也可用。历史/回收站预览保留原有访问参数，服务端仍拒绝不支持的审计资源访问。Sheet 使用包内原生筛选渲染及当前内联图片几何/预览，不修复传入的文档数据。资产 UUID、ACL、临时 presence、永久锚点、持久 ACK 和原 update 保持原归属。已有历史读取器、虚拟工作表恢复、规范化代码和已批准显示默认值仅审计，不扩展其兼容行为。

回退依据为原 Canvas 0.5.5 / Sheet 0.2.3 制品、依赖和锁文件（源码提交 589a3589820770d218bea418fe7c93cd10583f95）；制品身份见 docs/verification/editor-packages-2026-10-20/package-audit.json。服务端与 Web 一起更新，回退前保留后续写入，不承诺旧界面与新图形行为一致。验证只使用隔离数据库/文档，未部署；通过项目及未覆盖范围见[接入验证](verification/editor-packages-2026-10-20/README.md)。

## Canvas 0.5.8 与 Sheet 0.2.5 对接 — 2026-10-21

Doca 锁定 npm 正式发布的 `@smartdoca/canvas` 0.5.8 和 `@smartdoca/sheet` 0.2.5。相对 Canvas 0.5.6 / Sheet 0.2.4，公共类型、入口和依赖不变，Canvas model 与 Sheet model/XLSX 运行时代码逐字节一致。Sheet 的 Yjs 会话先恢复原生筛选器，再计算同批单元格/筛选更新；恢复或排序后刷新未改变的条件。该修复只调整投影，不改变 schema 6 编码或不可变 baseline。

Canvas 包含 0.5.7 的样式、平移、提及、重做及嵌入式视图菜单修复，以及 0.5.8 的无绑定连接线整体拖动。网格和背景色仅为视图状态；显式编辑仍经现有模型、撤销栈、宿主 outbox 和持久 ACK。Canvas 保持 `aidcanvas-yjs` schema 1，Sheet 保持 `exlsx-cell-registers` schema 6。本次没有新增宿主适配器、兼容行为、数据转换、历史字段默认值、DDL 或 epoch/checkpoint/待确认消息改写。已有历史读取、虚拟工作表恢复、规范化函数及此前获批的显示规则保留原有路径，未重新设计。

使用隔离的合成文档和数据库验证。发布包身份、运行时代码比对、通过项目和限制见[对接验证](verification/editor-packages-2026-10-21/README.md)。回退保留源提交 `31fca12f48a54f1c2ce3caeec6a0d976e164ac4e` 的依赖、锁文件、工作区配置和制品；服务端和 Web 一起重建，保留后续写入。未使用用户文档/数据库，未部署。

## 问题清单修复与 Canvas 个人偏好 — 2026-10-22

已核实正式基线为Slate0.4.24、Markdown0.4.4、Sheet0.2.9、Canvas0.5.13及Slides0.3.0-alpha.4，按真实制品及安装文件审计；当前临时测试下述0.5.14C1file候选。已有 codec/schema、不可变 baseline、epoch、checkpoint、原始待确认正文 update 和持久 ACK 归属不变。Canvas0.5.13的model/IO/preferences/全部声明/exports与0.5.12相同，内部键盘 helper 声明不是新增公开 SDK API；Sheet 0.2.9 包含复制及下拉验证删除修复，model/Yjs/XLSX 运行时代码与 0.2.7 相同。图库回调只解析授权视图，不提交编辑草稿。已批准的历史读取、规范化和显示规则保留原路径；无旧数据转换、schema 适配、迁移或 DDL。

用户明确批准 Canvas 个人浏览器偏好按网站、账号和文档隔离。独立 v1 记录经已发布的纯校验器验证后传给受控 view/creation props。无记录保持当前行为；未知版本或坏 JSON 保留原文，不读取、不覆盖。存储失败仅在当前视图保留用户显式选择。偏好变化、菜单及小地图导航不进入正文撤销或协同；新建默认样式仅影响以后的交互创建，不改已有正文、API/AI 插入、导入或远端投影。已有内存会话样式缓存不转换为浏览器记录。回退停用读取，保留记录和后续正文。

宿主继续持有唯一模型会话和传输。当前临时0.5.14C1file候选在精确155文件上原生17/偏好7组通过，正式包和最后编译Web仍须独立验收。焦点修复区分真实对象/显式工具操作与自动完成，不放宽外部输入和控件归属。无新增自动保存、baseline重建或epoch/消息ID替换。隔离网站证据和剩余范围见[问题清单验收](verification/issue-tracker-2026-10-21/README.md)。保留上一版制品、依赖、锁文件，回退时服务端和 Web 一起重建，不能用旧数据库覆盖后续编辑。

## 原生输入与授权追加边界 — 2026-10-22

原生编辑器分发必须先检查事件归属，再操作保留的选区。宿主评论/AI 输入框保留键盘、剪贴板和输入法行为，不产生正文写入。Canvas 0.5.12 修复原生路径；宿主在相邻 AI/布局变化期间保留评论草稿，并独立于侧栏加载已授权永久标记。不新增锚点、codec、模型、命令或 presence 格式。正式归档与已测 C3 键盘/评论候选一致；旧 0.5.11 完整交互收据仍保留原范围。

获批的富文本/Markdown 浏览器速记向明确选中的授权既有 append 目标追加用户纯文本，使用现有原生 epoch、正文事务和回执/投递路径。响应丢失重试原 ticket/request ID 与原 payload；已接受重放不重复追加或增加 seq。目标、输入和当前进程内五分钟 ticket 为临时状态，不承诺持久扩展草稿或跨进程恢复。原正文和后续编辑保留，不支持目标明确拒绝且不转换。见[速记契约](browser-quick-note.md)及隔离双页/实际 MV3 收据。

## 获批的 AI 待发送存储 — 2026-10-22

这是宿主 AI sender 队列，与文档协同 outbox 分开。用户两次明确同意具体保留/回退方案。新就绪消息使用独立 IndexedDB `doca-ai-pending` version 1、`entries` store，以 `[docaOrigin,userId,connectionId,messageId]` 为键并保留扩展明确 profile 身份/修订。条件转换在短 readwrite 事务提交后才成功；Web Locks 只串行网络投递，不负责存储原子性。accepted/withdrawn 原项墓碑保留。未知版本/记录及存储拒绝或失败均保留并拒用，不回退 localStorage 或仅内存发送。

原 0.2.7 localStorage 队列只读且不自动重放。每条已识别旧项需明确继续或撤回并选择当前设置；完整 payload 保留原 ID 和来源哈希，已接受任务只核对而不重发。升级/回退前停止发送并关闭全部旧网站页和扩展：旧 sender 看不到新墓碑，因此不支持新旧同时运行。回退停止新 sender 并保留新旧存储、墓碑和后续数据，不回写旧队列或自动恢复旧 sender。不转换服务器表、会话/文档历史、权限或编辑器 checkpoint。精确规则及双页/刷新/失败/旧项证据见[获批队列记录](verification/issue-tracker-2026-10-21/ai-pending-idb.md)。

## 获批的表格默认尺寸与个人缩放 — 2026-10-23

用户明确同意默认行高 21.78 CSS px、列宽 87.12 CSS px，较原默认增大 10%。新建宿主工作表使用新值；未保存默认尺寸的历史附加工作表和虚拟恢复表，也采用新的显示默认值。baseline 中已保存的默认尺寸、手动行列尺寸、原 baseline 字节、worksheet seed、checkpoint、epoch 和 pending update 保留；不回填历史字段、不转换已存数据、不改变 schema。回退到旧包只恢复其缺省字段的显示默认值，保留后续编辑。原生手动行高列宽仍参与协作和撤销。

右下角仍默认 100%。宿主只把用户明确调整的原生缩放保存为独立 version-1 浏览器记录，按网站、账号和文档隔离。这是整个表格文档的显示比例，切换工作表也沿用，不是行列尺寸覆盖。缺记录时打开不创建记录；未知版本、坏记录或未识别字段保留原文，不覆盖；缓存失败仅在当前挂载视图保留显式选择。匿名视图不持久化。回退停用新偏好的读取和写入，保留记录与全部后续内容。

包负责原生缩放渲染和回调，宿主负责浏览器存储与身份。应用偏好、拖动右下角滑块、加减按钮、切表、只读切换、resize 和远端投影不得进入文档撤销、outbox、正文更新或历史。个人缩放不能泄露到导出的快照或 XLSX。这是已同意的边界，不证明当前安装包已导出所需 props；接入仍须核验正式制品和隔离双页/浏览器收据。

## 获批的表格筛选范围扩展 — 2026-10-23

用户明确同意：打开时保留原已存范围；确认有效筛选条件时，在原列范围内向下扩至最后一条有内容的记录；紧接末尾追加内容时纳入连续记录。保留表头、列边界和所选条件。样式、其他列的内容和清除条件不扩展范围。追加内容与范围扩展必须在同一协作事务和同一次撤销中保存；远端投影与恢复先应用已保存范围，再计算隐藏行，不产生本地回声。

正式 Sheet 0.2.12 使用现有 schema-6 单元格和稳定 feature 寄存器实现此规则。不新增编辑器 schema、公共 API、历史适配器、存储转换、DDL、baseline/epoch 替换或 pending update 重写；已批准的历史读取与默认值规则保持原状。已有短范围只有在明确确认时修复，打开文档不会修复。回退保留已存的原生范围与全部后续内容；先前包可读这些范围，但不会持久保存之后的隐式扩展。

Doca 0.2.11 锁定正式 npm Sheet 0.2.12。包及隔离宿主验收与生产部署分别记录。见[筛选验证](verification/sheet-filter-range-2026-10-23.md)。

## 评论背景运行时边界 — 2026-10-28

Sheet 0.2.14 的 `commentHighlightAnchor` 和 Slides 0.3.0-alpha.5 的 `activeCommentId` 是宿主控制的视图属性。宿主仅传入明确点击且已授权的当前评论。打开侧栏、链接定位或点击正文原生标记均不激活评论背景；点击其他位置、解决评论或关闭侧栏时清除，切换评论时替换，重新打开不恢复。SDK 使用既有锚点解析和当前几何绘制无交互背景，不写模型、永久锚点、事务、undo、presence、outbox 或持久存储。Canvas 0.5.16 的表格连接点可见性同属视图状态。此边界不改变原锚点格式或删除目标的既有解析规则；未知 schema 继续精确拒绝，不新增旧格式读取或转换。
