# 数据库结构

当前数据库结构由 `packages/db/src/create-schema.ts` 的全新建表定义，`schema.ts` 维护表类型，`connection.ts` 管理连接，`transactions.ts` 管理事务和冲突重试。新环境直接创建当前最终结构，不保留旧版本回填、旧表转换或历史迁移兼容。

运行时授权结构以统一的 `grants` 和 `share_link_revocations` 表为准，设计与权限计算见 [统一授权来源与权限计算方案](superpowers/specs/2026-09-19-unified-authorization-design.md)。

## 工作台新增表（002_workspace）

resources 保留 nullable 的 last_editor_id（关联 users.id）和 last_edited_at。创建、独立复制、标题修改和有效正文更新记录实际操作者；读取、无变化的同步和权限调整不改写。记录独立于增量历史，快照清理后仍保留。

| 表               | 主键                  | 字段/用途                                                                                                  |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| resource_visits  | user_id + resource_id | 两个外键、visited_at；记录本人实际打开时间，有user_id+visited_at索引                                       |
| user_preferences | user_id（FK）         | avatar（预设标识）、theme（light/soft）、density（comfortable/compact）、default_sort、sort_order、version |
| user_presence    | user_id（FK）         | last_seen_at；在线心跳，统计时结合active状态和有效会话                                                     |

个人偏好无记录时返回默认值version=0，首次保存插入version=1。后续保存带版本条件，避免资料与偏好互相覆盖。访问历史仅返回仍有阅读权限且未删除的资源，不以历史记录绕过权限。

## 类型约定

- ID 为随机 UUID，存 varchar(36)，不编码用户或空间含义。
- 时间为 UTC ISO 8601 字符串 varchar(32)，排序必须维持统一格式。
- 跨库布尔使用 integer 0/1；API 通常转为布尔，表投影中部分状态仍为 0/1。
- version/revision 为正整数；删除为可空时间，而非物理删除。
- JSON 请求使用 camelCase，当前数据库资源响应字段使用 snake_case；详见 API。

## 表

| 表                                       | 主键                         | 主要字段与用途                                                                                          |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| users                                    | id                           | login 唯一、display_name、password_hash、admin、status(active/disabled)、created_at                     |
| sessions                                 | id                           | id 是随机会话的 SHA-256，不是明文；user_id FK、expires_at                                               |
| settings                                 | id                           | 唯一业务行 system；site_name、registration、revision                                                    |
| resources                                | id                           | 文档与知识库共用的权限/生命周期实体，详细见下                                                           |
| grants                                   | resource_id + user_id + source_type + source_id | 主动授权、链接授权和父权限覆盖/阻断的统一授权记录 |
| comments                                 | id                           | resource_id FK、author_id FK、body、parent_id FK、resolved、deleted_at、version、created_at、updated_at |
| reactions                                | resource_id + user_id + kind | FK；kind=like/favorite，复合主键避免重复                                                                |
| notifications                            | id                           | user_id FK、resource_id FK 可空、type、read_at、created_at                                              |
| audit_events                             | id                           | actor_id FK、resource_id FK 可空、action、created_at                                                    |

### resources

| 字段                    | 类型/空值                     | 约束与含义                                                                     |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| id                      | varchar(36) PK                | 稳定资源身份                                                                   |
| kind                    | varchar(16) NOT NULL          | document / library；DB CHECK                                                   |
| format                  | varchar(24) NOT NULL          | rich_text / spreadsheet / presentation；请求 schema 校验，知识库忽略正文类型   |
| title                   | varchar(160) NOT NULL         | 富文本编辑时从第一行派生；管理重命名同步更新已初始化的第一行                   |
| owner_id                | varchar(36) NOT NULL FK users | 一个所有者，不通过 grant 表表达                                                |
| library_id              | varchar(36) NULL FK resources | 文档所属知识库；知识库自身为空                                                 |
| parent_id               | varchar(36) NULL FK resources | 父文档，根文档为空                                                             |
| access_mode             | varchar(16) NOT NULL          | inherit / custom；DB CHECK                                                     |
| visibility              | varchar(16) NOT NULL          | invited / requestable / authenticated / public；DB CHECK；inherit 时不使用本字段作为开放范围 |
| version                 | integer NOT NULL              | 正整数 CHECK；元数据修改递增                                                   |
| deleted_at              | varchar(32) NULL              | 软删除时间                                                                     |
| delete_batch            | varchar(36) NULL              | 同一次级联删除的标记                                                           |
| created_at / updated_at | varchar(32) NOT NULL          | 创建与元数据最后修改时间                                                       |

个人文档是 owner_id=当前用户、kind=document、library_id为空的查询，不建个人空间表，不自动创建根文档。个人文档的 parent_id 必须为空；文档父子关系只存在于知识库内。

知识库不可嵌套；文档有且仅有一个位置；父文档所属库必须与自己一致；父链不能成环。FK 防悬空，跨行规则在 core 的序列化事务内验证，数据库本身不能阻止所有手工写入导致的树异常。

### 评论

支持全文与选区评论。一层 thread 与一层 reply：parent_id 为空为主题，否则必须指向同资源下的主题；不能回复回复、已删除或已处理主题。body 为纯文本，React 文本渲染，不解释 HTML。软删除会清空 body，保留关系占位；选区锚点由当前编辑器协议直接保存。

### 通知与审计

通知投递给指定用户，默认不通知操作者自己。权限变更通知当前提交的被邀请人；所有权转移通知新所有者；评论通知资源所有者和被回复者；点赞变更通知资源所有者。收藏不会向其他人发通知。审计只记录动作元数据，不复制正文。

本轮不是完整的安全审计平台：未提供审计查询界面、登录失败审计、不可篡改归档和保留期清理。

## 索引

- users.login 唯一。
- resources(owner_id,deleted_at)、resources(parent_id)、resources(library_id)。
- 当前：grants(resource_id,user_id,source_type,source_id) 主键；source_type 为 direct、link 或 parent_override，status 为 active 或 disabled。
- share_links 仍保存 token、角色、有效期和人数上限；share_link_revocations 按(resource_id,share_id)保存一次撤销事件及 revoked_user_ids JSON。旧 share_members、member_exclusions 不再创建为运行时权限表。
- grants 按(user_id,resource_id,status)和(resource_id,source_type,source_id,status)建立查询索引。
- comments(resource_id,created_at)。
- reactions(resource_id,user_id,kind) 主键。
- notifications(user_id,created_at)。

后续按实际查询负载补充 sessions(user_id/expiry)、grants(user_id)、收藏反向查询、审计时间等索引，避免在未验证查询策略前堆砌索引。

## 存储与升级

SQLite：开启 foreign_keys、WAL、busy_timeout=5000、synchronous=FULL；默认新数据库 data/v1/doca.db。不能在运行中只复制主 db 文件忽略 WAL 作为可靠备份。

PostgreSQL：pg 连接池 max=10，使用同一建表定义。当前环境没有实库可连接，兼容性尚需 PostgreSQL 集成验证；不能把驱动存在等同部署验收。

新环境直接按当前基线创建数据库；不支持旧数据库自动迁移或新旧模型混用。

正文、身份、协同、搜索和权限表均在当前基线中直接创建，详见 [认证数据结构](authentication.md#数据库)。外部注册用户的 password_hash 为空字符串（不能密码登录），可经最近验证首次设置密码。版本化备份表暂不创建；资源元数据版本、协同 seq、本地修改代数、云端备份版本、Yjs 状态分别独立，不能混用。

## 协同与搜索

- `document_states`：resource_id 主键及外键、codec、checkpoint(base64完整Yjs状态)、checkpoint_seq、seq、text(正文检索投影)、updated_at(上次checkpoint时间)。正文更新时在同一事务递增资源version并从第一行派生title。
- `document_updates`：联合主键(resource_id,seq)、data(base64增量)、author_id、created_at；恢复时按seq排序。50次有效更新/5分钟后的下一次更新触发checkpoint，已覆盖的增量删除。CRDT内部命令历史保留。
- `comments.anchor`：可空JSON文本，仅选区根评论使用，包含blockId、quote、start/end(base64 Yjs相对位置)。回复通过parent_id归属线程。正文锚点不存绝对字符偏移。
- `search_settings`：id=system、enabled、endpoint、index_name、updated_at；同时包含 image_recognition_enabled（默认0）、image_policy_version、reconcile_interval_hours（默认6）和 generation。API密钥不存入此表。
- `search_embedding_task`：id=system；记录最近一次向量配置的 operation_id、endpoint、index_name、embedder_name、task_uid、status、updated_at。配置和模型密钥由 Meilisearch 持久化，本表不存密钥；状态查询通过原 taskUid 恢复。提交响应丢失或提交中崩溃会显示 unknown，不自动重放。该表只跟踪模型配置任务，文档同步任务的 taskUid 持久化另行实现。
- `search_embedding_models`：按搜索服务、索引、embedder 名称关联 AI model_id，保存本次应用的 fingerprint、operation_id、applied。指纹用于发现模型或厂商凭据变化，不向前端返回，不保存第二份明文密钥；任务成功后才标记已应用。
- `search_reconciliation`：单例扫描状态，包含目标代次、轮次、阶段、游标、索引偏移、扫描/差异计数、开始/扫描完成/修复完成/下次运行时间、租约和错误。按页原子提交进度。
- `search_reconcile_entries`：本轮索引 ID/内容哈希清单及待修复记录。无资源外键，资源永久删除后仍能清理索引残留。正文不复制进清单；待修复项通过 projection_jobs 执行，成功后按代次/轮次确认。

富文本 codec=slatetsx-yjs-v1；spreadsheet/presentation暂不创建正文状态。完整协议见 [协同说明](collaboration.md)。

## 上传存储

- `storage_profiles`：id、provider(local/s3)、config(JSON，包含桶、区域、端点、凭据别名、CDN域名)、active、created_at。切换时创建新记录，旧记录保留；API以 expectedId 防止并发覆盖。密钥不入数据库。
- `assets`：id、owner_id、resource_id(nullable)、purpose(avatar/cover/attachment)、profile_id、object_key、filename、mime、size、created_at、deleted_at。resource_id/deleted_at 联合索引。数据库引用有外键约束，资产ID和物理对象key分离。
- `resources.cover_asset_id`：知识库封面，绑定时检查库ID、用途和元数据version；变更递增version。
- `user_preferences.avatar_asset_id`：自定义头像，绑定时必须为本人上传的avatar；使用个人设置version防并发覆盖。
- 上传对象不可变。复制文档/知识库时为附件/封面生成新的资产ID和资源关联，可以复用物理对象，不复用权限。未来垃圾清理必须在所有引用都消失后才能删除物理对象。
# 评论与社区

社区字段直接包含在当前基线：用户 public_id / directory_mode、站点 directory_mode、评论 body_json、通知操作者和去重字段。字段语义见 [评论与社区能力](./comments-and-community.md)。
# 活动与表格

活动与表格结构直接包含在当前基线，具体以当前接口实现为准。
# 用户卡片配置

`user_card_settings(id, config, revision)` 为单行 `id=system`。config 保存 enabled/text/style/url，revision 用于管理员配置乐观锁。
# 授权与引用关系增量表

站点展示策略、授权回应状态、文档引用边及派生索引进度直接包含在当前基线，字段和事务约束见 [文档接入说明](editor-integration.md#数据库与引用一致性)。

## AI 会话范围与审批（033 / 034）

- `ai_sessions.mentioned_resource_ids` 保存用户主动 @ 的文档，不从模型检索/读取记录推导授权。
- `ai_sessions.approved_resource_ids` 保存用户在会话审批卡片明确授权的文档。`resource_ids` 仍用于关联展示和历史会话访问校验，不能单独作为模型授权范围。
- `ai_jobs.result.progress.approvals` 保存具体操作摘要、服务端参数摘要 ID、状态和可选目标文档。`awaiting_approval` 释放执行租约；决定接口锁用户并校验任务归属后恢复。管理员权限申请复用 `access_requests`，不会直接修改文档授权。
