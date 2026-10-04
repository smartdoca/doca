# 实时协同与保存

[English](collaboration.md)

本页描述宿主 0.1.10 当前实现。组件目标 API 与待实现事项见[协同契约](collaboration-sdk-contract.zh-CN.md)，早期单进程和临时包记录见[研发资料](research.zh-CN.md)。

## 已接入格式

富文本、Markdown、表格、画布和幻灯片均已接入。宿主安装公开的 `@smartdoca/slate`、`@smartdoca/markdown`、`@smartdoca/sheet`、`@smartdoca/canvas`、`@smartdoca/slides`，版本由 package.json 和锁文件确定，不要求开发者私有源码目录或旧 vendor tarball。

五种格式共享连接、授权和本地待确认队列，各自维护数据模型、codec、schema、epoch 及视图。组件从服务端权威 checkpoint/基线恢复后挂载；切换语言、只读、选区或保存状态不重建文档。表格保留自身不可变基线与当前协议数据，不能当作富文本处理。

## 连接与消息

WebSocket 入口为 `/api/v1/ws`。浏览器同源升级并使用会话 Cookie；代理需转发 Upgrade/Connection。公开资源只允许其阅读范围内的只读连接。一个标签页复用宿主连接处理文档、通知和在线状态。

JSON 信封中的 Yjs 字节用 base64。实际消息和格式校验以[网关](../apps/server/src/services/realtime/gateway.ts)及[协议校验](../packages/core/src/modules/collaboration/protocol.ts)为准：

| 消息 | 当前用途 |
| --- | --- |
| ready / join | 连接就绪，加入文档并协商 codec/schema/protocolVersion |
| sync-request / sync-response | 同步权威差异、epochId、seq、格式基线及权限；同步响应不是保存 ACK |
| update / ack | 提交本地更新；ACK 按消息 ID 在数据库提交后确认 |
| presence / cursor / cursors | 用户在线状态及按会话区分的临时选区 |
| document.changed / notifications.changed | 重新读取正文/详情或持久通知的失效信号 |
| leave / error | 离开房间或明确报告权限、协议、连接错误 |

已知 epoch 后的编辑必须携带匹配的协议、codec/schema 和 epoch。身份、连接 ID、名字及颜色由服务端确定；写入和广播重新检查资源权限，不接受客户端自报身份。

## 保存、重连与历史

只有真实本地内容事务进入 `update-outbox.ts`。初始化、远端应用、presence、滚动和尺寸变化不提交正文。未确认更新保留原始字节及消息 ID；精确匹配的 ACK 才移除对应更新，同步响应和未知 ACK 不清空队列。

服务端在同一事务内验证、持久化正文及派生投影，提交后发回执和广播。当前回执以资源、epoch 和消息 ID 去重；同 ID 不同内容拒绝。定期 checkpoint 保留 CRDT 身份；历史版本独立保留自己的格式、谱系及资产依赖，见[历史与恢复](document-experience.zh-CN.md#历史与恢复)。

断线后保留当前页面内存并重连，补拉权威状态后重试未确认更新。不提供 IndexedDB 持久 outbox；刷新或关闭页面可能丢失未确认内容，不能宣称持久离线编辑。

## 在线选区与评论

在线人数按用户去重，编辑选区按连接区分，同账号双页也有不同选区。presence 是临时状态，不写正文和历史。富文本、Markdown、表格、画布及幻灯片使用各自实际适配器；只读时不发布编辑选区。

永久评论锚点独立于 presence：富文本文本锚点、Markdown 范围、表格稳定行列身份和画布/幻灯片元素区域按各自协议校验。表格评论随已支持的结构操作追踪稳定记录，持久锚点不是临时 A1 选区。评论显示和解决行为见[评论与通知](comments-and-community.zh-CN.md)。

## 单实例与多实例

无 Redis 时使用进程内广播、在线状态和限流。配置 Redis 后，正文变更、权限失效、通知和 presence 跨实例传播；正文仍在共享数据库中，Redis Pub/Sub 不是持久日志。Redis 已配置但不可用时不静默退回单机总线。

多副本还需要共享 PostgreSQL、文件存储及一致的插件目标版本，各实例保留独立安装缓存，详见[水平扩展](horizontal-scaling.zh-CN.md)。完整负载、断网故障矩阵及真实设备仍需目标环境验收；自动测试使用隔离数据。
