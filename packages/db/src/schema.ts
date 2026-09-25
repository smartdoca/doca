import type { Kysely } from "kysely";
export interface User {
  profile_metadata?: string;
  profile_revision?: number;
  public_id?: string;
  directory_mode?: string | null;
  id: string;
  login: string;
  display_name: string;
  password_hash: string;
  admin: number;
  status: string;
  created_at: string;
  last_login_at?: string | null;
}
export interface Resource {
  permission_overrides?: number;
  content_bytes?: number;
  authz_revision?: number;
  history_readers?: number;
  discoverable?: number;
  last_editor_id?: string | null;
  last_edited_at?: string | null;
  cover_asset_id?: string | null;
  page_width?: string | null;
  ai_curated?: number;
  guide_document_id?: string | null;
  guide_text?: string;
  knowledge_schedule?: string;
  knowledge_preset?: string;
  id: string;
  kind: "document" | "library";
  format: "rich_text" | "spreadsheet" | "presentation" | "markdown" | "canvas";
  title: string;
  owner_id: string;
  library_id: string | null;
  parent_id: string | null;
  tree_order?: number;
  access_mode: "inherit" | "custom";
  visibility: "invited" | "requestable" | "authenticated" | "public";
  requests_enabled?: number;
  share_links_enabled?: number;
  public_role?: "reader" | "commenter" | "editor";
  version: number;
  deleted_at: string | null;
  delete_batch: string | null;
  created_at: string;
  updated_at: string;
}
export interface Schema {
  plugin_migrations: {
    plugin_id: string;
    version: string;
    applied_at: string;
  };
  quick_notes: {
    id: string;
    owner_id: string;
    content: string;
    plain_text: string;
    asset_ids: string;
    version: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  };
  quick_note_compilations: {
    id: string;
    owner_id: string;
    sources: string;
    request_hash: string;
    instruction: string;
    model_id: string;
    status: string;
    markdown: string;
    error: string;
    document_id: string | null;
    created_at: string;
    updated_at: string;
  };

  ai_sessions: {
    approved_resource_ids?: string;
    mentioned_resource_ids?: string;
    id: string;
    user_id: string;
    title: string;
    model_id: string | null;
    resource_ids: string;
    archived: number;
    revision: number;
    created_at: string;
    updated_at: string;
  };
  ai_users: {
    user_id: string;
    default_model: string | null;
    memory_enabled: number;
    memory_revision: number;
    lock_version: number;
  };
  ai_notes: { user_id: string; content: string; updated_at: string };
  ai_secrets: {
    user_id: string;
    key: string;
    value: string;
    updated_at: string;
  };
  ai_jobs: {
    id: string;
    session_id: string;
    user_id: string;
    model_id: string;
    status:
      | "queued"
      | "running"
      | "awaiting_approval"
      | "completed"
      | "failed"
      | "cancelled"
      | "interrupted";
    input: string;
    digest: string;
    result: string;
    error: string;
    lease: string | null;
    lease_until: string | null;
    attempts: number;
    cancelled: number;
    created_at: string;
    updated_at: string;
  };
  ai_operations: {
    id: string;
    user_id: string;
    job_id: string | null;
    digest: string;
    result: string;
    created_at: string;
  };
  ai_calls: {
    id: string;
    user_id: string;
    job_id: string | null;
    model_id: string;
    model_snapshot: string;
    periods: string;
    state: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    usage: string;
    created_at: string;
    updated_at: string;
  };
  ai_skills: {
    id: string;
    user_id: string;
    name: string;
    description: string;
    content: string;
    formats: string;
    enabled: number;
    revision: number;
    updated_at: string;
  };
  ai_mcp_keys: {
    id: string;
    user_id: string;
    name: string;
    token_hash: string;
    resource_ids: string;
    writable: number;
    expires_at: string;
    created_at: string;
  };
  ai_session_events: {
    session_id: string;
    seq: number;
    event_id: string;
    digest: string;
    type: string;
    payload: string;
    created_at: string;
  };
  tickets: {
    operation_json?: string;
    id: string;
    kind: "access" | "invitation";
    resource_kind: "document" | "library";
    source_key: string;
    hidden_for_user_id: string | null;
    resource_id: string | null;
    user_id: string;
    initiator_id: string;
    status: string;
    role: string | null;
    message: string;
    created_at: string;
    updated_at: string;
    expires_at: string | null;
    reminded_at: string | null;
  };
  ticket_events: {
    operation_json?: string;
    id: string;
    ticket_id: string;
    actor_id: string | null;
    status: string;
    message: string;
    created_at: string;
  };
  registration_reviews: {
    user_id: string;
    status: string;
    reviewer_id: string | null;
    message: string;
    created_at: string;
    updated_at: string;
  };
  access_invitations: {
    include_descendants?: number;
    resource_id: string;
    user_id: string;
    role?: "reader" | "commenter" | "editor" | "manager";
    state: string;
    version?: number;
    invited_by?: string | null;
    created_at?: string;
    updated_at?: string;
    expires_at?: string | null;
    decided_by?: string | null;
  };
  invitation_history: Schema["access_invitations"] & { id: string };
  resource_entries: {
    user_id: string;
    resource_id: string;
    state: "joined" | "hidden";
    source: string;
    version: number;
    updated_at: string;
  };
  pending_integration_events: {
    id: string;
    type: string;
    payload: string;
    created_at: string;
  };
  projection_cursors: { id: string; revision: number };
  projection_jobs: {
    lease_token?: string | null;
    lease_until?: string | null;
    status?: string;
    plugin_id?: string | null;
    max_attempts?: number;
    id: string;
    kind: string;
    payload: string;
    revision: number;
    attempts: number;
    available_at: string;
    last_error: string | null;
  };
  markdown_epochs: { resource_id: string; epoch_id: string };
  editor_epochs: {
    resource_id: string;
    epoch_id: string;
    baseline: string | null;
  };
  editor_receipts: {
    resource_id: string;
    epoch_id: string;
    message_id: string;
    digest: string;
    seq: number;
  };
  markdown_receipts: {
    resource_id: string;
    epoch_id: string;
    message_id: string;
    digest: string;
    seq: number;
  };
  access_requests: {
    operation_json?: string;
    message?: string;
    decision_message?: string;
    id: string;
    resource_id: string;
    user_id: string;
    role: "reader" | "commenter" | "editor" | "manager";
    status: string;
    created_at: string;
    updated_at: string;
    decided_by: string | null;
  };
  integration_events: {
    id: string;
    seq: number;
    type: string;
    payload: string;
    created_at: string;
  };
  distribution_settings: { id: string; config: string; revision: number };
  document_references: { source_id: string; target_id: string };
  document_reference_index: { resource_id: string; seq: number };
  user_card_settings: { id: string; config: string; revision: number };
  share_links: {
    include_descendants?: number;
    max_members?: number | null;
    revoked?: number;
    revoked_at?: string | null;
    resource_id: string;
    token: string;
    token_hash: string;
    generation: string;
    revision: string;
    role: "reader" | "commenter" | "editor" | "manager";
    enabled: number;
    expires_at?: string | null;
    created_by?: string | null;
    created_at?: string;
  };
  share_link_revocations: {
    resource_id: string;
    share_id: string;
    revoked_by?: string | null;
    revoked_at: string;
    revoked_user_ids: string;
  };
  document_versions: {
    recovery_json?: string | null;
    id: string;
    resource_id: string;
    seq: number;
    checkpoint: string;
    title: string;
    author_id: string;
    created_at: string;
  };
  visit_events: {
    id: string;
    resource_id: string;
    user_id: string;
    created_at: string;
  };
  account_settings: { id: string; config: string; revision: number };
  login_identifiers: {
    value: string;
    user_id: string;
    kind: string;
    active: number;
  };
  user_contacts: {
    user_id: string;
    kind: string;
    value: string;
    verified_at: string;
    verification_source: string;
  };
  account_flows: {
    id: string;
    kind: string;
    user_id: string | null;
    data: string;
    expires_at: string;
  };
  verification_challenges: {
    id: string;
    binding: string;
    destination: string;
    kind: string;
    purpose: string;
    digest: string;
    attempts: number;
    consumed: number;
    created_at: string;
    expires_at: string;
  };
  security_audit: {
    id: string;
    actor_id: string | null;
    user_id: string | null;
    action: string;
    details: string;
    created_at: string;
  };
  auth_providers: {
    profile_config?: string;
    protocol_config?: string;
    id: string;
    type: string;
    name: string;
    issuer: string;
    client_id: string;
    credential_ref: string;
    enabled: number;
    version: number;
  };
  auth_identities: {
    id: string;
    user_id: string;
    provider_id: string;
    subject: string;
    display_name: string;
    created_at: string;
  };
  auth_flows: {
    intent?: string;
    id: string;
    browser_hash: string;
    provider_id: string;
    provider_version: number;
    verifier: string;
    nonce: string;
    user_id: string | null;
    session_id: string | null;
    expires_at: string;
    stage: string;
    identity: string | null;
  };
  document_states: {
    resource_id: string;
    codec: string;
    checkpoint: string;
    checkpoint_seq: number;
    seq: number;
    text: string;
    updated_at: string;
  };
  document_updates: {
    resource_id: string;
    seq: number;
    data: string;
    author_id: string;
    created_at: string;
  };
  search_settings: {
    id: string;
    enabled: number;
    endpoint: string;
    index_name: string;
    updated_at: string;
    image_recognition_enabled: number;
    image_policy_version: number;
    reconcile_interval_hours: number;
    generation: number;
    ai_min_score: number;
  };
  search_embedding_task: {
    id: string;
    operation_id: string;
    endpoint: string;
    index_name: string;
    embedder_name: string;
    task_uid: number | null;
    status:
      | "idle"
      | "submitting"
      | "enqueued"
      | "processing"
      | "succeeded"
      | "failed"
      | "canceled"
      | "unknown";
    updated_at: string;
  };
  search_embedding_models: {
    id: string;
    endpoint: string;
    index_name: string;
    embedder_name: string;
    model_id: string;
    fingerprint: string;
    operation_id: string;
    applied: number;
    document_template: string | null;
    document_template_max_bytes: number | null;
    applied_at: string | null;
  };
  search_reconciliation: {
    id: string;
    generation: number;
    round_id: string;
    phase: "idle" | "remote" | "source" | "enqueue" | "waiting";
    cursor: string;
    remote_offset: number;
    scanned: number;
    differences: number;
    started_at: string | null;
    checked_at: string | null;
    completed_at: string | null;
    next_at: string;
    lease_token: string | null;
    lease_until: string | null;
    last_error: string | null;
  };
  search_reconcile_entries: {
    id: string;
    round_id: string;
    content_hash: string | null;
    pending: number;
  };
  storage_profiles: {
    id: string;
    provider: string;
    config: string;
    active: number;
    created_at: string;
  };
  file_storage_objects: {
    id: string;
    profile_id: string;
    object_key: string;
    sha256: string;
    size: number;
    mime: string;
    category?: string;
    ai_description?: string | null;
    ai_status?: string;
    ai_model?: string | null;
    ai_generated_at?: string | null;
    created_at: string;
  };
  file_derivatives: {
    id: string;
    source_id: string;
    profile_id: string;
    object_key: string;
    kind: string;
    recipe: string;
    mime: string;
    size: number;
    created_at: string;
  };
  file_extracts: {
    storage_object_id: string;
    status: string;
    result: string;
    error: string | null;
    updated_at: string;
  };
  file_folders: {
    id: string;
    owner_id: string;
    parent_id: string | null;
    name: string;
    version: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    delete_batch: string | null;
  };
  file_folder_shares: {
    folder_id: string;
    user_id: string;
    role: "admin" | "reader";
    version: number;
    created_at: string;
    updated_at: string;
  };
  file_folder_share_links: {
    folder_id: string;
    token: string;
    token_hash: string;
    role: "admin" | "reader";
    enabled: number;
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  file_items: {
    id: string;
    owner_id: string;
    parent_type: "system" | "folder" | "document";
    parent_id: string;
    storage_object_id: string;
    name: string;
    mime: string;
    size: number;
    metadata: string;
    ai_description_override: string | null;
    locked: number;
    version: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    delete_batch: string | null;
  };
  file_bindings: {
    id: string;
    file_id: string;
    owner_plugin: string;
    owner_type: string;
    owner_id: string;
    role: string;
    created_at: string;
  };
  file_recognition_settings: {
    id: string;
    config: string;
    revision: number;
  };
  assets: {
    note_id?: string | null;
    uploaded_by?: string | null;
    id: string;
    owner_id: string;
    resource_id: string | null;
    purpose: string;
    profile_id: string;
    object_key: string;
    filename: string;
    mime: string;
    size: number;
    created_at: string;
    deleted_at: string | null;
  };
  resource_visits: { user_id: string; resource_id: string; visited_at: string };
  user_preferences: {
    avatar_asset_id?: string | null;
    user_id: string;
    avatar: string;
    theme: string;
    density: string;
    default_sort: string;
    sort_order: string;
    version: number;
  };
  user_presence: { user_id: string; last_seen_at: string };
  users: User;
  sessions: {
    id: string;
    user_id: string;
    expires_at: string;
  };
  settings: {
    directory_mode?: string;
    id: string;
    registration: number;
    revision: number;
    site_name: string;
    default_locale?: string;
    default_timezone?: string;
    registration_review?: number;
    sso_registration?: string;
    social_registration?: string;
  };
  resources: Resource;
  document_templates: {
    id: string;
    format: Resource["format"];
    title: string;
    content: string;
    preview: string;
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  grants: {
    include_descendants?: number;
    source_type?: "direct" | "link" | "parent_override";
    source_id?: string;
    source_resource_id?: string | null;
    status?: "active" | "disabled";
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
    resource_id: string;
    user_id: string;
    role: "reader" | "commenter" | "editor" | "manager";
  };
  comments: {
    body_json?: string | null;
    anchor?: string | null;
    id: string;
    resource_id: string;
    author_id: string;
    body: string;
    parent_id: string | null;
    resolved: number;
    deleted_at: string | null;
    version: number;
    created_at: string;
    updated_at: string;
  };
  reactions: {
    resource_id: string;
    user_id: string;
    kind: "like" | "favorite" | "pin";
    created_at?: string;
  };
  notifications: {
    ticket_id?: string | null;
    actor_id?: string | null;
    comment_id?: string | null;
    dedupe_key?: string | null;
    id: string;
    user_id: string;
    resource_id: string | null;
    type: string;
    read_at: string | null;
    created_at: string;
  };
  audit_events: {
    id: string;
    actor_id: string;
    resource_id: string | null;
    action: string;
    created_at: string;
  };
  user_page_state: {
    user_id: string;
    key: string;
    value: string;
    version: number;
    updated_at: string;
  };
  knowledge_chunks: {
    id: string;
    source_kind: string;
    source_id: string;
    ordinal: number;
    title: string;
    text: string;
    anchor: string;
    content_hash: string;
    reader_ids: string;
    updated_at: string;
  };
  knowledge_links: {
    id: string;
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
    relation: string;
    score: number;
    reason: string;
    created_at: string;
  };
  knowledge_link_hides: {
    user_id: string;
    link_id: string;
    created_at: string;
  };
  knowledge_feedback: {
    id: string;
    user_id: string;
    chunk_id: string;
    judgment: string;
    query: string;
    created_at: string;
  };
  knowledge_subscriptions: {
    id: string;
    creator_id?: string;
    library_id: string;
    source_kind: string;
    source_id: string;
    url: string;
    node_id: string | null;
    source_version: string;
    status: string;
    created_at: string;
    preset?: string;
  };
  knowledge_instructions: {
    library_id: string;
    path: string;
    revision: number;
    markdown: string;
    author_id: string;
    created_at: string;
  };
  knowledge_settings: {
    library_id: string;
    revision: number;
    config: string;
    updated_at: string;
  };
  knowledge_entries: {
    id: string;
    library_id: string;
    title: string;
    markdown: string;
    origin: string;
    status: string;
    revision: number;
    source_refs: string;
    instruction_hash: string;
    review_state: string;
    author_id: string;
    created_at: string;
    updated_at: string;
  };
  knowledge_entry_versions: {
    entry_id: string;
    revision: number;
    snapshot: string;
    author_id: string;
    created_at: string;
  };
  knowledge_assistant_users: { assistant_id: string; user_id: string; accepted: number; visited_at: string | null; integration: string; revision: number; };
  knowledge_assistants: {
    visibility?: string;
    id: string;
    owner_id: string;
    title: string;
    revision: number;
    library_ids: string;
    member_ids: string;
    enabled: number;
    updated_at: string;
  };
  knowledge_runs: {
    id: string;
    library_id: string;
    trigger: string;
    status: string;
    detail: string;
    created_at: string;
  };
  knowledge_bots: {
    library_id: string;
    title: string;
    published: number;
    updated_at: string;
  };
  knowledge_gaps: {
    id: string;
    user_id: string;
    query: string;
    status: string;
    detail: string;
    created_at: string;
  };
  webview_tickets: {
    id: string;
    user_id: string;
    expires_at: string;
  };
  qr_logins: {
    id: string;
    secret_hash: string;
    user_id: string | null;
    expires_at: string;
  };
  push_devices: {
    id: string;
    user_id: string;
    token: string;
    platform: "ios" | "android";
    created_at: string;
    updated_at: string;
  };
}
export type DB = Kysely<Schema>;
