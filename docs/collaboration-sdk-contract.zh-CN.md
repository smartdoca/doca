# Doca 编辑器协同接入规范（提案 v1）

[English](collaboration-sdk-contract.md)

适用：富文本、在线表格及后续文档类型。日期：2026-09-11。

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
- 当前尚无 IndexedDB 持久 outbox，断线只保留页面内存，关闭页面仍可能丢失未确认内容；不能宣称已实现离线安全保存。

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

当前宿主 0.1.10 已接入富文本、Markdown、表格、画板和演示文稿，共用可靠提交队列及持久 ACK；空闲同步不回传正文，选区与用户名由各格式适配器处理。五种格式支持历史读取；仅富文本和 Markdown 支持管理者恢复，表格、画板、演示文稿返回 `canRestore:false`。这不是所有格式已具备统一组件回滚 API 的承诺。

平台当前已实现 epoch、协议校验、提交回执与历史恢复元数据，具体支持范围见上文及各组件集成文档。无 Redis 时使用单进程广播和 presence；配置 Redis 后，文档更新、服务端刷新、权限失效、通知和 presence 跨实例传播。数据库提交仍是 ACK 边界和正文事实来源，Redis 重连后由服务端向本实例活动房间重新下发权威状态，不把 Pub/Sub 当持久日志，也不在 Redis 故障时静默退回本机总线。

后续仍需组件和平台共同落地：正式组件选区 API、持久离线队列和跨格式统一回滚能力。组件未导出的能力仍属于目标契约，Excel 基线验证继续保留。

现有服务协议仍见 [collaboration.md](collaboration.zh-CN.md)。该文档是下一阶段统一契约，不代表上面字段和能力都已发布。

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
