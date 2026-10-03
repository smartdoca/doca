import { currentSchemaTables } from "./introspection.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS "plugin_webview_auth" ("id" varchar(64) primary key,"kind" varchar(16) not null,"plugin_id" varchar(100) not null,"parent_session" varchar(64) not null,"expires_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "navigation_settings" ("id" varchar(16) primary key, "revision" integer not null, "draft" text not null, "published" text not null);`,
  `CREATE TABLE IF NOT EXISTS "plugin_registry" ("id" varchar(16) primary key, "revision" integer not null, "state" text not null);`,
  `CREATE TABLE IF NOT EXISTS "plugin_archives" ("sha256" varchar(64) primary key, "plugin_id" varchar(160) not null, "version" varchar(100) not null, "store_id" varchar(64) not null, "object_key" text not null, "size" integer not null, "file_index" text not null, "created_at" varchar(32) not null, unique ("plugin_id", "version"));`,

  `CREATE TABLE "plugin_storage_namespaces" ("plugin_id" varchar(100) primary key, "namespace" varchar(120) not null unique, "data_version" varchar(100) not null, "generation" integer not null, "state" varchar(16) not null, "definition" text, "created_at" varchar(32) not null);`,
  `CREATE TABLE "plugin_credential_keys" ("id" varchar(16) primary key, "fingerprint" varchar(64) not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE "plugin_credentials" ("plugin_id" varchar(100) not null references "plugin_storage_namespaces" ("plugin_id"), "namespace" varchar(120) not null, "generation" integer not null, "id" varchar(36) not null, "revision" integer not null check ("revision" > 0), "sealed" text not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, primary key ("namespace", "generation", "id"));`,
  `CREATE TABLE "plugin_object_garbage" ("id" varchar(36) primary key, "store_id" varchar(64) not null, "object_key" text not null unique, "created_at" varchar(32) not null);`,
  `CREATE TABLE "plugin_private_objects" ("plugin_id" varchar(100) not null references "plugin_storage_namespaces" ("plugin_id"), "generation" integer not null, "id" varchar(36) not null, "store_id" varchar(64) not null, "object_key" text not null unique, "mime" varchar(160) not null, "size" integer not null, "sha256" varchar(64) not null, "created_at" varchar(32) not null, primary key ("plugin_id", "generation", "id"));`,

  `CREATE TABLE IF NOT EXISTS "users" ("id" varchar(36) primary key, "login" varchar(160) not null unique, "display_name" varchar(160) not null, "password_hash" text not null, "admin" integer not null, "status" varchar(16) not null, "created_at" varchar(32) not null, "last_login_at" varchar(32), "public_id" varchar(160), "directory_mode" varchar(16), "profile_metadata" text default '{}' not null, "profile_revision" integer default 1 not null);`,
  `CREATE TABLE IF NOT EXISTS "file_operation_receipts" ("plugin_id" varchar(160) not null, "user_id" varchar(36) not null, "operation" varchar(32) not null, "operation_key" varchar(200) not null, "request_hash" varchar(64) not null, "status" varchar(16) not null, "result" text, "object_id" varchar(36), "profile_id" varchar(64), "object_key" text, "cleanup_at" varchar(32), "created_at" varchar(32) not null, primary key ("plugin_id", "user_id", "operation", "operation_key"));`,
  `CREATE TABLE IF NOT EXISTS "user_page_state" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "key" varchar(160) not null, "value" text not null, "version" integer not null, "updated_at" varchar(32) not null, constraint "user_page_state_pk" primary key ("user_id", "key"), constraint "user_page_state_version" check (version > 0));`,
  `CREATE TABLE IF NOT EXISTS "sessions" ("id" varchar(64) primary key, "user_id" varchar(36) not null references "users" ("id"), "expires_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "settings" ("id" varchar(16) primary key, "registration" integer not null, "revision" integer not null, "site_name" varchar(160) not null, "registration_review" integer default 0 not null, "sso_registration" varchar(16) default 'closed' not null, "social_registration" varchar(16) default 'closed' not null, "directory_mode" varchar(16) default 'all' not null, "default_locale" varchar(16) default 'zh' not null, "default_timezone" varchar(100) default 'Asia/Shanghai' not null);`,
  `CREATE TABLE IF NOT EXISTS "resources" ("id" varchar(36) primary key, "kind" varchar(16) not null, "format" varchar(24) not null, "title" varchar(160) not null, "owner_id" varchar(36) not null references "users" ("id"), "library_id" varchar(36) references "resources" ("id"), "parent_id" varchar(36) references "resources" ("id"), "access_mode" varchar(16) not null, "visibility" varchar(16) not null, "version" integer not null, "deleted_at" varchar(32), "delete_batch" varchar(36), "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "last_editor_id" varchar(36) references "users" ("id"), "last_edited_at" varchar(32), "requests_enabled" integer default 0 not null, "tree_order" integer default 0 not null, "authz_revision" integer default 1 not null, "history_readers" integer default 0 not null, "discoverable" integer default 0 not null, "public_role" varchar(16) default 'reader' not null, "content_bytes" bigint default 0 not null, "share_links_enabled" integer default 0 not null, "permission_overrides" integer default 0 not null, "page_width" varchar(16) default 'a4', "cover_asset_id" varchar(36), "ai_curated" integer default 0 not null, "knowledge_schedule" varchar(16) not null default 'off', "knowledge_preset" text not null default '', constraint "resource_kind" check (kind in ('document','library')), constraint "resource_access" check (access_mode in ('inherit','custom')), constraint "resource_visibility" check (visibility in ('invited','requestable','authenticated','public')), constraint "resource_version" check (version > 0));`,
  `CREATE INDEX "resources_owner" on "resources" ("owner_id", "deleted_at");`,
  `CREATE INDEX "resources_parent" on "resources" ("parent_id");`,
  `CREATE INDEX "resources_library" on "resources" ("library_id");`,
  `CREATE INDEX "users_created_page" on "users" ("created_at" desc, "id");`,
  `CREATE INDEX "users_status_created_page" on "users" ("status", "created_at" desc, "id");`,
  `CREATE TABLE IF NOT EXISTS "document_templates" ("id" varchar(36) primary key, "format" varchar(24) not null, "title" varchar(160) not null, "content" text not null, "preview" text default '' not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null);`,
  `CREATE INDEX IF NOT EXISTS "document_templates_format" on "document_templates" ("format", "updated_at");`,
  `CREATE TABLE IF NOT EXISTS "comments" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id"), "author_id" varchar(36) not null references "users" ("id"), "body" text not null, "parent_id" varchar(36) references "comments" ("id"), "resolved" integer not null, "deleted_at" varchar(32), "version" integer not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "anchor" text, "body_json" text);`,
  `CREATE INDEX "comments_resource" on "comments" ("resource_id", "created_at");`,
  `CREATE INDEX "comments_page" on "comments" ("resource_id", "created_at", "id");`,
  `CREATE TABLE IF NOT EXISTS "reactions" ("resource_id" varchar(36) not null references "resources" ("id"), "user_id" varchar(36) not null references "users" ("id"), "kind" varchar(16) not null, "created_at" varchar(32) not null default '', constraint "reactions_pk" primary key ("resource_id", "user_id", "kind"), constraint "reaction_kind" check (kind in ('like','favorite','pin')));`,
  `CREATE INDEX "reactions_resource_kind" on "reactions" ("resource_id", "kind", "user_id");`,
  `CREATE TABLE IF NOT EXISTS "notifications" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "type" varchar(64) not null, "read_at" varchar(32), "created_at" varchar(32) not null, "actor_id" varchar(36), "comment_id" varchar(36), "dedupe_key" varchar(240), "ticket_id" text);`,
  `CREATE INDEX "notifications_user" on "notifications" ("user_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "plugin_notifications" ("notification_id" varchar(36) primary key references "notifications" ("id") on delete cascade, "plugin_id" varchar(160) not null, "resource_type" varchar(160) not null, "resource_id" text not null, "title" text not null, "body" text not null, "path" text not null, "request_hash" varchar(64) not null, "withdrawn_at" varchar(32));`,
  `CREATE TABLE IF NOT EXISTS "audit_events" ("id" varchar(36) primary key, "actor_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "action" varchar(64) not null, "created_at" varchar(32) not null);`,
  `CREATE INDEX "audit_events_page" on "audit_events" ("resource_id", "created_at" desc, "id" desc);`,
  `CREATE TABLE IF NOT EXISTS "resource_visits" ("user_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) not null references "resources" ("id"), "visited_at" varchar(32) not null, constraint "visits_pk" primary key ("user_id", "resource_id"));`,
  `CREATE INDEX "visits_recent" on "resource_visits" ("user_id", "visited_at");`,
  `CREATE INDEX "visits_recent_page" on "resource_visits" ("user_id", "visited_at" desc, "resource_id");`,
  `CREATE TABLE IF NOT EXISTS "user_preferences" ("user_id" varchar(36) primary key references "users" ("id"), "avatar" varchar(24) not null, "theme" varchar(16) not null, "density" varchar(16) not null, "default_sort" varchar(24) not null, "sort_order" varchar(4) not null, "version" integer not null, "avatar_asset_id" varchar(36));`,
  `CREATE TABLE IF NOT EXISTS "user_presence" ("user_id" varchar(36) primary key references "users" ("id"), "last_seen_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "storage_profiles" ("id" varchar(64) primary key, "active" integer not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "assets" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "purpose" varchar(16) not null, "profile_id" varchar(64) not null references "storage_profiles" ("id"), "object_key" varchar(512) not null, "filename" varchar(255) not null, "mime" varchar(128) not null, "size" integer not null, "created_at" varchar(32) not null, "deleted_at" varchar(32), "uploaded_by" text);`,
  `CREATE INDEX "assets_resource" on "assets" ("resource_id", "deleted_at");`,
  `CREATE TABLE IF NOT EXISTS "document_states" ("resource_id" varchar(36) primary key references "resources" ("id"), "codec" varchar(64) not null, "checkpoint" text not null, "checkpoint_seq" integer not null, "seq" integer not null, "text" text not null, "updated_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "document_updates" ("resource_id" varchar(36) not null references "resources" ("id"), "seq" integer not null, "data" text not null, "author_id" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, constraint "document_updates_pk" primary key ("resource_id", "seq"));`,
  `CREATE TABLE IF NOT EXISTS "search_settings" ("id" varchar(16) primary key, "enabled" integer not null, "endpoint" text not null, "index_name" varchar(64) not null, "updated_at" varchar(32) not null, "image_recognition_enabled" integer default 0 not null, "image_policy_version" integer default 1 not null, "reconcile_interval_hours" integer default 6 not null, "generation" integer default 1 not null, "ai_min_score" real default 0.7 not null);`,
  `CREATE TABLE IF NOT EXISTS "auth_providers" ("id" varchar(36) primary key, "type" varchar(16) not null, "name" varchar(160) not null, "issuer" text not null, "client_id" varchar(256) not null, "credential_ref" varchar(64) not null, "enabled" integer not null, "version" integer not null, "profile_config" text default '{}' not null, "protocol_config" text default '{}' not null, constraint "provider_namespace" unique ("type", "issuer", "client_id"));`,
  `CREATE TABLE IF NOT EXISTS "auth_identities" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id"), "provider_id" varchar(36) not null references "auth_providers" ("id"), "subject" varchar(512) not null, "display_name" varchar(160) not null, "created_at" varchar(32) not null, constraint "identity_subject" unique ("provider_id", "subject"), constraint "identity_user_provider" unique ("user_id", "provider_id"));`,
  `CREATE TABLE IF NOT EXISTS "auth_flows" ("id" varchar(64) primary key, "browser_hash" varchar(64) not null unique, "provider_id" varchar(36) not null references "auth_providers" ("id"), "provider_version" integer not null, "verifier" text not null, "nonce" text not null, "user_id" varchar(36), "session_id" varchar(64), "expires_at" varchar(32) not null, "stage" varchar(16) not null, "identity" text, "intent" text default 'login' not null);`,
  `CREATE INDEX "auth_flow_expiry" on "auth_flows" ("expires_at");`,
  `CREATE TABLE IF NOT EXISTS "document_versions" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id"), "seq" integer not null, "checkpoint" text not null, "title" varchar(160) not null, "author_id" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "recovery_json" text);`,
  `CREATE INDEX "document_versions_resource" on "document_versions" ("resource_id", "created_at");`,
  `CREATE INDEX "document_versions_page" on "document_versions" ("resource_id", "created_at" desc, "id" desc);`,
  `CREATE TABLE IF NOT EXISTS "visit_events" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id"), "user_id" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null);`,
  `CREATE INDEX "visit_events_resource" on "visit_events" ("resource_id", "created_at");`,
  `CREATE INDEX "visit_events_page" on "visit_events" ("resource_id", "created_at" desc, "id" desc);`,
  `CREATE INDEX "visit_events_latest" on "visit_events" ("user_id", "resource_id", "created_at");`,
  `CREATE UNIQUE INDEX "users_public_id_unique" on "users" ("public_id");`,
  `CREATE UNIQUE INDEX "notification_dedupe" on "notifications" ("dedupe_key");`,
  `CREATE TABLE IF NOT EXISTS "user_card_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "distribution_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "document_references" ("source_id" varchar(36) not null references "resources" ("id") on delete cascade, "target_id" varchar(36) not null, constraint "document_reference_pk" primary key ("source_id", "target_id"));`,
  `CREATE INDEX "references_target" on "document_references" ("target_id");`,
  `CREATE TABLE IF NOT EXISTS "access_requests" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) not null, "status" varchar(16) not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "decided_by" varchar(36), "message" text default '' not null, "decision_message" text default '' not null, "operation_json" text default '{}' not null);`,
  `CREATE INDEX "requests_user_status" on "access_requests" ("user_id", "status");`,
  `CREATE TABLE IF NOT EXISTS "integration_events" ("id" varchar(36) primary key, "seq" integer not null unique, "type" varchar(80) not null, "payload" text not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "markdown_epochs" ("resource_id" varchar(36) primary key references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null);`,
  `CREATE TABLE IF NOT EXISTS "markdown_receipts" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "message_id" varchar(80) not null, "digest" varchar(64) not null, "seq" integer not null, constraint "markdown_receipts_pk" primary key ("resource_id", "epoch_id", "message_id"));`,
  `CREATE TABLE IF NOT EXISTS "editor_epochs" ("resource_id" varchar(36) primary key references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "baseline" text);`,
  `CREATE TABLE IF NOT EXISTS "editor_receipts" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "message_id" varchar(80) not null, "digest" varchar(64) not null, "seq" integer not null, constraint "editor_receipts_pk" primary key ("resource_id", "epoch_id", "message_id"));`,
  `CREATE TABLE IF NOT EXISTS "access_invitations" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) default 'reader' not null, "state" varchar(16) not null, "version" integer default 1 not null, "invited_by" varchar(36), "decided_by" varchar(36), "created_at" varchar(32) default '' not null, "updated_at" varchar(32) default '' not null, "expires_at" varchar(32), "include_descendants" integer default 1 not null, constraint "access_invitations_pk" primary key ("resource_id", "user_id"));`,
  `CREATE TABLE IF NOT EXISTS "resource_entries" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "state" varchar(16) not null, "source" varchar(24) not null, "version" integer default 1 not null, "updated_at" varchar(32) not null, constraint "resource_entries_pk" primary key ("user_id", "resource_id"));`,
  `CREATE TABLE IF NOT EXISTS "projection_jobs" ("id" varchar(160) primary key, "kind" varchar(32) not null, "payload" text not null, "revision" integer not null, "attempts" integer default 0 not null, "available_at" varchar(32) not null, "last_error" varchar(300), "lease_token" varchar(36), "lease_until" varchar(32), "status" varchar(32) default 'queued' not null, "plugin_id" varchar(160), "max_attempts" integer default 5 not null);`,
  `CREATE INDEX "projection_jobs_runtime" on "projection_jobs" ("status", "available_at", "id");`,
  `CREATE INDEX "invitations_by_user" on "access_invitations" ("user_id", "state", "resource_id");`,
  `CREATE INDEX "resources_owner_order" on "resources" ("owner_id", "deleted_at", "updated_at", "id");`,
  `CREATE INDEX "resources_library_order" on "resources" ("library_id", "deleted_at", "updated_at", "id");`,
  `CREATE INDEX "resources_parent_order" on "resources" ("parent_id", "tree_order", "id");`,
  `CREATE INDEX "favorites_by_user" on "reactions" ("user_id", "kind", "resource_id");`,
  `CREATE INDEX "sessions_user_expiry" on "sessions" ("user_id", "expires_at");`,
  `CREATE INDEX "sessions_expiry" on "sessions" ("expires_at");`,
  `CREATE INDEX "notifications_resource_time" on "notifications" ("resource_id", "created_at");`,
  `CREATE INDEX "jobs_available" on "projection_jobs" ("available_at");`,
  `CREATE TABLE IF NOT EXISTS "pending_integration_events" ("id" varchar(36) primary key, "type" varchar(80) not null, "payload" text not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "projection_cursors" ("id" varchar(64) primary key, "revision" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "invitation_history" ("id" varchar(100) primary key, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null, "role" varchar(16) not null, "state" varchar(16) not null, "version" integer not null, "invited_by" varchar(36), "decided_by" varchar(36), "created_at" varchar(32) default '' not null, "updated_at" varchar(32) default '' not null, "expires_at" varchar(32), "include_descendants" integer default 1 not null);`,
  `CREATE TABLE IF NOT EXISTS "share_links" ("generation" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "token" varchar(64) not null, "token_hash" varchar(64) not null unique, "revision" varchar(36) not null, "role" varchar(16) not null, "enabled" integer not null, "expires_at" varchar(32), "created_by" varchar(36), "created_at" varchar(32) default '' not null, "include_descendants" integer default 1 not null, "max_members" integer default 1, "revoked" integer default 0 not null, "revoked_at" varchar(32));`,
  `CREATE INDEX "links_resource" on "share_links" ("resource_id", "created_at");`,
  `CREATE INDEX "invitations_sender" on "access_invitations" ("invited_by", "state");`,
  `CREATE INDEX "invitation_history_resource" on "invitation_history" ("resource_id", "created_at");`,
  `CREATE INDEX "invitation_history_sender" on "invitation_history" ("invited_by", "created_at");`,
  `CREATE UNIQUE INDEX requests_one_pending on access_requests(resource_id, user_id) where status = 'pending';`,
  `CREATE TABLE IF NOT EXISTS "account_settings" ("id" varchar(32) primary key, "config" text not null, "revision" integer default 1 not null);`,
  `CREATE TABLE IF NOT EXISTS "login_identifiers" ("value" varchar(254) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "kind" varchar(16) not null, "active" integer default 1 not null);`,
  `CREATE INDEX "login_identifiers_user" on "login_identifiers" ("user_id", "kind");`,
  `CREATE TABLE IF NOT EXISTS "user_contacts" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "kind" varchar(16) not null, "value" varchar(254) not null, "verified_at" varchar(32) not null, "verification_source" varchar(100) not null, constraint "user_contacts_pk" primary key ("user_id", "kind"));`,
  `CREATE TABLE IF NOT EXISTS "account_flows" ("id" varchar(64) primary key, "kind" varchar(32) not null, "user_id" varchar(36), "data" text not null, "expires_at" varchar(32) not null);`,
  `CREATE INDEX "account_flows_expiry" on "account_flows" ("expires_at");`,
  `CREATE TABLE IF NOT EXISTS "verification_challenges" ("id" varchar(64) primary key, "binding" varchar(64) not null, "destination" varchar(254) not null, "kind" varchar(16) not null, "purpose" varchar(32) not null, "digest" varchar(64) not null, "attempts" integer default 0 not null, "consumed" integer default 0 not null, "created_at" varchar(32) not null, "expires_at" varchar(32) not null);`,
  `CREATE INDEX "challenge_destination_time" on "verification_challenges" ("destination", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "security_audit" ("id" varchar(36) primary key, "actor_id" varchar(36), "user_id" varchar(36), "action" varchar(80) not null, "details" text not null, "created_at" varchar(32) not null);`,
  `CREATE INDEX "security_audit_user_time" on "security_audit" ("user_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "tickets" ("id" text primary key, "kind" text not null, "source_key" text not null, "resource_id" text, "user_id" text not null, "initiator_id" text not null, "status" text not null, "role" text, "hidden_for_user_id" text, "message" text default '' not null, "created_at" text not null, "updated_at" text not null, "expires_at" text, "reminded_at" text, "resource_kind" text default 'document' not null, "operation_json" text default '{}' not null, constraint "ticket_source" unique ("kind", "source_key"));`,
  `CREATE TABLE IF NOT EXISTS "ticket_events" ("id" text primary key, "ticket_id" text not null references "tickets" ("id") on delete cascade, "actor_id" text, "status" text not null, "message" text default '' not null, "created_at" text not null, "operation_json" text default '{}' not null);`,
  `CREATE INDEX "tickets_resource" on "tickets" ("resource_id", "created_at", "id");`,
  `CREATE INDEX "tickets_status" on "tickets" ("status", "created_at", "id");`,
  `CREATE INDEX "ticket_events_time" on "ticket_events" ("ticket_id", "created_at");`,
  `CREATE INDEX "ticket_notification_time" on "notifications" ("created_at", "ticket_id");`,
  `CREATE UNIQUE INDEX "user_contacts_unique_value" on "user_contacts" ("kind", "value");`,
  `CREATE TABLE IF NOT EXISTS "registration_reviews" ("user_id" text primary key references "users" ("id") on delete cascade, "status" text not null, "reviewer_id" text, "message" text default '' not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "registration_reviews_status" on "registration_reviews" ("status", "created_at", "user_id");`,
  `CREATE INDEX "tickets_applicant" on "tickets" ("user_id", "created_at", "id");`,
  `CREATE INDEX "tickets_initiator" on "tickets" ("initiator_id", "created_at", "id");`,
  `CREATE TABLE IF NOT EXISTS "ai_sessions" ("id" text primary key, "user_id" text not null references "users" ("id"), "title" text not null, "model_id" text, "resource_ids" text not null, "archived" integer default 0 not null, "revision" integer default 1 not null, "created_at" text not null, "updated_at" text not null, "mentioned_resource_ids" text default '[]' not null, "approved_resource_ids" text default '[]' not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_session_events" ("session_id" text not null references "ai_sessions" ("id") on delete cascade, "seq" integer not null, "event_id" text not null, "digest" varchar(64) not null, "type" text not null, "payload" text not null, "created_at" text not null, constraint "ai_session_events_pk" primary key ("session_id", "seq"), constraint "ai_session_events_id" unique ("session_id", "event_id"));`,
  `CREATE INDEX IF NOT EXISTS "ai_session_events_time" on "ai_session_events" ("session_id", "seq");`,
  `CREATE INDEX "ai_sessions_user" on "ai_sessions" ("user_id", "updated_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_users" ("user_id" text primary key references "users" ("id"), "default_model" text, "memory_enabled" integer default 1 not null, "memory_revision" integer default 0 not null, "lock_version" integer default 0 not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_notes" ("user_id" varchar(36) primary key references "users" ("id") on delete cascade, "content" text default '' not null, "updated_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_secrets" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "key" varchar(64) not null, "value" text not null, "updated_at" varchar(32) not null, primary key ("user_id", "key"));`,
  `CREATE TABLE IF NOT EXISTS "ai_jobs" ("id" text primary key, "session_id" text not null references "ai_sessions" ("id"), "user_id" text not null references "users" ("id"), "model_id" text not null, "status" text not null constraint "ai_job_status" check ("status" in ('queued','running','awaiting_approval','completed','failed','cancelled','interrupted')), "input" text not null, "digest" text not null, "result" text default '' not null, "error" text default '' not null, "lease" text, "lease_until" text, "attempts" integer default 0 not null, "cancelled" integer default 0 not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "ai_jobs_queue" on "ai_jobs" ("status", "created_at");`,
  `CREATE INDEX "ai_jobs_session" on "ai_jobs" ("session_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_operations" ("id" text primary key, "user_id" text not null, "job_id" text, "digest" text not null, "result" text not null, "created_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_calls" ("id" text primary key, "user_id" text not null, "job_id" text, "model_id" text not null, "model_snapshot" text not null, "periods" text not null, "state" text not null, "input_tokens" integer default 0 not null, "output_tokens" integer default 0 not null, "cached_tokens" integer default 0 not null, "usage" text default '{}' not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "ai_calls_user" on "ai_calls" ("user_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_skills" ("id" text primary key, "user_id" text not null, "name" text not null, "description" text not null, "content" text not null, "formats" text not null, "enabled" integer not null, "revision" integer not null, "updated_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_mcp_keys" ("id" text primary key, "user_id" text not null references "users" ("id"), "name" text not null, "token_hash" text not null unique, "resource_ids" text not null, "writable" integer not null, "expires_at" text not null, "created_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "grants" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "source_type" varchar(24) default 'direct' not null, "source_id" varchar(36) default '' not null, "source_resource_id" varchar(36) references "resources" ("id") on delete cascade, "role" varchar(16) not null, "include_descendants" integer default 1 not null, "status" varchar(16) default 'active' not null, "created_by" varchar(36), "created_at" varchar(32) default '' not null, "updated_at" varchar(32) default '' not null, constraint "grants_unified_pk" primary key ("resource_id", "user_id", "source_type", "source_id"), constraint "grants_unified_source" check (source_type in ('direct','link','parent_override')), constraint "grants_unified_status" check (status in ('active','disabled')), constraint "grants_unified_role" check (role in ('reader','commenter','editor','manager')));`,
  `CREATE INDEX "grants_by_user" on "grants" ("user_id", "resource_id", "status");`,
  `CREATE INDEX "grants_by_source" on "grants" ("resource_id", "source_type", "source_id", "status");`,
  `CREATE TABLE IF NOT EXISTS "share_link_revocations" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "share_id" varchar(36) not null references "share_links" ("generation") on delete cascade, "revoked_by" varchar(36), "revoked_at" varchar(32) not null, "revoked_user_ids" text not null, constraint "share_link_revocations_unified_pk" primary key ("resource_id", "share_id"));`,
];

// File explorer tables are part of the current database bootstrap. They are
// kept separate from the document tables because the file module owns its own
// logical entries and storage-object metadata.
const fileSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "file_storage_objects" ("id" varchar(36) primary key, "profile_id" varchar(64) not null references "storage_profiles" ("id"), "object_key" varchar(512) not null unique, "sha256" varchar(64) not null, "size" bigint not null, "mime" varchar(160) not null, "category" varchar(16) default 'other' not null, "ai_description" text, "ai_status" varchar(20) default 'pending' not null, "ai_model" varchar(160), "ai_generated_at" varchar(32), "created_at" varchar(32) not null, constraint "file_object_size" check (size >= 0));`,
  `CREATE TABLE IF NOT EXISTS "file_derivatives" ("id" varchar(36) primary key, "source_id" varchar(36) not null references "file_storage_objects" ("id"), "profile_id" varchar(64) not null references "storage_profiles" ("id"), "object_key" varchar(512) not null unique, "kind" varchar(32) not null, "recipe" varchar(40) not null, "mime" varchar(160) not null, "size" bigint not null, "created_at" varchar(32) not null, constraint "file_derivative_recipe" unique ("source_id", "kind", "recipe"));`,
  `CREATE TABLE IF NOT EXISTS "file_extracts" ("storage_object_id" varchar(36) primary key references "file_storage_objects" ("id") on delete cascade, "status" varchar(16) not null, "result" text not null, "error" text, "updated_at" varchar(32) not null);`,
  `CREATE INDEX IF NOT EXISTS "file_objects_sha" on "file_storage_objects" ("sha256", "size");`,
  `CREATE TABLE IF NOT EXISTS "file_folders" ("id" varchar(36) primary key, "storage_namespace" varchar(120) default 'host' not null, "owner_id" varchar(36) not null references "users" ("id") on delete cascade, "parent_id" varchar(36), "name" varchar(255) not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32), "delete_batch" varchar(36), constraint "file_folder_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_folders_parent" on "file_folders" ("owner_id", "parent_id", "deleted_at", "name");`,
  `CREATE TABLE IF NOT EXISTS "file_folder_shares" ("folder_id" varchar(36) not null references "file_folders" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "file_folder_shares_pk" primary key ("folder_id", "user_id"), constraint "file_folder_share_role" check (role in ('admin','reader')), constraint "file_folder_share_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_folder_shares_user" on "file_folder_shares" ("user_id", "folder_id", "role");`,
  `CREATE TABLE IF NOT EXISTS "file_folder_share_links" ("folder_id" varchar(36) primary key references "file_folders" ("id") on delete cascade, "token" varchar(64) not null unique, "token_hash" varchar(64) not null unique, "role" varchar(16) default 'reader' not null, "enabled" integer default 1 not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "file_folder_link_role" check (role in ('admin','reader')));`,
  `CREATE TABLE IF NOT EXISTS "file_items" ("id" varchar(36) primary key, "storage_namespace" varchar(120) default 'host' not null, "owner_id" varchar(36) not null references "users" ("id") on delete cascade, "parent_type" varchar(16) not null, "parent_id" varchar(36) not null, "storage_object_id" varchar(36) not null references "file_storage_objects" ("id"), "name" varchar(255) not null, "mime" varchar(160) not null, "size" bigint not null, "metadata" text default '{}' not null, "ai_description_override" text, "locked" integer default 0 not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32), "delete_batch" varchar(36), constraint "file_item_parent_type" check (parent_type in ('system','folder','document')), constraint "file_item_size" check (size >= 0), constraint "file_item_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_items_parent" on "file_items" ("owner_id", "parent_type", "parent_id", "deleted_at", "name");`,
  `CREATE INDEX IF NOT EXISTS "file_items_storage" on "file_items" ("storage_object_id", "deleted_at");`,
  `CREATE TABLE IF NOT EXISTS "file_bindings" ("id" varchar(36) primary key, "file_id" varchar(36) not null references "file_items" ("id") on delete cascade, "owner_plugin" varchar(160) not null, "owner_type" varchar(120) not null, "owner_id" varchar(160) not null, "role" varchar(120) not null, "created_at" varchar(32) not null, constraint "file_bindings_owner" unique ("file_id", "owner_plugin", "owner_type", "owner_id", "role"));`,
  `CREATE INDEX IF NOT EXISTS "file_bindings_lookup" on "file_bindings" ("owner_plugin", "owner_type", "owner_id", "role");`,
  `CREATE TABLE IF NOT EXISTS "file_recognition_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer default 0 not null);`,
];

const searchSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "search_reconciliation" ("id" varchar(16) primary key, "generation" integer not null, "round_id" varchar(36) not null, "phase" varchar(16) not null, "cursor" text not null, "remote_offset" integer not null, "scanned" integer not null, "differences" integer not null, "started_at" varchar(32), "checked_at" varchar(32), "completed_at" varchar(32), "next_at" varchar(32) not null, "lease_token" varchar(36), "lease_until" varchar(32), "last_error" text);`,
  `CREATE TABLE IF NOT EXISTS "search_reconcile_entries" ("id" varchar(512) primary key, "round_id" varchar(36) not null, "content_hash" varchar(64), "pending" integer default 0 not null);`,
  `CREATE TABLE IF NOT EXISTS "search_embedding_task" ("id" text primary key, "operation_id" text not null, "endpoint" text not null, "index_name" text not null, "embedder_name" text not null, "task_uid" bigint, "status" text not null, "updated_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "search_embedding_models" ("id" text primary key, "endpoint" text not null, "index_name" text not null, "embedder_name" text not null, "model_id" text not null, "fingerprint" text not null, "operation_id" text not null, "applied" integer default 0 not null, "document_template" text, "document_template_max_bytes" integer, "applied_at" text);`,
];

async function createFileSchema(db: Kysely<any>) {
  for (const statement of fileSchemaStatements)
    await sql.raw(statement).execute(db);
}

async function createSearchSchema(db: Kysely<any>) {
  for (const statement of searchSchemaStatements)
    await sql.raw(statement).execute(db);
}

async function seedSystemRows(db: Kysely<any>) {
  const now = new Date().toISOString();
  await db
    .insertInto("settings")
    .values({
      id: "system",
      registration: 0,
      revision: 1,
      site_name: "Doca",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("storage_profiles")
    .values({
      id: requiredFileStoreId(),
      active: 1,
      created_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("search_settings")
    .values({
      id: "system",
      enabled: 0,
      endpoint: "http://127.0.0.1:7700",
      index_name: "doca_documents",
      updated_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("user_card_settings")
    .values({ id: "system", config: "{}", revision: 0 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("distribution_settings")
    .values({ id: "system", config: "{}", revision: 0 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("projection_cursors")
    .values({ id: "integration-stream", revision: 0 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("account_settings")
    .values([{ id: "identity", config: "{}", revision: 1 }])
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  const settings = await db
    .selectFrom("search_settings")
    .select("generation")
    .where("id", "=", "system")
    .executeTakeFirst();
  await db
    .insertInto("search_reconciliation")
    .values({
      id: "system",
      generation: settings?.generation ?? 1,
      round_id: "",
      phase: "idle",
      cursor: "",
      remote_offset: 0,
      scanned: 0,
      differences: 0,
      next_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("search_embedding_task")
    .values({
      id: "system",
      operation_id: "",
      endpoint: "",
      index_name: "",
      embedder_name: "",
      task_uid: null,
      status: "idle",
      updated_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

const knowledgeSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "knowledge_chunks" ("id" varchar(80) primary key, "source_kind" varchar(16) not null, "source_id" varchar(36) not null, "ordinal" integer not null, "title" varchar(200) not null, "text" text not null, "anchor" text not null, "content_hash" varchar(64) not null, "reader_ids" text not null, "updated_at" varchar(32) not null, constraint "knowledge_chunk_ordinal" unique ("source_kind", "source_id", "ordinal"))`,
  `CREATE INDEX IF NOT EXISTS "knowledge_chunks_source" on "knowledge_chunks" ("source_kind", "source_id")`,
  `CREATE TABLE IF NOT EXISTS "knowledge_links" ("id" varchar(36) primary key, "from_kind" varchar(16) not null, "from_id" varchar(36) not null, "to_kind" varchar(16) not null, "to_id" varchar(36) not null, "relation" varchar(16) not null, "score" real not null, "reason" varchar(300) not null, "created_at" varchar(32) not null, constraint "knowledge_link_pair" unique ("from_kind", "from_id", "to_kind", "to_id", "relation"))`,
  `CREATE INDEX IF NOT EXISTS "knowledge_links_from" on "knowledge_links" ("from_kind", "from_id")`,
  `CREATE TABLE IF NOT EXISTS "knowledge_link_hides" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "link_id" varchar(36) not null references "knowledge_links" ("id") on delete cascade, "created_at" varchar(32) not null, constraint "knowledge_link_hides_pk" primary key ("user_id", "link_id"))`,
  `CREATE TABLE IF NOT EXISTS "knowledge_feedback" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "chunk_id" varchar(80) not null, "judgment" varchar(16) not null, "query" varchar(300) not null, "created_at" varchar(32) not null)`,
  `CREATE INDEX IF NOT EXISTS "knowledge_feedback_user" on "knowledge_feedback" ("user_id", "chunk_id")`,
  `CREATE TABLE IF NOT EXISTS "knowledge_gaps" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "query" varchar(300) not null, "status" varchar(16) not null, "detail" text not null, "created_at" varchar(32) not null)`,
  `CREATE INDEX IF NOT EXISTS "knowledge_gaps_user" on "knowledge_gaps" ("user_id", "created_at")`,
];

const knowledgeSystemStatements = [
  `CREATE TABLE IF NOT EXISTS knowledge_instructions (library_id varchar(36) not null references resources(id), path varchar(160) not null, revision integer not null, markdown text not null, author_id varchar(36) not null, created_at varchar(32) not null, primary key(library_id, path, revision))`,
  `CREATE TABLE IF NOT EXISTS knowledge_settings (library_id varchar(36) primary key references resources(id), revision integer not null, config text not null, updated_at varchar(32) not null)`,
  `CREATE TABLE IF NOT EXISTS knowledge_entries (id varchar(36) primary key, library_id varchar(36) not null references resources(id), title varchar(200) not null, markdown text not null, origin varchar(24) not null, status varchar(24) not null, revision integer not null, source_refs text not null, instruction_hash varchar(64) not null, review_state text not null, author_id varchar(36) not null, created_at varchar(32) not null, updated_at varchar(32) not null)`,
  `CREATE INDEX IF NOT EXISTS knowledge_entries_library ON knowledge_entries(library_id, status)`,
  `CREATE TABLE IF NOT EXISTS knowledge_entry_versions (entry_id varchar(36) not null references knowledge_entries(id), revision integer not null, snapshot text not null, author_id varchar(36) not null, created_at varchar(32) not null, primary key(entry_id, revision))`,
  `CREATE TABLE IF NOT EXISTS knowledge_assistants (id varchar(36) primary key, owner_id varchar(36) not null references users(id), title varchar(200) not null, revision integer not null, library_ids text not null, member_ids text not null, enabled integer not null, visibility varchar(24) not null default 'invited', manager_ids text not null default '[]', config text not null default '{}', updated_at varchar(32) not null)`,
];

async function createKnowledgeSchema(db: Kysely<any>) {
  for (const statement of knowledgeSystemStatements)
    await sql.raw(statement).execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS ai_session_resources (session_id varchar(36) not null references ai_sessions(id) on delete cascade, kind varchar(32) not null, resource_id varchar(160) not null, title text not null, href text not null, touched_at varchar(32) not null, primary key(session_id,kind,resource_id))",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE INDEX IF NOT EXISTS ai_session_resources_recent ON ai_session_resources(resource_id,touched_at desc)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS knowledge_bot_sharing (bot_id varchar(36) primary key references knowledge_assistants(id) on delete cascade, enabled integer not null default 0)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS knowledge_bot_share_links (id varchar(36) primary key, bot_id varchar(36) not null references knowledge_assistants(id) on delete cascade, token varchar(43) not null unique, enabled integer not null, revoked_at varchar(32), expires_at varchar(32), max_members integer, version varchar(36) not null, created_at varchar(32) not null)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS knowledge_bot_link_members (link_id varchar(36) not null references knowledge_bot_share_links(id) on delete cascade, user_id varchar(36) not null references users(id), created_at varchar(32) not null, primary key (link_id,user_id))",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE INDEX IF NOT EXISTS knowledge_bot_share_links_bot ON knowledge_bot_share_links (bot_id, created_at)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE INDEX IF NOT EXISTS knowledge_bot_link_members_user ON knowledge_bot_link_members (user_id, link_id)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS knowledge_bot_keys (id varchar(36) primary key, bot_id varchar(36) not null references knowledge_assistants(id) on delete cascade, creator_id varchar(36) not null references users(id), name text not null, channel varchar(16) not null, token_hash varchar(64) not null unique, expires_at varchar(32) not null, created_at varchar(32) not null)",
    )
    .execute(db);
  await sql
    .raw(
      "CREATE TABLE IF NOT EXISTS knowledge_assistant_users (assistant_id varchar(36) not null references knowledge_assistants(id) on delete cascade, user_id varchar(36) not null references users(id), accepted integer not null default 0, visited_at varchar(32), integration varchar(16) not null default 'default', revision integer not null default 1, primary key (assistant_id, user_id))",
    )
    .execute(db);
  for (const statement of knowledgeSchemaStatements)
    await sql.raw(statement).execute(db);
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS knowledge_source_groups (id varchar(36) primary key, library_id varchar(36) not null references resources(id) on delete cascade, title text not null, source_kind varchar(16) not null, config text not null default '{}', created_at varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS "knowledge_subscriptions" ("id" varchar(36) primary key, "library_id" varchar(36) not null references "resources" ("id") on delete cascade, "source_kind" varchar(16) not null, "source_id" varchar(36) not null default '', "url" text not null default '', "node_id" varchar(36) references "resources" ("id") on delete set null, "source_version" varchar(64) not null default '', "status" varchar(16) not null default 'active', "creator_id" varchar(36) not null default '', "preset" text not null default '', "group_id" varchar(36) references "knowledge_source_groups" ("id") on delete set null, "name" text not null default '', "created_at" varchar(32) not null, constraint "knowledge_subscription_source" unique ("library_id", "source_kind", "source_id", "url"))`,
    `CREATE INDEX IF NOT EXISTS "knowledge_subscriptions_library" on "knowledge_subscriptions" ("library_id")`,
    `CREATE TABLE IF NOT EXISTS "knowledge_runs" ("id" varchar(36) primary key, "library_id" varchar(36) not null references "resources" ("id") on delete cascade, "trigger" varchar(16) not null, "status" varchar(16) not null, "detail" text not null default '', "created_at" varchar(32) not null)`,
    `CREATE INDEX IF NOT EXISTS "knowledge_runs_library" on "knowledge_runs" ("library_id", "created_at")`,
    `CREATE TABLE IF NOT EXISTS "knowledge_bots" ("library_id" varchar(36) primary key references "resources" ("id") on delete cascade, "title" varchar(200) not null default '', "published" integer not null default 0, "updated_at" varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS "knowledge_directories" ("library_id" varchar(36) not null references "resources" ("id") on delete cascade, "path" varchar(800) not null, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, primary key ("library_id", "path"))`,
  ])
    await sql.raw(statement).execute(db);
}

async function createKnowledgeStudioSchema(db: Kysely<any>) {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS knowledge_checkpoints (task_id varchar(36) primary key, detail text not null default '{}', attempts integer not null default 0, available_at varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS knowledge_source_observations (library_id varchar(36) not null, source_id varchar(36) not null, fingerprint text not null, updated_at varchar(32) not null, PRIMARY KEY(library_id,source_id))`,
    `CREATE TABLE IF NOT EXISTS knowledge_conversations (id varchar(36) primary key, scope_id varchar(36) not null, kind varchar(16) not null, owner_id varchar(36) not null, title text not null, summary text not null default '', state varchar(16) not null default 'idle', archived integer not null default 0, access_key_id varchar(36), created_at varchar(32) not null, updated_at varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS knowledge_human_tasks (id varchar(36) primary key, library_id varchar(36) not null references resources(id) on delete cascade, conversation_id varchar(36) not null references knowledge_conversations(id) on delete cascade, task_key varchar(300) not null, kind varchar(32) not null, title text not null, detail text not null, status varchar(16) not null, revision integer not null, resolution text not null default '', created_at varchar(32) not null, updated_at varchar(32) not null, UNIQUE(library_id,task_key))`,
    `CREATE INDEX IF NOT EXISTS knowledge_conversation_scope ON knowledge_conversations(scope_id,kind)`,
    `CREATE TABLE IF NOT EXISTS knowledge_messages (id varchar(36) primary key, conversation_id varchar(36) not null references knowledge_conversations(id) on delete cascade, role varchar(16) not null, author_id varchar(36), trigger varchar(16) not null, content text not null, detail text not null default '{}', created_at varchar(32) not null)`,
    `CREATE INDEX IF NOT EXISTS knowledge_message_thread ON knowledge_messages(conversation_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS knowledge_tasks (id varchar(36) primary key, conversation_id varchar(36) not null references knowledge_conversations(id) on delete cascade, actor_id varchar(36) not null, status varchar(16) not null, error text not null default '', created_at varchar(32) not null, updated_at varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS knowledge_cases (id varchar(36) primary key, bot_id varchar(36) not null, message_id varchar(36) not null, user_id varchar(36) not null, judgment varchar(16) not null, reason text not null, snapshot text not null, status varchar(16) not null default 'open', created_at varchar(32) not null, UNIQUE(message_id,user_id))`,
    `CREATE TABLE IF NOT EXISTS knowledge_source_actions (id varchar(36) primary key, library_id varchar(36) not null, source_key text not null, actor_id varchar(36) not null, action varchar(32) not null, detail text not null, created_at varchar(32) not null)`,
    `CREATE TABLE IF NOT EXISTS knowledge_publications (library_id varchar(36) primary key, revision integer not null, fingerprint text not null, documents text not null, status varchar(16) not null, error text not null, updated_at varchar(32) not null)`,
  ])
    await sql.raw(statement).execute(db);
}

export const CURRENT_SCHEMA_BASELINE = "doca-2026-10-03-credentials-v2";

async function createSystemSchema(db: Kysely<any>) {
  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS "schema_baseline" ("id" varchar(64) primary key, "created_at" varchar(32) not null)`,
    )
    .execute(db);
  const now = new Date().toISOString();
  await db
    .insertInto("schema_baseline")
    .values({ id: CURRENT_SCHEMA_BASELINE, created_at: now })
    .execute();
}

export async function validateSchema(db: Kysely<any>) {
  const hasSchema = (await currentSchemaTables(db)).some(
    (table) => table.name === "schema_baseline",
  );
  if (!hasSchema)
    throw new Error(
      "Database is not a current Doca baseline; create a new database",
    );
  const row = await db
    .selectFrom("schema_baseline")
    .select("id")
    .where("id", "=", CURRENT_SCHEMA_BASELINE)
    .executeTakeFirst();
  if (!row)
    throw new Error(
      "Database baseline is not supported; create a new database",
    );
  const required: Record<string, readonly string[]> = {
    plugin_archives: [
      "sha256",
      "plugin_id",
      "version",
      "store_id",
      "object_key",
      "size",
      "file_index",
      "created_at",
    ],
    storage_profiles: ["id", "active", "created_at"],
    plugin_storage_namespaces: [
      "plugin_id",
      "namespace",
      "data_version",
      "generation",
      "state",
      "definition",
      "created_at",
    ],
    plugin_object_garbage: ["id", "store_id", "object_key", "created_at"],
    plugin_credential_keys: ["id", "fingerprint", "created_at"],
    plugin_credentials: [
      "plugin_id",
      "namespace",
      "generation",
      "id",
      "revision",
      "sealed",
      "created_at",
      "updated_at",
    ],
    plugin_private_objects: [
      "plugin_id",
      "generation",
      "id",
      "store_id",
      "object_key",
      "mime",
      "size",
      "sha256",
      "created_at",
    ],
  };
  const tables = await currentSchemaTables(db);
  for (const [name, columns] of Object.entries(required)) {
    const table = tables.find((t) => t.name === name);
    if (
      !table ||
      table.columns.length !== columns.length ||
      columns.some((c) => !table.columns.some((v) => v.name === c))
    )
      throw new Error(
        "Current database storage structure is incomplete or unsupported; restore a complete database",
      );
  }
}

export async function createSchema(db: Kysely<any>) {
  if ((await currentSchemaTables(db)).length > 0) {
    await validateSchema(db);
    return;
  }

  for (const statement of schemaStatements)
    await sql.raw(statement).execute(db);

  await createFileSchema(db);
  await createDiscoverySchema(db);
  await createSearchSchema(db);
  await createKnowledgeSchema(db);
  await createKnowledgeStudioSchema(db);
  await createMobileSchema(db);
  await seedSystemRows(db);
  await createSystemSchema(db);
}

async function createMobileSchema(db: Kysely<any>) {
  for (const statement of [
    `CREATE TABLE IF NOT EXISTS "webview_tickets" ("id" varchar(64) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "expires_at" varchar(32) not null)`,
    `CREATE INDEX IF NOT EXISTS "webview_tickets_expiry" on "webview_tickets" ("expires_at")`,
    `CREATE TABLE IF NOT EXISTS "qr_logins" ("id" varchar(64) primary key, "secret_hash" varchar(64) not null, "user_id" varchar(36) references "users" ("id") on delete cascade, "expires_at" varchar(32) not null)`,
    `CREATE INDEX IF NOT EXISTS "qr_logins_expiry" on "qr_logins" ("expires_at")`,
    `CREATE TABLE IF NOT EXISTS "push_devices" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "token" varchar(200) not null unique, "platform" varchar(16) not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null)`,
    `CREATE INDEX IF NOT EXISTS "push_devices_user" on "push_devices" ("user_id")`,
  ])
    await sql.raw(statement).execute(db);
}

async function createDiscoverySchema(db: Kysely<any>) {
  await sql`CREATE TABLE IF NOT EXISTS workspace_activity (user_id varchar(36) not null references users(id) on delete cascade, resource_kind varchar(16) not null, resource_id varchar(36) not null, visited_at varchar(32), favorite integer not null default 0, primary key(user_id,resource_kind,resource_id))`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS workspace_activity_recent_idx ON workspace_activity(user_id,visited_at)`.execute(
    db,
  );
  await sql`CREATE TABLE IF NOT EXISTS resource_collections (user_id varchar(36) not null references users(id) on delete cascade, resource_kind varchar(16) not null, resource_id varchar(36) not null, created_at varchar(32) not null, primary key(user_id,resource_kind,resource_id))`.execute(
    db,
  );

  await sql`CREATE TABLE IF NOT EXISTS folder_publications (folder_id varchar(36) primary key references file_folders(id) on delete cascade, enabled integer not null, revision integer not null)`.execute(
    db,
  );
  await sql`CREATE TABLE IF NOT EXISTS folder_entries (folder_id varchar(36) not null references file_folders(id) on delete cascade, user_id varchar(36) not null references users(id) on delete cascade, state varchar(16) not null, updated_at varchar(32) not null, primary key(folder_id, user_id))`.execute(
    db,
  );
}

function requiredFileStoreId() {
  const id = process.env.DOCA_FILE_STORE_ID;
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new Error("DOCA_FILE_STORE_ID is required");
  return id;
}
