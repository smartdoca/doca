# Doca 编辑器协同接入规范（提案 v1）

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

当前各格式协同使用 epochId 表示谱系；定期保存 Yjs checkpoint 不改变 epoch。旧命令式表格适配已移除，不保留旧 checkpointId 转发层。

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

组件与平台必须约定 transaction origin：local、remote、bootstrap、migration。只有 local 被当作用户写入。禁止在 remote apply 的过程中重新包装命令生成新的 operationId。

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

核心保留成功写入的历史快照，不再按会员等级限制或淘汰历史。自动、手动、AI 和回滚前快照共用持久化和事务边界；写入失败必须回滚。通用业务策略可以拒绝新快照，但不能隐式删除已有快照、协同检查点、未覆盖增量或附件。

评论作者/正文/回复/解决状态属于平台数据库。组件需提供 captureAnchor、resolveAnchor、renderAnchors、onAnchorClick。富文本是相对文本位置，Excel 应为稳定行列范围，随插删变换；完全删除或解决后不高亮。

本轮不展示 Excel 全文评论区。区域评论的稳定锚点协议尚未提供，不以临时光标接口冒充已经支持永久区域评论。

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

本轮已做：共用可靠提交队列、移除空闲同步回传、Excel 临时选区/用户名、固定布局、富文本固定工具栏选中态、插入表格菜单宽度修复。

平台当前已实现 epoch、协议校验、提交回执与历史恢复元数据，具体支持范围见上文及各组件集成文档。无 Redis 时使用单进程广播和 presence；配置 Redis 后，文档更新、服务端刷新、权限失效、通知和 presence 跨实例传播。数据库提交仍是 ACK 边界和正文事实来源，Redis 重连后由服务端向本实例活动房间重新下发权威状态，不把 Pub/Sub 当持久日志，也不在 Redis 故障时静默退回本机总线。

后续仍需组件和平台共同落地：正式组件选区 API、持久离线队列、Excel 稳定区域评论锚点和统一回滚能力。组件未导出的能力仍属于目标契约，Excel 基线验证继续保留。

现有服务协议仍见 [collaboration.md](collaboration.md)。该文档是下一阶段统一契约，不代表上面字段和能力都已发布。
