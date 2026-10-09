# Database reference

[中文](database.zh-CN.md)

The current baseline is `doca-2026-10-09-history-storage-v1`. [create-schema.ts](../packages/db/src/create-schema.ts) defines tables, indexes, foreign keys, and checks; [schema.ts](../packages/db/src/schema.ts) defines Kysely types; [connection.ts](../packages/db/src/connection.ts) opens connections; [transactions.ts](../packages/db/src/transactions.ts) manages transactions and conflict retries.

Empty databases are initialized with the current schema. Startup validates the baseline and required storage/credential shapes and rejects earlier baselines without automatic migration. Only the exact preceding baseline supports the explicit offline history-storage upgrade in the [release requirements](releases/0.1.14.md); preserve data, files and configuration. The existing document_templates table is retained without CRUD or automatic registration as a resource provider; see [templates and materials](creation-resources.md). These are current implementation facts, not a new migration plan.

## Connections, initialization, and backup

SQLite enables foreign_keys, WAL, busy_timeout=5000, and synchronous=FULL. Source development uses `data/v1/doca.db`; Compose persists `/data/doca.db` in doca_data. A reliable backup must include WAL consistently or use a SQLite backup/checkpoint procedure; copying only an actively written .db is insufficient.

PostgreSQL uses pg with a default maximum pool of 10. Operators configure its URL and schema through environment settings. Shared PostgreSQL, Redis, and accessible file stores are required for multiple replicas; see [horizontal scaling](horizontal-scaling.md). Driver support and recorded isolated checks do not replace acceptance against the actual database and object service.

The host and AI modules can use separately configured database connections. Back up every configured database, referenced file store, and protected deployment configuration, including the credential master key. Restore them consistently into an isolated environment before production recovery.

## Identifiers and concurrency

- Most resource/account IDs are random UUID strings; protocol digests, singleton IDs, and operation keys use their declared formats.
- Times are UTC ISO 8601 strings. Keep one normalized format for ordering.
- Cross-database booleans use integer 0/1, commonly converted to API booleans. JSON is stored as text where declared.
- Metadata version, configuration revision, authorization revision, collaboration seq/epoch, and operation receipts have distinct meanings; never substitute one for another.
- Soft deletion uses deleted_at where provided; not every table has a deletion column. Composite keys, unique indexes, foreign keys, and serialized transactions enforce the relevant constraints.
- Request JSON generally uses camelCase, while resource/database projections may use snake_case; consult [HTTP API](api.md).

## Resources, discovery, and authorization

resources holds both document and library identities. Formats include rich_text, markdown, spreadsheet, canvas, and presentation. owner_id identifies the single owner separately from grants. access_mode is inherit/custom; visibility is invited/requestable/authenticated/public. Authorization and discovery are separate: discoverable titles or collection entries do not grant body access.

Personal documents have kind=document, owner_id=current user, and no library_id or parent_id. Libraries cannot nest. A document has one location; parents must belong to the same library and parent chains cannot cycle. Foreign keys prevent dangling references, while core transactions validate cross-row tree rules. Manual SQL can still violate invariants and is not a supported product-write API.

The grant key is `(resource_id,user_id,source_type,source_id)`. direct/link/parent_override grants and active/disabled state feed current permission evaluation. share_links and share_link_revocations record link generations, access, and revocation facts. Invitations, requests, collections, entries, and tickets model their distinct workflows. Read [permissions](permission-inheritance.md) and [discovery](public-resource-discovery.md) for exact rules.

last_editor_id/last_edited_at records real creation, independent copy, renaming, and effective body updates. Reads, unchanged synchronization, and permission changes do not rewrite it. Visits are personal and filtered by current access and deletion. user_preferences uses optimistic version conditions, with default version=0 before its first saved record; it does not share the profile revision.

## Content, references, and collaboration

Persisted content uses document_states/checkpoints and document_updates; editor/Markdown epochs and receipts identify ordered operations and deduplicate retries. document_versions stores business history with recovery data. Codec, schema, baseline, seq, and epoch are editor-specific; all five formats use their implemented persistence paths. See the [collaboration contract](collaboration-sdk-contract.md), [collaboration guide](collaboration.md), and [editor integration](editor-integration.md).

Document references, integration events, pending events, projection jobs/cursors, and search reconciliation separate authoritative content/authorization from derived indexes. References do not grant access. Search settings/tasks/model fingerprints and reconciliation entries track configuration and repair state without duplicating plaintext model secrets. Projection failure must not fabricate a successful content save.

Comments keep root/reply relationships, body/body_json, optional current-protocol anchors, resolution, and deletion state. Comment text/rich content is rendered safely. Notifications have recipients, actors, deduplication/ticket fields, and optional plugin metadata. Audit/security records contain action metadata rather than copied document bodies. See [comments and notifications](comments-and-community.md) and [authentication](authentication.md).

## Files and plugin state

storage_profiles contains only stable id, active, and created_at. Backend configuration and credentials come from the environment; there are no provider/config columns or writable administrator storage configuration in this baseline. assets and file_storage_objects retain stable store/object identities; file_items/folders/bindings, derivatives, extracts, and operation receipts manage user files and content processing. File bytes are separate from database rows. Never remove a shared physical object because one referencing document or history row was removed. See [file storage](storage.md).

Plugin namespaces bind plugin_id, namespace, data_version, generation, state, and declared definitions. Managed SQL business tables are defined through the plugin storage service and are not a fixed list in Schema. Private objects, garbage records, immutable archives, registry state, WebView sessions, and navigation settings remain host-managed. plugin_credentials stores encrypted sealed values with namespace/generation/revision; plugin_credential_keys stores key fingerprints, not the master key. See [plugin storage](plugin-horizontal-scaling.md) and [credentials](plugin-credentials.md).

## AI and knowledge workflows

AI sessions separate user-mentioned resources, explicitly approved resources, and display/history associations; resource_ids alone does not authorize model access. Jobs store approval summaries and parameter digests, relinquish leases while awaiting approval, and resume only after authenticated ownership checks. AI calls preserve original usage facts; accounting/policy business modules do not replace them. Secrets, skills, MCP keys, notes, operation receipts, and session events have separate tables and access boundaries.

Native source subscriptions, chunks and links retain indexing/search. The knowledge-book tables below persist editable configuration histories, contributor sources, feedback, workflow runs, immutable releases and human tasks. Original source permissions protect all derived results. Old curation and Q&A tables are absent from fresh databases; old records are never migrated or deleted.

## Current table and field inventory

The inventory below reflects the current Schema interface. Field names are listed exhaustively; exact SQL types, nullability, defaults, primary/unique keys, and foreign keys remain defined by create-schema.ts. Optional TypeScript properties do not imply nullable SQL columns. This is a reference, not an instruction to create or modify tables manually.

| Table | Fields |
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
