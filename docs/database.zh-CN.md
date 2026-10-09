# 数据库参考

[English](database.md)

当前基线为 `doca-2026-10-08-knowledge-books-v2`。[create-schema.ts](../packages/db/src/create-schema.ts) 定义建表、索引、外键和检查约束；[schema.ts](../packages/db/src/schema.ts) 定义 Kysely 类型；[connection.ts](../packages/db/src/connection.ts) 管理连接；[transactions.ts](../packages/db/src/transactions.ts) 管理事务和冲突重试。

空数据库按当前结构初始化，启动时校验基线及必需的存储、凭证结构。旧基线明确拒绝，本版不迁移或转换；保留原数据和部署，按[发行要求](releases/0.1.10.zh-CN.md)准备新环境。已有 document_templates 表保留，不提供原 CRUD，也不自动注册为资源来源，见[模板与素材](creation-resources.zh-CN.md)。这些是现有实现事实，不是新的迁移方案。

## 连接、初始化与备份

SQLite 开启 foreign_keys、WAL、busy_timeout=5000 和 synchronous=FULL。源码开发默认使用 `data/v1/doca.db`，Compose 将 `/data/doca.db` 持久化到 doca_data。可靠备份须一致处理 WAL，或使用 SQLite 备份/检查点流程；不能只复制正在写入的 .db 文件。

PostgreSQL 使用 pg，默认连接池上限 10；URL 与 schema 通过环境配置。多副本需要共享 PostgreSQL、Redis 和各实例可访问的文件存储，见[水平扩展](horizontal-scaling.zh-CN.md)。驱动支持和历史隔离检查不能代替真实数据库、对象服务的部署验收。

宿主与 AI 模块可分别配置数据库连接。备份覆盖所有配置数据库、引用的文件存储和受保护的部署配置，包括凭证主密钥。生产恢复前先在隔离环境中验证一致恢复。

## 身份与并发

- 大多数资源、账户 ID 为随机 UUID 字符串；协议摘要、单例 ID 和操作 key 遵循各自格式。
- 时间为 UTC ISO 8601 字符串，排序维持统一格式。
- 跨数据库布尔使用 integer 0/1，API 通常转为布尔；声明的 JSON 字段以文本保存。
- 元数据 version、配置 revision、授权 revision、协同 seq/epoch、操作回执各有含义，不能互相替代。
- 提供 deleted_at 的表使用软删除；并非每张表都含删除字段。联合主键、唯一索引、外键与串行化事务共同保证约束。
- 请求 JSON 通常为 camelCase，资源或数据库投影可能为 snake_case，见 [HTTP API](api.zh-CN.md)。

## 资源、发现与授权

resources 统一保存文档和知识库身份，格式包括 rich_text、markdown、spreadsheet、canvas、presentation。owner_id 表示独立于 grants 的唯一所有者；access_mode 为 inherit/custom，visibility 为 invited/requestable/authenticated/public。发现与授权分离：可见标题和收录入口不授予正文访问权限。

个人文档满足 kind=document、owner_id=当前用户、library_id 和 parent_id 为空。知识库不可嵌套，文档只有一个位置，父文档必须同库，父链不能成环。外键防止悬空，core 事务检查跨行树约束；手工 SQL 仍可能破坏规则，不属于产品写入接口。

grants 主键为 `(resource_id,user_id,source_type,source_id)`，direct/link/parent_override 与 active/disabled 参与当前权限计算。share_links 和 share_link_revocations 记录链接代次、权限与撤销事实。邀请、申请、收录、入口和工单分别表达各自流程，详见[权限](permission-inheritance.zh-CN.md)与[发现收录](public-resource-discovery.zh-CN.md)。

last_editor_id/last_edited_at 记录真实创建、独立复制、重命名与有效正文更新；读取、无变化同步和权限调整不改写。个人访问历史按当前权限和删除状态过滤。user_preferences 以 version 乐观锁保存，首次保存前默认 version=0，与用户资料 revision 分离。

## 正文、引用与协同

正文通过 document_states/checkpoint 和 document_updates 持久化；editor/Markdown epoch 与回执标识有序操作并去重重试；document_versions 保存业务历史和恢复数据。codec、schema、baseline、seq、epoch 由各编辑器协议定义，五种格式采用实际实现的持久化路径。见[协同契约](collaboration-sdk-contract.zh-CN.md)、[协同说明](collaboration.zh-CN.md)和[编辑器集成](editor-integration.zh-CN.md)。

文档引用、集成事件、待投递事件、projection jobs/cursors 和搜索 reconciliation 将权威正文/授权与派生索引分开。引用不授予权限；搜索设置、任务、模型指纹和校对清单记录配置及修复进度，不另存模型明文密钥。投影失败不能伪造正文保存成功。

评论保存主题/回复关系、body/body_json、当前协议锚点、处理和删除状态，内容安全展示。通知保存接收者、操作者、去重/工单字段及可选插件元数据。审计和安全记录保存动作元数据，不复制正文。见[评论通知](comments-and-community.zh-CN.md)与[身份认证](authentication.zh-CN.md)。

## 文件与插件状态

storage_profiles 只有稳定 id、active 和 created_at，后端配置与凭据来自环境。本基线没有 provider/config 列，也没有可写的管理员存储配置。assets 和 file_storage_objects 保存存储/对象身份；file_items/folders/bindings、衍生文件、提取结果和操作回执管理用户文件及处理过程。文件字节独立于数据库行；删除一个文档或历史行不能直接删除共享物理对象。见[文件存储](storage.zh-CN.md)。

插件 namespace 绑定 plugin_id、namespace、data_version、generation、state 和声明的 definition。托管 SQL 业务表由插件存储服务定义，不属于 Schema 的固定表清单。私有对象、待清理记录、不可变归档、注册表、WebView 会话和导航配置由宿主管理。plugin_credentials 保存按 namespace/generation/revision 隔离的加密 sealed 值；plugin_credential_keys 只保存指纹，不保存主密钥。见[插件存储](plugin-horizontal-scaling.zh-CN.md)与[托管凭证](plugin-credentials.zh-CN.md)。

## AI 与知识流程

AI 会话分别保存用户主动提及、用户明确批准和展示/历史关联的资源，resource_ids 本身不能授权模型访问。任务保存审批摘要与参数摘要，等待审批时释放租约，认证并校验归属后恢复。AI calls 保留原始用量事实，业务计费/策略模块不能替代。密钥、技能、MCP key、记忆、操作回执和会话事件分别遵循各自边界。

来源订阅、知识分块与关联继续提供索引和搜索。下方知识册表保存配置历史、贡献者来源、人工反馈、运行、不可变成果和人工待办。所有衍生成果遵守原来源权限。新库不创建旧整理和问答表，已有记录不迁移、不删除。

## 当前表与字段清单

以下穷举当前 Schema 接口字段。精确 SQL 类型、空值、默认值、主键/唯一约束和外键以 create-schema.ts 为准；TypeScript 可选属性不等于 SQL 可空列。该清单用于参考，不要求手工建表或修改数据库。

| 表 | 字段 |
| --- | --- |
| `schema_baseline` | `id`, `created_at` |
| `file_operation_receipts` | `plugin_id`, `user_id`, `operation`, `operation_key`, `request_hash`, `status`, `result`, `object_id`, `profile_id`, `object_key`, `cleanup_at`, `created_at` |
| `ai_session_resources` | `session_id`, `kind`, `resource_id`, `title`, `href`, `touched_at` |
| `ai_sessions` | `approved_resource_ids`, `mentioned_resource_ids`, `id`, `user_id`, `title`, `model_id`, `resource_ids`, `archived`, `revision`, `created_at`, `updated_at` |
| `ai_users` | `user_id`, `default_model`, `memory_enabled`, `memory_revision`, `lock_version` |
| `ai_notes` | `user_id`, `content`, `updated_at` |
| `ai_secrets` | `user_id`, `key`, `value`, `updated_at` |
| `ai_jobs` | `id`, `session_id`, `user_id`, `model_id`, `status`, `input`, `digest`, `result`, `error`, `lease`, `lease_until`, `attempts`, `cancelled`, `created_at`, `updated_at` |
| `ai_operations` | `id`, `user_id`, `job_id`, `digest`, `result`, `created_at` |
| `ai_calls` | `id`, `user_id`, `job_id`, `model_id`, `model_snapshot`, `periods`, `state`, `input_tokens`, `output_tokens`, `cached_tokens`, `usage`, `created_at`, `updated_at` |
| `ai_skills` | `id`, `user_id`, `name`, `description`, `content`, `formats`, `enabled`, `revision`, `updated_at` |
| `ai_mcp_keys` | `id`, `user_id`, `name`, `token_hash`, `resource_ids`, `writable`, `expires_at`, `created_at` |
| `ai_session_events` | `session_id`, `seq`, `event_id`, `digest`, `type`, `payload`, `created_at` |
| `tickets` | `operation_json`, `id`, `kind`, `resource_kind`, `source_key`, `hidden_for_user_id`, `resource_id`, `user_id`, `initiator_id`, `status`, `role`, `message`, `created_at`, `updated_at`, `expires_at`, `reminded_at` |
| `ticket_events` | `operation_json`, `id`, `ticket_id`, `actor_id`, `status`, `message`, `created_at` |
| `registration_reviews` | `user_id`, `status`, `reviewer_id`, `message`, `created_at`, `updated_at` |
| `access_invitations` | `include_descendants`, `resource_id`, `user_id`, `role`, `state`, `version`, `invited_by`, `created_at`, `updated_at`, `expires_at`, `decided_by` |
| `invitation_history` | `include_descendants`, `resource_id`, `user_id`, `role`, `state`, `version`, `invited_by`, `created_at`, `updated_at`, `expires_at`, `decided_by`, `id` |
| `resource_collections` | `user_id`, `resource_kind`, `resource_id`, `created_at` |
| `resource_entries` | `user_id`, `resource_id`, `state`, `source`, `version`, `updated_at` |
| `pending_integration_events` | `id`, `type`, `payload`, `created_at` |
| `projection_cursors` | `id`, `revision` |
| `projection_jobs` | `lease_token`, `lease_until`, `status`, `plugin_id`, `max_attempts`, `id`, `kind`, `payload`, `revision`, `attempts`, `available_at`, `last_error` |
| `markdown_epochs` | `resource_id`, `epoch_id` |
| `editor_epochs` | `resource_id`, `epoch_id`, `baseline` |
| `editor_receipts` | `resource_id`, `epoch_id`, `message_id`, `digest`, `seq` |
| `markdown_receipts` | `resource_id`, `epoch_id`, `message_id`, `digest`, `seq` |
| `access_requests` | `operation_json`, `message`, `decision_message`, `id`, `resource_id`, `user_id`, `role`, `status`, `created_at`, `updated_at`, `decided_by` |
| `integration_events` | `id`, `seq`, `type`, `payload`, `created_at` |
| `distribution_settings` | `id`, `config`, `revision` |
| `document_references` | `source_id`, `target_id` |
| `user_card_settings` | `id`, `config`, `revision` |
| `share_links` | `include_descendants`, `max_members`, `revoked`, `revoked_at`, `resource_id`, `token`, `token_hash`, `generation`, `revision`, `role`, `enabled`, `expires_at`, `created_by`, `created_at` |
| `share_link_revocations` | `resource_id`, `share_id`, `revoked_by`, `revoked_at`, `revoked_user_ids` |
| `document_versions` | `recovery_json`, `id`, `resource_id`, `seq`, `checkpoint`, `title`, `author_id`, `created_at` |
| `visit_events` | `id`, `resource_id`, `user_id`, `created_at` |
| `account_settings` | `id`, `config`, `revision` |
| `login_identifiers` | `value`, `user_id`, `kind`, `active` |
| `user_contacts` | `user_id`, `kind`, `value`, `verified_at`, `verification_source` |
| `account_flows` | `id`, `kind`, `user_id`, `data`, `expires_at` |
| `verification_challenges` | `id`, `binding`, `destination`, `kind`, `purpose`, `digest`, `attempts`, `consumed`, `created_at`, `expires_at` |
| `security_audit` | `id`, `actor_id`, `user_id`, `action`, `details`, `created_at` |
| `auth_providers` | `profile_config`, `protocol_config`, `id`, `type`, `name`, `issuer`, `client_id`, `credential_ref`, `enabled`, `version` |
| `auth_identities` | `id`, `user_id`, `provider_id`, `subject`, `display_name`, `created_at` |
| `auth_flows` | `intent`, `id`, `browser_hash`, `provider_id`, `provider_version`, `verifier`, `nonce`, `user_id`, `session_id`, `expires_at`, `stage`, `identity` |
| `document_states` | `resource_id`, `codec`, `checkpoint`, `checkpoint_seq`, `seq`, `text`, `updated_at` |
| `document_updates` | `resource_id`, `seq`, `data`, `author_id`, `created_at` |
| `search_settings` | `id`, `enabled`, `endpoint`, `index_name`, `updated_at`, `image_recognition_enabled`, `image_policy_version`, `reconcile_interval_hours`, `generation`, `ai_min_score` |
| `search_embedding_task` | `id`, `operation_id`, `endpoint`, `index_name`, `embedder_name`, `task_uid`, `status`, `updated_at` |
| `search_embedding_models` | `id`, `endpoint`, `index_name`, `embedder_name`, `model_id`, `fingerprint`, `operation_id`, `applied`, `document_template`, `document_template_max_bytes`, `applied_at` |
| `search_reconciliation` | `id`, `generation`, `round_id`, `phase`, `cursor`, `remote_offset`, `scanned`, `differences`, `started_at`, `checked_at`, `completed_at`, `next_at`, `lease_token`, `lease_until`, `last_error` |
| `search_reconcile_entries` | `id`, `round_id`, `content_hash`, `pending` |
| `storage_profiles` | `id`, `active`, `created_at` |
| `file_storage_objects` | `id`, `profile_id`, `object_key`, `sha256`, `size`, `mime`, `category`, `ai_description`, `ai_status`, `ai_model`, `ai_generated_at`, `created_at` |
| `file_derivatives` | `id`, `source_id`, `profile_id`, `object_key`, `kind`, `recipe`, `mime`, `size`, `created_at` |
| `file_extracts` | `storage_object_id`, `status`, `result`, `error`, `updated_at` |
| `folder_publications` | `folder_id`, `enabled`, `revision` |
| `folder_entries` | `folder_id`, `user_id`, `state`, `updated_at` |
| `file_folders` | `storage_namespace`, `id`, `owner_id`, `parent_id`, `name`, `version`, `created_at`, `updated_at`, `deleted_at`, `delete_batch` |
| `file_folder_shares` | `folder_id`, `user_id`, `role`, `version`, `created_at`, `updated_at` |
| `file_folder_share_links` | `folder_id`, `token`, `token_hash`, `role`, `enabled`, `created_by`, `created_at`, `updated_at` |
| `file_items` | `storage_namespace`, `id`, `owner_id`, `parent_type`, `parent_id`, `storage_object_id`, `name`, `mime`, `size`, `metadata`, `ai_description_override`, `locked`, `version`, `created_at`, `updated_at`, `deleted_at`, `delete_batch` |
| `file_bindings` | `id`, `file_id`, `owner_plugin`, `owner_type`, `owner_id`, `role`, `created_at` |
| `file_recognition_settings` | `id`, `config`, `revision` |
| `assets` | `uploaded_by`, `id`, `owner_id`, `resource_id`, `purpose`, `profile_id`, `object_key`, `filename`, `mime`, `size`, `created_at`, `deleted_at` |
| `workspace_activity` | `user_id`, `resource_kind`, `resource_id`, `visited_at`, `favorite` |
| `resource_visits` | `user_id`, `resource_id`, `visited_at` |
| `user_preferences` | `avatar_asset_id`, `user_id`, `avatar`, `theme`, `density`, `default_sort`, `sort_order`, `version` |
| `user_presence` | `user_id`, `last_seen_at` |
| `users` | `profile_metadata`, `profile_revision`, `public_id`, `directory_mode`, `id`, `login`, `display_name`, `password_hash`, `admin`, `status`, `created_at`, `last_login_at` |
| `sessions` | `id`, `user_id`, `expires_at` |
| `plugin_webview_auth` | `id`, `kind`, `plugin_id`, `parent_session`, `expires_at` |
| `navigation_settings` | `id`, `revision`, `draft`, `published` |
| `settings` | `directory_mode`, `id`, `registration`, `revision`, `site_name`, `default_locale`, `default_timezone`, `registration_review`, `sso_registration`, `social_registration` |
| `resources` | `permission_overrides`, `content_bytes`, `authz_revision`, `history_readers`, `discoverable`, `last_editor_id`, `last_edited_at`, `cover_asset_id`, `page_width`, `id`, `kind`, `format`, `title`, `owner_id`, `library_id`, `parent_id`, `tree_order`, `access_mode`, `visibility`, `requests_enabled`, `share_links_enabled`, `public_role`, `version`, `deleted_at`, `delete_batch`, `created_at`, `updated_at` |
| `document_templates` | `id`, `format`, `title`, `content`, `preview`, `created_by`, `created_at`, `updated_at` |
| `grants` | `include_descendants`, `source_type`, `source_id`, `source_resource_id`, `status`, `created_by`, `created_at`, `updated_at`, `resource_id`, `user_id`, `role` |
| `comments` | `body_json`, `anchor`, `id`, `resource_id`, `author_id`, `body`, `parent_id`, `resolved`, `deleted_at`, `version`, `created_at`, `updated_at` |
| `reactions` | `resource_id`, `user_id`, `kind`, `created_at` |
| `plugin_notifications` | `notification_id`, `plugin_id`, `resource_type`, `resource_id`, `title`, `body`, `path`, `request_hash`, `withdrawn_at` |
| `notifications` | `ticket_id`, `actor_id`, `comment_id`, `dedupe_key`, `id`, `user_id`, `resource_id`, `type`, `read_at`, `created_at` |
| `plugin_storage_namespaces` | `plugin_id`, `namespace`, `data_version`, `generation`, `state`, `definition`, `created_at` |
| `plugin_object_garbage` | `id`, `store_id`, `object_key`, `created_at` |
| `plugin_credential_keys` | `id`, `fingerprint`, `created_at` |
| `plugin_credentials` | `plugin_id`, `namespace`, `generation`, `id`, `revision`, `sealed`, `created_at`, `updated_at` |
| `plugin_private_objects` | `plugin_id`, `generation`, `id`, `store_id`, `object_key`, `mime`, `size`, `sha256`, `created_at` |
| `plugin_registry` | `id`, `revision`, `state` |
| `plugin_archives` | `sha256`, `plugin_id`, `version`, `store_id`, `object_key`, `size`, `file_index`, `created_at` |
| `audit_events` | `id`, `actor_id`, `resource_id`, `action`, `created_at` |
| `user_page_state` | `user_id`, `key`, `value`, `version`, `updated_at` |
| `knowledge_books` | `id`, `revision`, `configuration`, `published_release_id`, `created_at`, `updated_at` |
| `knowledge_book_configurations` | `book_id`, `revision`, `configuration`, `author_id`, `created_at` |
| `knowledge_book_sources` | `id`, `book_id`, `title`, `creator_id`, `revision`, `configuration`, `status`, `created_at`, `updated_at` |
| `knowledge_book_source_versions` | `source_id`, `revision`, `title`, `configuration`, `status`, `author_id`, `created_at` |
| `knowledge_book_feedback` | `id`, `book_id`, `author_id`, `revision`, `detail`, `status`, `created_at`, `updated_at` |
| `knowledge_book_feedback_versions` | `feedback_id`, `revision`, `detail`, `status`, `author_id`, `created_at` |
| `knowledge_book_runs` | `id`, `book_id`, `actor_id`, `configuration_revision`, `configuration`, `input_hash`, `status`, `lease_id`, `started_at`, `heartbeat_at`, `artifact`, `error`, `trigger_key`, `created_at`, `updated_at` |
| `knowledge_book_node_runs` | `run_id`, `node_id`, `type`, `status`, `input_refs`, `output`, `error`, `started_at`, `completed_at` |
| `knowledge_book_releases` | `id`, `book_id`, `run_id`, `revision`, `artifact`, `created_at` |
| `knowledge_book_human_tasks` | `id`, `book_id`, `run_id`, `node_id`, `kind`, `title`, `status`, `revision`, `input_hash`, `resolution`, `created_at`, `updated_at` |
| `knowledge_chunks` | `id`, `source_kind`, `source_id`, `ordinal`, `title`, `text`, `anchor`, `content_hash`, `reader_ids`, `updated_at` |
| `knowledge_links` | `id`, `from_kind`, `from_id`, `to_kind`, `to_id`, `relation`, `score`, `reason`, `created_at` |
| `knowledge_link_hides` | `user_id`, `link_id`, `created_at` |
| `knowledge_feedback` | `id`, `user_id`, `chunk_id`, `judgment`, `query`, `created_at` |
| `knowledge_source_groups` | `config`, `id`, `library_id`, `title`, `source_kind`, `created_at` |
| `knowledge_subscriptions` | `name`, `group_id`, `id`, `creator_id`, `library_id`, `source_kind`, `source_id`, `url`, `source_version`, `status`, `created_at` |
| `knowledge_gaps` | `id`, `user_id`, `query`, `status`, `detail`, `created_at` |
| `webview_tickets` | `id`, `user_id`, `expires_at` |
| `qr_logins` | `id`, `secret_hash`, `user_id`, `expires_at` |
| `push_devices` | `id`, `user_id`, `token`, `platform`, `created_at`, `updated_at` |
