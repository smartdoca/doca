# HTTP API v0.1

AI 会话、模型积分与对外 MCP 以当前 API 路由、运行配置和前端设置为准。

新增文档统计、点赞人、可撤销分享链接和历史快照接口见 [文档交互接口](document-experience.md#http-接口)。

Base URL：同源 /api/v1。运行时请求契约：GET /api/openapi.json，根据真实路由的 TypeBox schema 生成。包含路径、参数、请求体；响应和业务规则由本文补充，目前不是完整的 SDK 生成契约。

## 通用约定

- 除 bootstrap、login、register 和公开资源详情外，需要 Cookie 会话。OpenAPI 部分手写 GET 尚未标注 security，以下权限与服务端校验为准。
- Cookie 名 doca_session；浏览器同源请求自动携带，不放在 URL 或本地存储。
- 所有请求 Host 必须匹配 DOCA_ORIGIN；修改请求还须 Origin 完全匹配。
- JSON接口 Content-Type 为 application/json，上传为 application/octet-stream。拒绝未知字段；名称1–160字符且非全空，新密码12–128字符。
- 通常成功为 HTTP 200，上传成功201，CDN读取302。失败为 {message:string,requestId:string}。
- 400 参数/约束；401 未登录；403 权限不足或来源错误；404 不存在、无阅读权或已删除；409 版本/状态冲突；421 Host 不符；429 限流；500 未预期错误。
- UUID 标识资源。offset 分页并非跨请求一致快照，nextOffset=null 表示结束。

## 账号与系统

| 方法 / 路径                 | 权限     | 请求 → 响应                                                         |
| --------------------------- | -------- | ------------------------------------------------------------------- |
| GET /bootstrap              | 公开     | siteName,registrationEnabled,initialized,user,capabilities          |
| POST /auth/login            | 公开     | {login,password} → {user}，设置 Cookie                              |
| POST /auth/register         | 开放注册 | {login,password,displayName} → User，不自动登录                     |
| POST /auth/logout           | 登录     | 无请求体 → {ok:true}，撤销会话并清Cookie                            |
| POST /auth/password         | 登录     | {currentPassword,newPassword} → {ok:true}，撤销全部会话             |
| GET /users/lookup?q=        | 登录     | q至少2字符，名称模糊/完整账号 → {items:[{id,display_name}]}，最多20 |
| GET /admin/users?q=&offset= | 管理员   | 名称过滤、100条分页 → {items,nextOffset}                            |
| POST /admin/users           | 管理员   | {login,password,displayName} → User，只创建普通用户                 |
| PATCH /admin/users/:id      | 管理员   | {status:"active"或"disabled"} → {ok:true}，不能操作自己/其他管理员  |
| GET /admin/settings         | 管理员   | {id:"system",site_name,registration:0或1,revision}                  |
| PUT /admin/settings         | 管理员   | {siteName,registrationEnabled,revision} → {ok:true}                 |

User={id,display_name,admin:boolean}。管理列表另含 login,status,created_at，admin为0/1，不返回密码。用户创建/启停也可能改变设置 revision，409 后重新获取，不自动重放。

## 资源读取

GET /resources（登录）支持 scope=mine/libraries/shared/favorites/all/trash，省略相当于all；q为标题子串，format=rich_text/spreadsheet/presentation；libraryId 限定库内文档；offset=0–100000，每页100。

资源列表用于管理与目录读取；q非空时只匹配文档，不搜索知识库名称。产品中的内容搜索统一使用下述文档搜索接口。

### 文档搜索

GET `/search/documents`（登录），结果固定为文档，知识库永远不是结果项。

- `q`：关键词或文档描述，最多500字符。不匹配知识库标题。`mode=keyword/ai`，默认keyword；AI模式使用最近成功应用的向量配置，由Meilisearch生成查询向量并混合检索（semanticRatio=0.8）。AI不可用返回503及明确提示，不静默切换关键词。AI查询按管理员的最低相关度过滤（默认0.70），并以当前正文具体词覆盖度对接近的语义分数作有限调整；门槛不会被词覆盖加分绕过。
- `scope=all/owned/shared/favorites/recent`：可访问文档、本人所有、非本人所有且可访问、本人收藏、本人最近访问；省略为all。
- `location=personal/library`：不属于知识库／属于知识库，省略为全部位置。
- `libraryIds`：可重复的UUID查询参数，限定1–50个可阅读知识库。例：`libraryIds=<id1>&libraryIds=<id2>`。多个知识库取并集，与scope、location、format、q取交集。不能与location=personal并用。
- `format=rich_text/markdown/spreadsheet/presentation/canvas`；`offset`分页，每页100。
- `ownerIds`：可重复UUID，最多10人；仅匹配允许当前用户查看所有者信息的文档。
- `visitedWithinDays`：1–3650天内当前用户浏览过的文档；`likedOnly=true`、`favoritesOnly=true`分别限定当前用户点赞、收藏，所有条件取交集。数据库候选过滤及Meilisearch返回后的复核使用同一组条件。
- 返回 `{items,total,nextOffset,engine,mode,notice?}`。每项均kind=document，`summary`为当前可阅读正文的命中段落摘要，`summaryMatches`和`titleMatches`为高亮范围（start/length，JavaScript UTF-16索引），额外`inLibrary`表示是否在知识库。独立分享的文档可被检索，但无权阅读所属库时，library_id/libraryName保持null，不能通过指定私有库ID探测其成员关系。

知识库多选项来自可访问知识库的管理列表，不是搜索结果。管理列表仍支持正常列出知识库；知识库页面的搜索按钮打开文档搜索并预选“知识库内”。进入某个库后侧栏搜索默认限定当前库，可清空筛选扩大范围。无关键词且无任何筛选时，弹窗展示最近访问文档；筛选后即使关键词为空也会应用用户选择的条件。

响应 {items:Resource[],total,nextOffset}。先鉴权再过滤分页。知道libraryId不等于获得访问权。

GET /resources/:id 返回 {resource,ownerName,lastEditorName,lastEditedAt,comments,grants,likes,liked,favorite}。lastEditorName/lastEditedAt 为真实最近编辑人及时间，无法从历史记录确认时为 null，不以所有者代替。public资源允许匿名；目录列表仍需登录。comments 按创建时间升序、当前最多200条；grants仅管理者和所有者可见。

Resource 为 resources 表公开投影，额外 role=reader/commenter/editor/manager/owner。无权访问的 parent_id/library_id 返回null。请求使用camelCase，当前资源响应使用snake_case。

## 创建与生命周期

| 方法 / 路径                 | 最低权限                  | 请求 → 响应                                             |
| --------------------------- | ------------------------- | ------------------------------------------------------- |
| POST /resources             | 登录；目标editor          | {title,kind,format,parentId?,libraryId?} → 新资源数据行 |
| PATCH /resources/:id        | editor                    | {title,version} → {ok:true}                             |
| POST /resources/:id/move    | 全子树manager、目标editor | {version,parentId,libraryId} → {ok:true}                |
| POST /resources/:id/copy    | 全子树reader；`includeChildren=false` 时当前文档manager | `{parentId, libraryId, includeChildren?}` → `{id:新根ID}` |
| POST /resources/:id/trash   | 全未删子树manager         | {version} → {ok:true}                                   |
| POST /resources/:id/restore | 恢复批次manager           | {version} → {ok:true}                                   |

kind=document/library；库不可嵌套。个人文档必须同时 `libraryId=null,parentId=null`；`parentId` 只能指向同一知识库内的文档。创建响应不带role，创建后GET详情。

知识库内移动清空整棵移动子树的直接授权，改custom+invited，保留各所有者和目标知识库治理权，禁止成环。跨知识库或移出知识库时，整棵迁移还要求当前操作者拥有当前文档及全部子文档，并拥有整棵子树的管理权限；不满足时不能带子文档迁出。个人文档只能由所有者移动到其有manager权限的知识库根或节点；知识库文档移回个人时由文档所有者操作，并将移动子树扁平化为独立个人文档。拥有当前文档管理权限即可通过复制接口只复制当前文档到个人根、知识库根或有管理权限的文档节点，子文档不会被复制。恢复按delete_batch，不复活之前单独删除的子节点；需先恢复父级。复制生成独立ID，复制元数据、目录、正文及附件引用，不复制评论、权限或撤销历史。

## 权限与所有权

PUT /resources/:id/permissions，manager以上：

```json
{
  "version": 3,
  "accessMode": "custom",
  "visibility": "invited",
  "grants": [
    { "userId": "d9c0e06b-657d-4f24-947a-7787b7d2bf79", "role": "commenter" }
  ]
}
```

示例UUID需替换真实用户ID。grants全量替换，最多100人、不可重复、用户须active。角色reader/commenter/editor/manager。owner不用grant。直接受邀manager不能在此移除自己的manager授权。

PUT `/resources/:id/permission-sources/:userId`，manager以上，用于查看到某个用户后调整或删除单条授权来源：

```json
{
  "revision": 3,
  "sourceType": "direct|link|parent_override",
  "sourceId": "分享链接ID（仅link需要）",
  "action": "update|delete",
  "role": "reader|commenter|editor|manager",
  "includeDescendants": true
}
```

`grants` 是统一授权表；一个用户在同一文档下可以有一条主动授权、一条父文档覆盖和多条分享链接授权。权限列表展示合并后的最高权限，来源详情页展示各条记录。删除直接授权时，知识库文档会保留一条 disabled 的父文档覆盖记录，避免权限回退到父文档；删除父文档覆盖后才恢复继承。`link` 来源的删除只影响指定分享链接。

POST `/share/redeem`，登录用户兑换分享链接：请求体为 `{token,accept?:boolean,consume?:boolean}`。链接有效期、撤销状态、人数上限和当前用户已有权限都会在服务端校验。当前用户已经拥有不低于链接的权限时，`consume=false` 返回 `alreadyHasAccess:true`，前端可让用户选择是否登记为该链接成员；`consume=true` 才占用该链接人数并登记来源。分享链接被撤销后，原链接不可用，但用户可以通过新的分享链接再次获得授权。

accessMode=inherit/custom；visibility=invited/authenticated/public。根不能inherit；custom+invited且无邀请即私有，知识库所有者仍保留库内治理权。

POST /resources/:id/transfer，仅owner，{version,userId,retainAccess:boolean}。个人文档的目标用户必须是当前文档协作者；知识库文档沿用原有所有权转移规则。成功{ok:true}。retainAccess=true给原所有者manager；false移除其直接授权，但不取消继承、公开范围或知识库所有权带来的访问。

## 评论、点赞收藏

| 方法 / 路径                              | 最低权限                   | 请求                                      |
| ---------------------------------------- | -------------------------- | ----------------------------------------- |
| PUT /resources/:id/reaction              | reader                     | {kind:"like"或"favorite",enabled:boolean} |
| POST /resources/:id/comments             | commenter                  | {body,parentId:null或主题ID}              |
| PATCH /resources/:id/comments/:commentId | commenter并检查作者/管理权 | {version,body?,deleted?,resolved?}        |

新增评论返回{id}，其他{ok:true}。评论纯文本1–5000字，单层回复。仅作者改body，作者或manager删除/处理；不能回复回复或已删/已处理主题。PATCH带评论version，不是资源version，建议每次只传一种动作。

reaction是目标状态而非toggle，重复开启不会重复计数；收藏人列表不公开。

## 通知

GET /notifications?offset=：当前用户最新50条，{items,unread,nextOffset}。item={id,user_id,resource_id,type,read_at,created_at}。

POST /notifications/read：{ids:UUID[]}，1–100条，仅修改当前用户的通知，返回{ok:true}。

持久化通知通过 WebSocket notifications.changed 推送失效信号，再由 HTTP 读取有权限的列表。已读状态仍持久化；重连后补取，不把连接内事件作为唯一通知来源。

## 工作台新增接口

- GET /me：登录后返回 {user,preferences}。preferences含avatar、theme、density、default_sort、sort_order、version，默认version=0。
- PUT /me/profile：{version,displayName,avatar,avatarAssetId?}，只修改本人；avatar 为 initials 或系统预设头像标识（fox/panda/cat/dog/rabbit/lion/tiger/bear/koala/monkey/penguin/owl/dragon/whale/butterfly/leaf/cactus/sun/moon/rocket）。avatarAssetId 须为本人上传的 avatar 资产，null 清除，省略保留。不接受外部图片 URL。GET /me 的 preferences 额外返回 avatar_asset_id。
- PUT /me/preferences：{version,theme,density,defaultSort,sortOrder}。theme=light/soft，density=comfortable/compact，defaultSort=created_at/updated_at/visited_at，sortOrder=asc/desc。修改成功{ok:true}，过期版本409。
- POST /me/heartbeat：登录且页面可见时每60秒调用，成功{ok:true}。
- GET /admin/stats：仅管理员，返回documents、libraries、users、online、onlineWindowSeconds=0。内容数不含回收站；online按真实WebSocket连接的用户ID去重，不再把HTTP心跳计为在线。

## 协同、选区评论、头像与搜索配置

- WebSocket `/api/v1/ws`：消息契约、认证与持久化顺序见 [协同说明](collaboration.md)。仅文档编辑内容经WS，管理操作仍为HTTP。
- POST /resources/:id/comments：可选anchor(JSON字符串，最多12000字符)，仅选区根评论可带；字段blockId/quote/start/end。服务端解析已落库Yjs并验证。其余评论管理沿用现有PATCH契约。
- GET /users/:id/profile：登录后取得协作者id/display_name/avatar/avatar_asset_id，不返回密码、会话、邮箱等字段。
- GET /admin/search：管理员配置及索引运行状态，不返回API密钥。增加 image_recognition_enabled（布尔值）、image_policy_version、imageRecognitionAvailable（当前 false）、reconcile_interval_hours，以及 reconciliation（phase/scanned/differences/pending/startedAt/checkedAt/completedAt/nextAt/lastError）；扫描完成与修复完成分别记录。
- PUT /admin/search：{enabled:boolean,endpoint:string,indexName:string,imageRecognitionEnabled?:boolean,reconcileIntervalHours?:integer}。图片识别默认关闭；当前仅持久保存策略，识别流程尚未接入。对账间隔默认6小时，范围1～168小时；省略新字段保留既有值。地址必须在MEILI_ALLOWED_ORIGINS中，索引名称仅字母数字下划线短横线。启用或更换连接时探测健康并后台建索引；索引中修改连接/启用状态返回409。图片策略和扫描周期可在索引中或搜索服务异常时保存，不探测健康、不重建全文索引。目标/启用状态变化使旧扫描代次失效，设置修改写入审计。
- POST /admin/search/reindex：管理员触发后台重建，{accepted:true}，状态通过GET查询。
- POST /admin/search/reconcile：管理员安排后台对账，{accepted:true}；已有轮次继续，搜索关闭时返回409。扫描计划、清单、游标与修复记录保存在业务数据库，重启后继续。
- GET /admin/search/embeddings：管理员读取当前索引配置，返回 enabled、generation、endpoint、indexName、embedders、task、aiRevision 和 models。task.action 为 apply 或 delete。models 为 AI 模型管理中的向量模型，仅含 id、名称、厂商、维度、不可用原因；每个 embedder 含关联 modelId、needsApply 和 remotePresent。平台持久化模型选择、内容模板和长度限制，即使Meilisearch任务排队、失败或暂时离线，刷新仍返回保存值。不回传密钥、自定义 REST 请求或请求头。旧的独立配置仍可读取，需要选择 AI 模型并应用后建立关联。管理员可删除远程残留配置。
- PUT /admin/search/embeddings：管理员提交 `{generation,name,modelId,aiRevision,documentTemplate,documentTemplateMaxBytes}`，仅允许选择已启用、厂商可用且已配置凭据的向量模型。服务端从 AI 模型管理解析模型、厂商基础地址与密钥，并补全 `/embeddings` 路径。拒绝独立传入 source、model、url、apiKey、dimensions。兼容接口使用实际输出维度；OpenAI 可选缩减维度。仅修改指定名称，保留其他 embedder。202 返回 `{taskUid,status:"enqueued",name,action:"apply",notice}`，不等于配置已生效。应用后变更模型地址、密钥、维度等会显示 needsApply，需管理员再次应用；不会自动触发重算。模型被停用或删除时拒绝新的应用，已写入 Meilisearch 的配置需管理员显式删除。generation/aiRevision 防止旧表单提交至已变化的配置。
- DELETE /admin/search/embeddings：管理员提交 `{generation,name}`，向 Meilisearch PATCH `{[name]:null}` 删除该命名 embedder 及其已生成向量，同时删除平台绑定。自定义/不受支持的远程配置也可删除。202 返回 `{taskUid,status:"enqueued",name,action:"delete",notice}`；仅平台有绑定、远程已不存在时 200 并立即清除记录。不存在返回 404。任务活动期间拒绝并发删除或应用。
- PUT /admin/search/relevance：管理员保存 `{minScore:0..1}`，立即用于后续AI检索，持久化并记录审计，不触发向量重新计算。GET /admin/search/embeddings 返回 minScore。
- GET /admin/search/embeddings/status：管理员查询上次配置任务，返回 `{taskUid,status,name,action,notice}`。action 为 apply 或 delete。任务编号和目标持久化，重启后继续查原任务；网络错误保留处理中状态，失败信息不透传供应商原始响应。请求结果不确定时标记 unknown，不自动重复提交。配置任务活动期间拒绝并发配置及搜索连接/启用状态变更；变更连接后的旧表单由 generation 拒绝。删除任务成功后移除对应绑定。
- GET /search/documents：关键词模式可降级到数据库，并通过notice说明；AI模式需可用向量模型。保持Meilisearch相关性顺序，摘要来自权限复核后的当前正文。当前通过数据库获取可搜索文档ID再传入Meilisearch过滤；超过1000个候选文档时，关键词模式降级、AI模式要求缩小知识库范围。
- Agent和MCP的knowledge_search共用平台搜索，支持query、mode=auto/keyword/ai、libraryId和offset。auto优先AI，未配置时使用关键词并返回notice；本次授权范围在检索与分页前生效，返回snippet、url和seq。读取完整内容分别使用document_read和document_get。
- POST /resources/:id/visit：记录当前用户的访问，重新验证阅读权限，成功{ok:true}；不修改资源version/updated_at。

GET /resources新增scope=recent/owned：recent为本人的实际访问记录；owned为本人所有文档（含知识库内）。新增sort=created_at/updated_at/visited_at及order=asc/desc，排序在分页前完成。资源列表额外返回ownerName、libraryName、visited_at；知识库不可见时不返回其名称。

新增 kind=document/library，可与scope组合，在计数/分页前过滤。主页各Tab均使用kind=document，知识库管理页仍使用scope=libraries。

## 文件上传与存储

| 方法 / 路径 | 权限 | 契约 |
|---|---|---|
| POST /assets?purpose=&filename=&resourceId= | 登录，附件editor / 封面manager | purpose=avatar/cover/attachment；avatar不带resourceId，其他必带。二进制body，201 → {id,url,filename,mime,size} |
| GET /assets/:id/content | 资产权限 | 本地/无CDN返回文件流，有CDN鉴权后302到60秒签名URL |
| GET /resources/:id/assets | reader（可匿名公开阅读） | {items:[{id,filename,mime,size,created_at}]}，最新200个文档附件 |
| PUT /resources/:id/cover | 知识库manager | {version,assetId:uuid或null} → {ok:true}，递增资源version；409过期 |
| GET /admin/storage | 系统管理员 | {id,config,credentialRefs,cdnSigningReady,maxUploadBytes}，不包含密钥 |
| PUT /admin/storage | 系统管理员 | {expectedId,config} → {id}，新配置ID；409并发冲突 |

config={provider:local或s3,bucket,region,endpoint,forcePathStyle,credentialRef,cdnDomain}，所有字段必填，未用字符串可为空；region、credentialRef非空。端点必须HTTPS且位于服务器白名单。S3需要服务器凭据别名，CDN需要CloudFront签名密钥。详情见 [文件存储部署](storage.md)。

上传头像/封面仅接受PNG/JPEG/WebP/GIF，最大5MB；附件最大20MB。图片重新编码成WebP并移除元数据。上传成功不自动绑定头像或封面，需要相应PUT；附件直接归属资源。错误413代表请求体超限，429表示上传限流；任何asset ID都不是无权限的公开文件链接。

复制资源会给附件/封面生成独立资产ID和权限关联，复用不可变存储对象。文件上传不实现跨端双向同步。

## 运维与冲突

GET /health（非/api/v1）查询数据库后返回{status:"ok",version:"0.1.0"}，也校验Host。

修改流程：GET最新对象 → 带version提交 → 成功刷新；409提示用户刷新，不自动强制覆盖。

version仅用于元数据；不是正文Yjs状态或备份版本。富文本协同和外部 OIDC 登录已实现；Hook、备份、OIDC 提供方尚未实现。bootstrap.capabilities 按实际能力返回。

## SSO、多身份绑定与注册审批

完整接口及策略见 [身份认证说明](authentication.md#http-接口)。新增 `/admin/auth`、`/auth/providers`、`/me/identities` 系列接口；公开注册响应带 status，pending 用户需管理员批准后重新登录。管理员用户列表可按 status 过滤。
# 评论与用户范围增量

富评论、用户标识、用户搜索策略以及通知接口见 [评论与社区能力](./comments-and-community.md)。旧的纯文本评论请求保持兼容。
# 本轮增量

文档体验、历史回滚与表格协议见 [文档交互设计](document-experience.md) 和 [编辑器接入说明](editor-integration.md)。
# 用户卡片（2026-09-11）

`GET /api/v1/user-card-settings` 读取全站卡片展示配置。`PUT /api/v1/admin/user-card-settings` 仅管理员可调用，接受 `{ enabled, text, style, url, revision }`，style 为 `primary | secondary | link`，返回新 revision；并发冲突返回 409。URL 中 `{userId}` 表示用户公开唯一标识，`{uid}` 表示内部 UUID，替换值做 URL 编码。仅允许 HTTP(S) 或站内相对路径，禁止脚本与协议相对地址。

`scope=libraries` 仅返回自己拥有、或被直接授予整个知识库编辑/管理权限的知识库。仅单篇文档授权不返回父知识库；单篇文档仍可在 `scope=shared&kind=document` 中查询。对知识库新增评论返回 400。
# 文档接入与主动展示

新增授权/邀请、引用关系、强制下载接口及权限语义见 [文档接入说明](editor-integration.md#接口)。

## AI 会话范围与审批（2026-09-16）

`POST /api/v1/ai/sessions/:id/messages` 可传 `currentResourceId`（当前文档），`references` 仅代表用户主动引用。`scope=document` 允许当前文档、该会话历史 @ 文档和已批准文档；`scope=all` 仍受用户实际 ACL 约束。重试沿用服务端原任务范围，不能通过重试参数扩权。

`POST /api/v1/ai/jobs/:id/approval` 接受严格结构 `{approvalId, approved:boolean}`，只允许任务所属用户决定，不能传替换目标或参数。重复相同决定幂等；任务已取消/决定冲突返回 409，其他用户返回 404。动作包括创建、移动、会话文档访问、向文档管理员申请权限；创建/移动按原参数摘要绑定，会话批准不改变用户本身的权限。

模型工具 `document_request_access(resourceId, role:reader|editor, reason)` 在当前用户已有对应权限时申请会话授权；否则经用户确认调用平台权限申请。返回 `pending_document_owner` 不等于获准，任务展示“等待文档管理员审批”，后续仍需实际 ACL 通过才能读取或编辑。未开放 AI 删除资源工具。
