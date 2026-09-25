import type { Kysely } from "kysely";
import { sql } from "kysely";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS "users" ("id" varchar(36) primary key, "login" varchar(160) not null unique, "display_name" varchar(160) not null, "password_hash" text not null, "admin" integer not null, "status" varchar(16) not null, "created_at" varchar(32) not null, "public_id" varchar(160), "directory_mode" varchar(16), "profile_metadata" text default '{}' not null, "profile_revision" integer default 1 not null, "base_level" varchar(64) default 'standard' not null, "identity_class" varchar(64) default '' not null, "level_source" varchar(80) default 'default' not null, "level_override" integer default 0 not null, "level_revision" integer default 1 not null, "timed_level" text, "timed_level_expires_at" bigint);`,
  `CREATE TABLE IF NOT EXISTS "sessions" ("id" varchar(64) primary key, "user_id" varchar(36) not null references "users" ("id"), "expires_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "settings" ("id" varchar(16) primary key, "registration" integer not null, "revision" integer not null, "site_name" varchar(160) not null, "registration_review" integer default 0 not null, "sso_registration" varchar(16) default 'closed' not null, "social_registration" varchar(16) default 'closed' not null, "directory_mode" varchar(16) default 'all' not null);`,
  `CREATE TABLE IF NOT EXISTS "resources" ("id" varchar(36) primary key, "kind" varchar(16) not null, "format" varchar(24) not null, "title" varchar(160) not null, "owner_id" varchar(36) not null references "users" ("id"), "library_id" varchar(36) references "resources" ("id"), "parent_id" varchar(36) references "resources" ("id"), "access_mode" varchar(16) not null, "visibility" varchar(16) not null, "version" integer not null, "deleted_at" varchar(32), "delete_batch" varchar(36), "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "last_editor_id" varchar(36) references "users" ("id"), "last_edited_at" varchar(32), "requests_enabled" integer default 0 not null, "tree_order" integer default 0 not null, "authz_revision" integer default 1 not null, "history_readers" integer default 0 not null, "discoverable" integer default 0 not null, "public_role" varchar(16) default 'reader' not null, "content_bytes" bigint default 0 not null, "share_links_enabled" integer default 0 not null, "permission_overrides" integer default 0 not null, "moderation_status" text default 'active' not null, "moderation_hold" integer default 0 not null, "moderation_revision" integer default 0 not null, constraint "resource_kind" check (kind in ('document','library')), constraint "resource_access" check (access_mode in ('inherit','custom')), constraint "resource_visibility" check (visibility in ('invited','requestable','authenticated','public')), constraint "resource_version" check (version > 0));`,
  `CREATE INDEX "resources_owner" on "resources" ("owner_id", "deleted_at");`,
  `CREATE INDEX "resources_parent" on "resources" ("parent_id");`,
  `CREATE INDEX "resources_library" on "resources" ("library_id");`,
  `CREATE TABLE IF NOT EXISTS "document_templates" ("id" varchar(36) primary key, "format" varchar(24) not null, "title" varchar(160) not null, "content" text not null, "preview" text default '' not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null);`,
  `CREATE INDEX IF NOT EXISTS "document_templates_format" on "document_templates" ("format", "updated_at");`,
  `CREATE TABLE IF NOT EXISTS "comments" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id"), "author_id" varchar(36) not null references "users" ("id"), "body" text not null, "parent_id" varchar(36) references "comments" ("id"), "resolved" integer not null, "deleted_at" varchar(32), "version" integer not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "anchor" text, "body_json" text);`,
  `CREATE INDEX "comments_resource" on "comments" ("resource_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "reactions" ("resource_id" varchar(36) not null references "resources" ("id"), "user_id" varchar(36) not null references "users" ("id"), "kind" varchar(16) not null, "created_at" varchar(32) not null default '', constraint "reactions_pk" primary key ("resource_id", "user_id", "kind"), constraint "reaction_kind" check (kind in ('like','favorite','pin')));`,
  `CREATE TABLE IF NOT EXISTS "notifications" ("id" varchar(36) primary key, "user_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "type" varchar(64) not null, "read_at" varchar(32), "created_at" varchar(32) not null, "actor_id" varchar(36), "comment_id" varchar(36), "dedupe_key" varchar(240), "ticket_id" text);`,
  `CREATE INDEX "notifications_user" on "notifications" ("user_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "audit_events" ("id" varchar(36) primary key, "actor_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "action" varchar(64) not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "resource_visits" ("user_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) not null references "resources" ("id"), "visited_at" varchar(32) not null, constraint "visits_pk" primary key ("user_id", "resource_id"));`,
  `CREATE INDEX "visits_recent" on "resource_visits" ("user_id", "visited_at");`,
  `CREATE TABLE IF NOT EXISTS "user_preferences" ("user_id" varchar(36) primary key references "users" ("id"), "avatar" varchar(24) not null, "theme" varchar(16) not null, "density" varchar(16) not null, "default_sort" varchar(24) not null, "sort_order" varchar(4) not null, "version" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "user_presence" ("user_id" varchar(36) primary key references "users" ("id"), "last_seen_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "storage_profiles" ("id" varchar(36) primary key, "provider" varchar(16) not null, "config" text not null, "active" integer not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "assets" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) references "resources" ("id"), "purpose" varchar(16) not null, "profile_id" varchar(36) not null references "storage_profiles" ("id"), "object_key" varchar(160) not null, "filename" varchar(255) not null, "mime" varchar(128) not null, "size" integer not null, "created_at" varchar(32) not null, "deleted_at" varchar(32), "moderation_status" text default 'none' not null, "uploaded_by" text);`,
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
  `CREATE TABLE IF NOT EXISTS "visit_events" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id"), "user_id" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null);`,
  `CREATE INDEX "visit_events_resource" on "visit_events" ("resource_id", "created_at");`,
  `CREATE UNIQUE INDEX "users_public_id_unique" on "users" ("public_id");`,
  `CREATE UNIQUE INDEX "notification_dedupe" on "notifications" ("dedupe_key");`,
  `CREATE TABLE IF NOT EXISTS "user_activity" ("user_id" varchar(36) not null references "users" ("id"), "resource_id" varchar(36) not null references "resources" ("id"), "day" varchar(10) not null, "read_at" varchar(32), "edited_at" varchar(32), constraint "user_activity_pk" primary key ("user_id", "day", "resource_id"));`,
  `CREATE INDEX "activity_resource_day" on "user_activity" ("resource_id", "day");`,
  `CREATE TABLE IF NOT EXISTS "user_card_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "distribution_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "document_references" ("source_id" varchar(36) not null references "resources" ("id") on delete cascade, "target_id" varchar(36) not null, constraint "document_reference_pk" primary key ("source_id", "target_id"));`,
  `CREATE INDEX "references_target" on "document_references" ("target_id");`,
  `CREATE TABLE IF NOT EXISTS "document_reference_index" ("resource_id" varchar(36) primary key references "resources" ("id") on delete cascade, "seq" integer not null);`,
  `CREATE TABLE IF NOT EXISTS "access_requests" ("id" varchar(36) primary key, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) not null, "status" varchar(16) not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "decided_by" varchar(36), "message" text default '' not null, "decision_message" text default '' not null, "operation_json" text default '{}' not null);`,
  `CREATE INDEX "requests_user_status" on "access_requests" ("user_id", "status");`,
  `CREATE TABLE IF NOT EXISTS "integration_events" ("id" varchar(36) primary key, "seq" integer not null unique, "type" varchar(80) not null, "payload" text not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "markdown_epochs" ("resource_id" varchar(36) primary key references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null);`,
  `CREATE TABLE IF NOT EXISTS "markdown_receipts" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "message_id" varchar(80) not null, "digest" varchar(64) not null, "seq" integer not null, constraint "markdown_receipts_pk" primary key ("resource_id", "epoch_id", "message_id"));`,
  `CREATE TABLE IF NOT EXISTS "editor_epochs" ("resource_id" varchar(36) primary key references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "baseline" text);`,
  `CREATE TABLE IF NOT EXISTS "editor_receipts" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "epoch_id" varchar(36) not null, "message_id" varchar(80) not null, "digest" varchar(64) not null, "seq" integer not null, constraint "editor_receipts_pk" primary key ("resource_id", "epoch_id", "message_id"));`,
  `CREATE TABLE IF NOT EXISTS "access_invitations" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) default 'reader' not null, "state" varchar(16) not null, "version" integer default 1 not null, "invited_by" varchar(36), "decided_by" varchar(36), "created_at" varchar(32) default '' not null, "updated_at" varchar(32) default '' not null, "expires_at" varchar(32), "include_descendants" integer default 1 not null, constraint "access_invitations_pk" primary key ("resource_id", "user_id"));`,
  `CREATE TABLE IF NOT EXISTS "resource_entries" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "state" varchar(16) not null, "source" varchar(24) not null, "version" integer default 1 not null, "updated_at" varchar(32) not null, constraint "resource_entries_pk" primary key ("user_id", "resource_id"));`,
  `CREATE TABLE IF NOT EXISTS "projection_jobs" ("id" varchar(160) primary key, "kind" varchar(32) not null, "payload" text not null, "revision" integer not null, "attempts" integer default 0 not null, "available_at" varchar(32) not null, "last_error" varchar(300), "lease_token" varchar(36), "lease_until" varchar(32));`,
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
  `CREATE TABLE IF NOT EXISTS "membership_grants" ("id" varchar(160) primary key, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "source" varchar(64) not null, "level_id" varchar(64) not null, "starts_at" varchar(32) not null, "expires_at" varchar(32), "status" varchar(16) not null, "version" integer not null);`,
  `CREATE INDEX "membership_user_active" on "membership_grants" ("user_id", "status", "expires_at");`,
  `CREATE TABLE IF NOT EXISTS "membership_events" ("id" varchar(160) primary key, "digest" varchar(64) not null, "created_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "quota_usage" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "metric" varchar(64) not null, "period" varchar(32) not null, "used" bigint not null, constraint "quota_usage_pk" primary key ("user_id", "metric", "period"));`,
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
  `CREATE INDEX "ai_sessions_user" on "ai_sessions" ("user_id", "updated_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_users" ("user_id" text primary key references "users" ("id"), "default_model" text, "memory_enabled" integer default 0 not null, "memory_revision" integer default 0 not null, "lock_version" integer default 0 not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_jobs" ("id" text primary key, "session_id" text not null references "ai_sessions" ("id"), "user_id" text not null references "users" ("id"), "model_id" text not null, "status" text not null, "input" text not null, "digest" text not null, "result" text default '' not null, "error" text default '' not null, "lease" text, "lease_until" text, "attempts" integer default 0 not null, "cancelled" integer default 0 not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "ai_jobs_queue" on "ai_jobs" ("status", "created_at");`,
  `CREATE INDEX "ai_jobs_session" on "ai_jobs" ("session_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_operations" ("id" text primary key, "user_id" text not null, "job_id" text, "digest" text not null, "result" text not null, "created_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_calls" ("id" text primary key, "user_id" text not null, "job_id" text, "model_id" text not null, "model_snapshot" text not null, "periods" text not null, "state" text not null, "input_tokens" integer default 0 not null, "output_tokens" integer default 0 not null, "cached_tokens" integer default 0 not null, "points" double precision not null, "base_points" double precision not null, "allocations" text not null, "usage" text default '{}' not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "ai_calls_user" on "ai_calls" ("user_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "ai_grants" ("id" text primary key, "user_id" text not null references "users" ("id"), "amount" double precision not null, "remaining" double precision not null, "expires_at" text, "reason" text not null, "actor_id" text not null, "created_at" text not null);`,
  `CREATE INDEX "ai_grants_user" on "ai_grants" ("user_id");`,
  `CREATE TABLE IF NOT EXISTS "ai_skills" ("id" text primary key, "user_id" text not null, "name" text not null, "description" text not null, "content" text not null, "formats" text not null, "enabled" integer not null, "revision" integer not null, "updated_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "ai_mcp_keys" ("id" text primary key, "user_id" text not null references "users" ("id"), "name" text not null, "token_hash" text not null unique, "resource_ids" text not null, "writable" integer not null, "expires_at" text not null, "created_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "moderation_settings" ("id" text primary key, "config" text not null, "revision" integer default 1 not null);`,
  `CREATE TABLE IF NOT EXISTS "moderation_cases" ("id" text primary key, "resource_id" text, "asset_id" text, "reporter_id" text, "subject_user_id" text not null, "kind" text not null, "status" text not null, "reason" text not null, "title" text not null, "evidence" text not null, "result" text not null, "fingerprint" text not null, "created_at" text not null, "updated_at" text not null);`,
  `CREATE INDEX "moderation_cases_status_date" on "moderation_cases" ("status", "created_at");`,
  `CREATE INDEX "moderation_cases_resource" on "moderation_cases" ("resource_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "moderation_actions" ("id" text primary key, "case_id" text, "actor_id" text, "resource_id" text, "user_id" text, "action" text not null, "reason" text not null, "created_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "quick_notes" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id"), "content" text not null, "plain_text" text not null, "asset_ids" text not null, "version" integer not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32));`,
  `CREATE INDEX "quick_notes_owner_created" on "quick_notes" ("owner_id", "deleted_at", "created_at", "id");`,
  `CREATE TABLE IF NOT EXISTS "quick_note_compilations" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id"), "sources" text not null, "request_hash" text not null, "instruction" text not null, "model_id" text not null, "status" varchar(16) not null, "markdown" text not null, "error" text not null, "document_id" varchar(36) references "resources" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null);`,
  `CREATE INDEX "quick_note_compilations_owner" on "quick_note_compilations" ("owner_id", "created_at");`,
  `CREATE TABLE IF NOT EXISTS "grants" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "source_type" varchar(24) default 'direct' not null, "source_id" varchar(36) default '' not null, "source_resource_id" varchar(36) references "resources" ("id") on delete cascade, "role" varchar(16) not null, "include_descendants" integer default 1 not null, "status" varchar(16) default 'active' not null, "created_by" varchar(36), "created_at" varchar(32) default '' not null, "updated_at" varchar(32) default '' not null, constraint "grants_unified_pk" primary key ("resource_id", "user_id", "source_type", "source_id"), constraint "grants_unified_source" check (source_type in ('direct','link','parent_override')), constraint "grants_unified_status" check (status in ('active','disabled')), constraint "grants_unified_role" check (role in ('reader','commenter','editor','manager')));`,
  `CREATE INDEX "grants_by_user" on "grants" ("user_id", "resource_id", "status");`,
  `CREATE INDEX "grants_by_source" on "grants" ("resource_id", "source_type", "source_id", "status");`,
  `CREATE TABLE IF NOT EXISTS "share_link_revocations" ("resource_id" varchar(36) not null references "resources" ("id") on delete cascade, "share_id" varchar(36) not null references "share_links" ("generation") on delete cascade, "revoked_by" varchar(36), "revoked_at" varchar(32) not null, "revoked_user_ids" text not null, constraint "share_link_revocations_unified_pk" primary key ("resource_id", "share_id"));`,
  `ALTER TABLE "resources" ADD COLUMN "cover_asset_id" varchar(36) REFERENCES "assets" ("id")`,
  `ALTER TABLE "user_preferences" ADD COLUMN "avatar_asset_id" varchar(36) REFERENCES "assets" ("id")`,
  `ALTER TABLE "assets" ADD COLUMN "note_id" varchar(36) REFERENCES "quick_notes" ("id")`,
];

// File explorer tables are part of the current database bootstrap. They are
// kept separate from the document tables because the file module owns its own
// logical entries and storage-object metadata.
const fileSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "file_storage_objects" ("id" varchar(36) primary key, "profile_id" varchar(36) not null references "storage_profiles" ("id"), "object_key" varchar(160) not null unique, "sha256" varchar(64) not null, "size" bigint not null, "mime" varchar(160) not null, "category" varchar(16) default 'other' not null, "ai_description" text, "ai_status" varchar(20) default 'pending' not null, "ai_model" varchar(160), "ai_generated_at" varchar(32), "created_at" varchar(32) not null, constraint "file_object_size" check (size >= 0));`,
  `CREATE TABLE IF NOT EXISTS "file_derivatives" ("id" varchar(36) primary key, "source_id" varchar(36) not null references "file_storage_objects" ("id"), "profile_id" varchar(36) not null references "storage_profiles" ("id"), "object_key" varchar(160) not null unique, "kind" varchar(32) not null, "recipe" varchar(40) not null, "mime" varchar(160) not null, "size" bigint not null, "created_at" varchar(32) not null, constraint "file_derivative_recipe" unique ("source_id", "kind", "recipe"));`,
  `CREATE TABLE IF NOT EXISTS "file_extracts" ("storage_object_id" varchar(36) primary key references "file_storage_objects" ("id") on delete cascade, "status" varchar(16) not null, "result" text not null, "error" text, "updated_at" varchar(32) not null);`,
  `CREATE INDEX IF NOT EXISTS "file_objects_sha" on "file_storage_objects" ("sha256", "size");`,
  `CREATE TABLE IF NOT EXISTS "file_folders" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id") on delete cascade, "parent_id" varchar(36), "name" varchar(255) not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32), "delete_batch" varchar(36), constraint "file_folder_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_folders_parent" on "file_folders" ("owner_id", "parent_id", "deleted_at", "name");`,
  `CREATE TABLE IF NOT EXISTS "file_folder_shares" ("folder_id" varchar(36) not null references "file_folders" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "file_folder_shares_pk" primary key ("folder_id", "user_id"), constraint "file_folder_share_role" check (role in ('admin','reader')), constraint "file_folder_share_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_folder_shares_user" on "file_folder_shares" ("user_id", "folder_id", "role");`,
  `CREATE TABLE IF NOT EXISTS "file_folder_share_links" ("folder_id" varchar(36) primary key references "file_folders" ("id") on delete cascade, "token" varchar(64) not null unique, "token_hash" varchar(64) not null unique, "role" varchar(16) default 'reader' not null, "enabled" integer default 1 not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "file_folder_link_role" check (role in ('admin','reader')));`,
  `CREATE TABLE IF NOT EXISTS "file_items" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id") on delete cascade, "parent_type" varchar(16) not null, "parent_id" varchar(36) not null, "storage_object_id" varchar(36) not null references "file_storage_objects" ("id"), "name" varchar(255) not null, "mime" varchar(160) not null, "size" bigint not null, "metadata" text default '{}' not null, "ai_description_override" text, "locked" integer default 0 not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32), "delete_batch" varchar(36), constraint "file_item_parent_type" check (parent_type in ('system','folder','document')), constraint "file_item_size" check (size >= 0), constraint "file_item_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "file_items_parent" on "file_items" ("owner_id", "parent_type", "parent_id", "deleted_at", "name");`,
  `CREATE INDEX IF NOT EXISTS "file_items_storage" on "file_items" ("storage_object_id", "deleted_at");`,
  `CREATE TABLE IF NOT EXISTS "file_recognition_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer default 0 not null);`,
];

const mailSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "mail_settings" ("id" varchar(16) primary key, "config" text not null, "revision" integer default 0 not null);`,
  `CREATE TABLE IF NOT EXISTS "mailboxes" ("id" varchar(36) primary key, "owner_id" varchar(36) not null references "users" ("id") on delete cascade, "address" varchar(254) not null unique, "local_part" varchar(64) not null, "display_name" varchar(160) not null, "kind" varchar(16) not null, "locked" integer default 0 not null, "secret" text not null, "source" varchar(16) default 'internal' not null, "provider" varchar(16) default '' not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, "deleted_at" varchar(32), constraint "mailbox_kind" check (kind in ('personal','shared')), constraint "mailbox_source" check (source in ('internal','external')), constraint "mailbox_version" check (version > 0));`,
  `ALTER TABLE "mailboxes" ADD COLUMN "source" varchar(16) default 'internal' not null`,
  `ALTER TABLE "mailboxes" ADD COLUMN "provider" varchar(16) default '' not null`,
  `ALTER TABLE "mailboxes" ADD COLUMN "knowledge_scope" varchar(16) default 'starred' not null`,
  `ALTER TABLE "mailboxes" ADD COLUMN "backend_user_id" varchar(64) default '' not null`,
  `CREATE INDEX IF NOT EXISTS "mailboxes_owner" on "mailboxes" ("owner_id", "deleted_at", "address");`,
  `CREATE TABLE IF NOT EXISTS "mailbox_shares" ("mailbox_id" varchar(36) not null references "mailboxes" ("id") on delete cascade, "user_id" varchar(36) not null references "users" ("id") on delete cascade, "role" varchar(16) not null, "version" integer default 1 not null, "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "mailbox_shares_pk" primary key ("mailbox_id", "user_id"), constraint "mailbox_share_role" check (role in ('admin','sender','reader')), constraint "mailbox_share_version" check (version > 0));`,
  `CREATE INDEX IF NOT EXISTS "mailbox_shares_user" on "mailbox_shares" ("user_id", "mailbox_id", "role");`,
  `CREATE TABLE IF NOT EXISTS "mailbox_share_links" ("mailbox_id" varchar(36) primary key references "mailboxes" ("id") on delete cascade, "token" varchar(64) not null unique, "token_hash" varchar(64) not null unique, "role" varchar(16) default 'reader' not null, "enabled" integer default 1 not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "mailbox_link_role" check (role in ('admin','sender','reader')));`,
  `CREATE TABLE IF NOT EXISTS "mail_messages" ("id" varchar(36) primary key, "mailbox_id" varchar(36) not null references "mailboxes" ("id") on delete cascade, "remote_id" varchar(160) not null, "folder" varchar(80) not null, "folder_id" varchar(160) not null, "subject" varchar(500) not null, "from_addr" varchar(320) not null, "to_addrs" text not null, "cc_addrs" text not null, "snippet" varchar(500) not null, "body_text" text not null, "body_html" text default '' not null, "body_ready" integer default 0 not null, "bcc_addrs" text default '[]' not null, "unread" integer default 1 not null, "starred" integer default 0 not null, "has_attachments" integer default 0 not null, "sent_at" varchar(32), "received_at" varchar(32) not null, "updated_at" varchar(32) not null, constraint "mail_message_remote" unique ("mailbox_id", "remote_id"));`,
  `ALTER TABLE "mail_messages" ADD COLUMN "body_html" text default '' not null`,
  `ALTER TABLE "mail_messages" ADD COLUMN "body_ready" integer default 0 not null`,
  `ALTER TABLE "mail_messages" ADD COLUMN "bcc_addrs" text default '[]' not null`,
  `ALTER TABLE "mail_messages" ADD COLUMN "ai_tags" text default '' not null`,
  `CREATE INDEX IF NOT EXISTS "mail_messages_mailbox" on "mail_messages" ("mailbox_id", "received_at");`,
  `CREATE INDEX IF NOT EXISTS "mail_messages_search" on "mail_messages" ("mailbox_id", "subject", "from_addr");`,
  `CREATE INDEX IF NOT EXISTS "mail_messages_body" on "mail_messages" ("mailbox_id", "body_ready", "received_at");`,
  `CREATE TABLE IF NOT EXISTS "mail_mailbox_sync" ("mailbox_id" varchar(36) primary key references "mailboxes" ("id") on delete cascade, "folders_json" text default '[]' not null, "synced_at" varchar(32), "updated_at" varchar(32) not null);`,
  `CREATE TABLE IF NOT EXISTS "user_page_state" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "key" varchar(160) not null, "value" text not null, "version" integer not null, "updated_at" varchar(32) not null, constraint "user_page_state_pk" primary key ("user_id", "key"), constraint "user_page_state_version" check (version > 0));`,
];

const searchSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS "search_reconciliation" ("id" varchar(16) primary key, "generation" integer not null, "round_id" varchar(36) not null, "phase" varchar(16) not null, "cursor" text not null, "remote_offset" integer not null, "scanned" integer not null, "differences" integer not null, "started_at" varchar(32), "checked_at" varchar(32), "completed_at" varchar(32), "next_at" varchar(32) not null, "lease_token" varchar(36), "lease_until" varchar(32), "last_error" text);`,
  `CREATE TABLE IF NOT EXISTS "search_reconcile_entries" ("id" varchar(512) primary key, "round_id" varchar(36) not null, "content_hash" varchar(64), "pending" integer default 0 not null);`,
  `CREATE TABLE IF NOT EXISTS "search_embedding_task" ("id" text primary key, "operation_id" text not null, "endpoint" text not null, "index_name" text not null, "embedder_name" text not null, "task_uid" bigint, "status" text not null, "updated_at" text not null);`,
  `CREATE TABLE IF NOT EXISTS "search_embedding_models" ("id" text primary key, "endpoint" text not null, "index_name" text not null, "embedder_name" text not null, "model_id" text not null, "fingerprint" text not null, "operation_id" text not null, "applied" integer default 0 not null, "document_template" text, "document_template_max_bytes" integer, "applied_at" text);`,
];

async function ensureFileSchema(db: Kysely<any>) {
  for (const statement of fileSchemaStatements)
    await sql.raw(statement).execute(db);
}

async function ensureSearchSchema(db: Kysely<any>) {
  for (const statement of searchSchemaStatements)
    await sql.raw(statement).execute(db);
}

async function ensureMailSchema(db: Kysely<any>) {
  for (const statement of mailSchemaStatements) {
    try {
      await sql.raw(statement).execute(db);
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }
}

async function ensureTemplateSchema(db: Kysely<any>) {
  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS "document_templates" ("id" varchar(36) primary key, "format" varchar(24) not null, "title" varchar(160) not null, "content" text not null, "preview" text default '' not null, "created_by" varchar(36) not null references "users" ("id"), "created_at" varchar(32) not null, "updated_at" varchar(32) not null)`,
    )
    .execute(db);
  await sql
    .raw(
      `CREATE INDEX IF NOT EXISTS "document_templates_format" on "document_templates" ("format", "updated_at")`,
    )
    .execute(db);
}

async function ensureAINoteSchema(db: Kysely<any>) {
  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS "ai_notes" ("user_id" varchar(36) primary key references "users" ("id") on delete cascade, "content" text default '' not null, "updated_at" varchar(32) not null)`,
    )
    .execute(db);
  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS "ai_secrets" ("user_id" varchar(36) not null references "users" ("id") on delete cascade, "key" varchar(64) not null, "value" text not null, "updated_at" varchar(32) not null, primary key ("user_id", "key"))`,
    )
    .execute(db);
}

async function ensureReactionSchema(db: Kysely<any>) {
  const found = await sql<{ sql: string | null }>`select sql as sql from sqlite_master where type = 'table' and name = 'reactions'`.execute(db);
  const ddl = found.rows[0]?.sql ?? "";
  if (!ddl) return;
  const allowsPin = ddl.includes("'pin'");
  const hasStamp = ddl.includes("created_at");
  if (!allowsPin) {
    await sql.raw(`PRAGMA foreign_keys = OFF`).execute(db);
    try {
      await sql
        .raw(
          `CREATE TABLE "reactions_next" ("resource_id" varchar(36) not null references "resources" ("id"), "user_id" varchar(36) not null references "users" ("id"), "kind" varchar(16) not null, "created_at" varchar(32) not null default '', constraint "reactions_pk" primary key ("resource_id", "user_id", "kind"), constraint "reaction_kind" check (kind in ('like','favorite','pin')))`,
        )
        .execute(db);
      await sql
        .raw(
          hasStamp
            ? `INSERT INTO "reactions_next" ("resource_id", "user_id", "kind", "created_at") SELECT "resource_id", "user_id", "kind", coalesce("created_at", '') FROM "reactions"`
            : `INSERT INTO "reactions_next" ("resource_id", "user_id", "kind", "created_at") SELECT "resource_id", "user_id", "kind", '' FROM "reactions"`,
        )
        .execute(db);
      await sql.raw(`DROP TABLE "reactions"`).execute(db);
      await sql.raw(`ALTER TABLE "reactions_next" RENAME TO "reactions"`).execute(db);
      await sql
        .raw(
          `CREATE INDEX IF NOT EXISTS "favorites_by_user" on "reactions" ("user_id", "kind", "resource_id")`,
        )
        .execute(db);
    } finally {
      await sql.raw(`PRAGMA foreign_keys = ON`).execute(db);
    }
    return;
  }
  if (!hasStamp) {
    try {
      await sql
        .raw(
          `ALTER TABLE "reactions" ADD COLUMN "created_at" varchar(32) not null default ''`,
        )
        .execute(db);
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }
}

async function ensureResourceSchema(db: Kysely<any>) {
  try {
    await sql
      .raw(
        `ALTER TABLE "resources" ADD COLUMN "page_width" varchar(16) default 'a4'`,
      )
      .execute(db);
  } catch (error) {
    const message = String((error as { message?: string })?.message ?? error);
    if (!/duplicate column|already exists/i.test(message)) throw error;
  }
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
      id: "local",
      provider: "local",
      config: "{}",
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
    .values([
      { id: "identity", config: "{}", revision: 1 },
      { id: "entitlements", config: "{}", revision: 1 },
    ])
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
  await db
    .insertInto("moderation_settings")
    .values({
      id: "system",
      config: JSON.stringify({
        enabled: false,
        provider: "tencent",
        region: "ap-guangzhou",
        secretId: "",
        secretKey: "",
        textBizType: "",
        imageBizType: "",
        delaySeconds: 120,
      }),
      revision: 1,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await db
    .insertInto("mail_settings")
    .values({
      id: "system",
      config: JSON.stringify({
        enabled: false,
        endpoint: "",
        domain: "",
        mode: "free",
        maxMailboxes: 3,
        username: "",
        token: "",
      }),
      revision: 0,
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

async function ensureKnowledgeSchema(db: Kysely<any>) {
  for (const statement of knowledgeSchemaStatements)
    await sql.raw(statement).execute(db);
  for (const statement of [
    `ALTER TABLE "resources" ADD COLUMN "ai_curated" integer default 0 not null`,
    `ALTER TABLE "resources" ADD COLUMN "guide_document_id" varchar(36)`,
    `ALTER TABLE "resources" ADD COLUMN "guide_text" text not null default ''`,
    `CREATE TABLE IF NOT EXISTS "knowledge_subscriptions" ("id" varchar(36) primary key, "library_id" varchar(36) not null references "resources" ("id") on delete cascade, "source_kind" varchar(16) not null, "source_id" varchar(36) not null default '', "url" text not null default '', "node_id" varchar(36) references "resources" ("id") on delete set null, "source_version" varchar(64) not null default '', "status" varchar(16) not null default 'active', "created_at" varchar(32) not null, constraint "knowledge_subscription_source" unique ("library_id", "source_kind", "source_id", "url"))`,
    `CREATE INDEX IF NOT EXISTS "knowledge_subscriptions_library" on "knowledge_subscriptions" ("library_id")`,
  ]) {
    try {
      await sql.raw(statement).execute(db);
    } catch (error) {
      const message = String((error as { message?: string })?.message ?? error);
      if (!/duplicate column|already exists/i.test(message)) throw error;
    }
  }
}

export async function createSchema(db: Kysely<any>) {
  if ((await db.introspection.getTables()).length > 0) {
    await ensureFileSchema(db);
    await ensureSearchSchema(db);
    await ensureMailSchema(db);
    await ensureKnowledgeSchema(db);
    await ensureResourceSchema(db);
    await ensureReactionSchema(db);
    await ensureTemplateSchema(db);
    await ensureAINoteSchema(db);
    await ensureMobileSchema(db);
    await seedSystemRows(db);
    return;
  }

  for (const statement of schemaStatements)
    await sql.raw(statement).execute(db);

  await ensureFileSchema(db);
  await ensureSearchSchema(db);
  await ensureMailSchema(db);
  await ensureKnowledgeSchema(db);
  await ensureResourceSchema(db);
  await ensureReactionSchema(db);
  await ensureTemplateSchema(db);
  await ensureAINoteSchema(db);
  await ensureMobileSchema(db);
  await seedSystemRows(db);
}

async function ensureMobileSchema(db: Kysely<any>) {
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
