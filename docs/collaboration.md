# 编辑器、协同、通知和搜索

> 富文本与 Excel 共用本地增量待确认队列，Excel 已接入单元格在线选区。统一协议、版本含义和组件接口见 [编辑器协同接入规范](collaboration-sdk-contract.md)。本页以下早期阶段描述中的限制以当前实现为准。

## 包与前后端边界

编辑器源码来自 `/Users/zhangsiwen/dev/slatetsx`。当前安装的是用户提供的 2026-09-10 本轮最终获取的包，保存为 `vendor/slatetsx-kit-editor-0.2.0-c9a94dfe.tgz`，不依赖源码目录存在。版本号仍为 **0.2.0 协同预览版**，校验值见 [文档交互设计](document-experience.md#编辑器依赖)。更新依赖时应使用新的文件名和锁文件，避免同版本号旧包缓存。

重新打包流程（需保留原包，更新后执行完整验收）：

```sh
cd /Users/zhangsiwen/dev/slatetsx
npm run build:lib
npm pack --pack-destination /Users/zhangsiwen/dev/dsh/doca/vendor
cd /Users/zhangsiwen/dev/dsh/doca
pnpm add ./vendor/slatetsx-kit-editor-0.2.0.tgz
pnpm check
```

生产建议使用递增的包版本，而不是反复覆盖同名 tgz。此次 Slate 固定到上游验证组合：slate/slate-dom 0.118.1、slate-react 0.118.2、slate-history 0.113.1。现有 React 19 保持不变。由于上游 d.ts 内部引用省略扩展名，项目类型解析使用 Bundler；前端仍由 Vite 构建，后端仍由 tsx 运行。

前端引用主入口和 style.css，持有一个 `Doc`、`YjsDocument` 和稳定的 `createYjsAdapter`；首次同步完成才挂载编辑器。不用 React controlled value 重建 CRDT。服务端只引用 `/yjs`，不加载浏览器 UI。表格与幻灯片在 `DOCUMENT_CODECS` 保留独立类型，暂不接受其编辑请求（409），不冒充富文本。

## WebSocket 契约

`GET /api/v1/ws` 同源升级；开发 Vite 代理必须启用 ws。反向代理需转发 Upgrade/Connection，配置合理 idle timeout。Host 与 Origin 精确匹配配置地址，会话来自 HttpOnly Cookie。公开文档允许匿名只读连接。未登录连接不接收通知和站点统计。

JSON envelope，Yjs 二进制以标准 base64 编码。一个浏览器标签页一条连接、同时加入一篇文档，通知复用该连接。

| 方向 | type | 字段与含义 |
|---|---|---|
| 服务端→客户端 | ready | 连接可用；客户端重新 join |
| 客户端→服务端 | join | id（消息标识）、room（文档 UUID）、vector? |
| 客户端→服务端 | sync-request | id、room、vector；只同步已加入文档 |
| 服务端→客户端 | sync-response | id、room、update、vector、seq、rank、metadata |
| 客户端→服务端 | update | id、room、update；仅 editor 及以上能提交改变状态的更新 |
| 服务端→客户端 | ack | id、room、seq、metadata；事务已提交，不只是收到数据 |
| 服务端→其他客户端 | update | room、update、seq、metadata；不广播回发送者 |
| 客户端→服务端 | leave | 退出当前文档 |
| 服务端→客户端 | presence | room、users[{id,display_name}]；同一用户多标签页去重 |
| 客户端→服务端 | cursor | id、room、selection: null 或 {anchor,focus}；editor 及以上可发布非空光标 |
| 服务端→客户端 | cursors | room、self（当前 connectionId）、sessions[{connectionId,userId,name,color,selection}]；排除当前连接，不排除同账号其他连接 |
| 服务端→客户端 | document.changed | HTTP 管理或评论发生变更，重新读取详情和同步向量 |
| 服务端→客户端 | notifications.changed | 通知失效信号；通过 HTTP 补取当前用户的持久化列表 |
| 服务端→客户端 | error | id?、room?、status、message；不得显示已保存 |

重连用本地 state vector 向服务端取差异，然后向服务端发送自己的差异，支持重复投递。不使用 hocuspocus 或 y-websocket wire protocol；它们与此包不是相同协议。

服务端对每条消息重新检查会话，对每次编辑在元数据锁内重新检查 ACL；广播前再次检查目标用户可读性。注销、禁用和权限变更会触发检查，另有 30 秒 ping/pong 与会话复查。用户身份来自服务端，不接受客户端自报昵称/身份。

当前限制：单更新 1 MiB、文档完整 Yjs 状态 16 MiB、每连接最多排队 64 条 / 10 秒最多 500 条；慢客户端超过 4 MiB 发送缓冲则断开。断网后编辑器转只读、保留本页面内存状态并重连；尚无 IndexedDB 离线持久化，因此不能把未收到 ACK 的页面关闭当作已保存。

## 持久化与快照

`packages/core/src/modules/collaboration/documents.ts` 承担协同存储与验证，`apps/server/src/services/realtime/gateway.ts` 承担连接与消息调度。

1. 首次打开旧的占位文档或新建文档，在事务内一次性初始化标题段落和空正文，保存 Yjs checkpoint。客户端永远不初始化共享文档。
2. 从 checkpoint + 按 seq 排序的增量恢复，合并并验证更新。拒绝改写初始化元数据、缺失依赖、非法链接/文件路径、危险属性、超深/超大的结构。
3. 同一个事务持久化 update、seq、正文检索文本和第一行派生的 title，并递增资源元数据 version。
4. 提交后才 ACK 和广播；重复 update 不重复递增 seq。
5. 每 50 个有效更新或距离上次 checkpoint 超过 5 分钟后的下一次有效更新，保存完整 Yjs checkpoint，并删除已经覆盖的数据库增量。保留 CRDT 内部身份和命令历史，**不通过 JSON 重建原文档**。停写期间增量已持久化，无需为了定时器强行再写快照。

元数据 version、协同 seq、Yjs state vector 各有职责，不作为未来桌面备份版本。当前服务是单进程实时房间；多个进程共享数据库虽然可以串行写入，但没有跨进程广播，不能部署为多副本协同集群。上线多副本前应引入共享消息总线与连接协调。

独立复制会建立全新 Yjs 身份、重映射上传资产 ID，保留内容但不复制评论、授权及撤销历史。重命名已初始化的富文档会在同一事务更新第一行并保留 Yjs 身份，在线页面收到失效通知后拉取差异。

## 内容评论

沿用 HTTP 评论增删改和权限规则，根评论可额外带 `anchor`（JSON 字符串）：

```json
{"blockId":"block-id","quote":"选中文字","start":"base64-relative-position","end":"base64-relative-position"}
```

前端从真实 Slate selection 计算块内 UTF-16 偏移；链接递归计算、mention 按一个对象字符计算。当前只支持单文本块内选区。后端恢复已落库 Yjs，解析和重新编码锚点，禁止向不相关文档或回复附加锚点。选区正文最多 5000 字。

全文评论在文档底部；每条根选区评论是右侧一张独立卡片，依照相对锚点当前 DOM 坐标定位并避免重叠。回复和编辑框留在对应卡片内。引用内容被删除时显示“原文已删除”，不猜测新位置。评论、作者、处理状态仍存业务表，不写入可任意编辑的 CRDT。右栏可折叠，窄屏作为覆盖面板顺序展示。正文评论范围高亮尚未实现。

## 会话级协同光标

普通文本位置为 `{blockId,position}`，position 是 SDK 相对位置的 base64 编码。前端按 150ms 最小间隔，仅在选区变化时发布；不回传整篇正文。服务端生成 connectionId、颜色并从认证会话获取用户名，不接受客户端自报身份。在线人数仍按用户去重，光标按连接区分，同账号多标签页互相可见。正常编辑展示光标和选区背景，断线、离开、权限失效时清除，只读/演示模式不显示也不发布非空光标。

代码块是独立 textarea，使用 `{kind:"code",blockId,offset,fingerprint}`；指纹仅用于判断文本版本一致，不是认证或内容摘要服务。文本不一致时暂不渲染，匹配后用同字体镜像测量光标坐标。代码块当前只显示插入光标，不画远端选择区域。正文的 mentions 按一个 UTF-16 对象位置计数，跨段落选区用两个独立端点。图表内部等非文本自定义控件尚未接入光标适配。

光标仅保存在进程内，不落库、不生成快照；按现有消息频率/大小限制和文档权限校验处理。额外字段丢弃；文本位置最长 512 字符，代码偏移上限 100 万。关闭连接、退出房间时重新广播会话列表。当前为单进程广播，大规模部署仍需单独负载验收。

## Meilisearch

管理员“文档搜索”配置启用开关、服务地址、索引名称，查看状态并触发重建。API 密钥与允许的服务来源在「平台设置 → 服务凭据 → 文档搜索」设置并存入数据库；允许来源限制可连接的服务地址，拒绝重定向和 URL 凭据。

启用后后台分批上传标题/正文，等待 Meilisearch 任务完成，之后约每秒消费持久增量任务。每个索引文档附带标题/正文内容哈希，重复同步会先比较哈希，内容相同不重传。索引只向应用搜索接口返回 ID，浏览器不能直连搜索服务。应用在返回文档、计数、分页之前重新执行当前 ACL 和所有筛选条件，不能因为旧索引保留了已删除/撤权记录而泄露它们。

默认每6小时分批对账，可在管理员设置中调整为1～168小时或手动发起。先持久枚举远端ID/哈希清单，再比较当前文档投影，缺失、过期、删除残留进入已有同步队列；扫描阶段不调用识别或向量模型。清单、游标、租约和修复状态可跨重启恢复；先完成清单枚举再安排本轮清理，避免自身删除造成 offset 跳项。普通增量写入仍可并发改变远端分页视图，后续轮次保证最终收敛，不承诺全站同一时刻的原子快照。切换索引目标或启停会使旧扫描代次失效。

管理员图片识别开关默认关闭，持久保存策略版本并记录审计；当前版本尚未接入 OCR/视觉识别流水线，页面明确提示设置仅为后续偏好，不宣称开启即可识别。

关闭、构建中或异常时回退到数据库标题/正文基础匹配，响应包含 `engine: database|meilisearch`，降级时包含 notice。数据库不提供分词容错；当前先枚举可见候选 ID 再交给 Meili，候选达到1000条且仍有后续页时回退数据库，不作为十万级部署方案。索引内容包含私有正文，必须部署在可信网络、开启认证并纳入数据保护。

接口依据：[Search with POST](https://www.meilisearch.com/docs/reference/api/search/search-with-post)。当前已做适配器模拟接口测试；真实 Meilisearch 实例与 PostgreSQL 实库仍需部署验收。

## 当前验收边界

自动化覆盖并发合并、幂等、快照恢复、只读拒写、Origin 拒绝、实时推送与在线去重、相对位置评论、复制和权限过滤搜索。浏览器用独立验收文档测试两标签页实际输入、实时展示与选区评论保存。

这不是完整生产认证：上游预览包仍需要中文 IME、超大表格、长时间并发与故障注入验收；导出/持久离线恢复、跨进程广播、正文评论范围高亮、评论分页、真实 Meili 和 PostgreSQL 负载测试尚未完成。其他模块边界以各专项文档为准。
