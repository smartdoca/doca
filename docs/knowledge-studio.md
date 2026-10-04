# Knowledge curation and independent Q&A

[中文](knowledge-studio.zh-CN.md)

This page records the implementation as of 2026-09-27 and its later workspace additions. Proposed SDKs in design records do not become exports merely by being documented.

## Administration and sources

A library's curation assistant isolates shared conversations and persistent instructions by library and exposes them to that library's managers. Each source member retains its registering principal for current authorization; shared administration never shares personal account credentials. Messages record the actual manager and manual/scheduled/system trigger, while the model receives the common user role.

A named source group contains one subscription type: links, files, folders, libraries, or document nodes. Selection is at most 500 members and cannot mix types. Groups share instructions, pause, and priority; members retain identity, state, authorization, fingerprints, and references. Removing members from scope stops further curation and preserves provenance for existing results. Group related material by topic/instructions rather than file extension alone.

Folder/library/document scans recursively discover descendants, including new ones. Every level checks permission and excluded nodes; selection never expands authorization. `read_source` enumerates members and pages by `memberId` rather than putting an entire folder into a model call. Unparseable files remain explicit gaps.

With `sourceScope=internal`, tool-level restrictions block webpage reads, web search/recommendations, and link registration. Only an actual manager's explicit new requirement can relax this rule; schedules and source bodies cannot. Structured intent recognition requires the manager's original statement. The settings panel can also change scope directly.

## Documents and parent guides

Knowledge results are ordinary native documents, editable by people. Publication reads current document state. AI proposals record the original document version and check for intervening human changes on adoption, retaining the normal Yjs lifecycle.

Category parents are editable guides explaining scope, relationships, reading paths, troubleshooting, and child links. Generation needs direct-child summaries/versions instead of concatenating the subtree. Changes to parent/child pages prevent blindly adopting an old proposal. Category names and guide bodies remain distinct.

## Execution and cost

Multi-round conversations, tool logs, and worklists expose progress. Complex work is divided into chapters. Prompt context, processed messages, tool results, and pending plans are persisted. After each 12-round batch execution queues a continuation; total budget is 180 rounds per task, including repeated incomplete statements. Truncated output requests smaller steps and is not committed as a finished draft.

Sources use incremental fingerprints; success fingerprints are written only after processing succeeds. Parent guides use summaries; source reads are paged. Conversation compaction preserves constraints, evidence, completed operations, and unfinished work. Transient timeout/rate-limit/connection failures retry at most three times with backoff. Permission failures are not blindly retried. Tool writes and completion logs commit together; recovery reuses logs to prevent duplicate writes.

Automation supports `safe` and `draft`. Safe can adopt source-grounded new knowledge and AI revisions without human-edit conflict. Human changes or factual conflicts leave a draft and allow other work to continue. Acceptance must record real delivery/failure rather than trusting a model's completion claim; arbitrary tasks/models are not guaranteed.

## Q&A publication and indexes

Managers choose automatic activation or manual publication independently of an assistant's public scope. Automatic activation switches only after the saved document's background index synchronization succeeds. Failure retains the previous version and displays the reason. Manual publication holds a stable snapshot until the next successful publication.

Global document search and knowledge Q&A have separate logical projections. Q&A uses native Meilisearch vector/hybrid retrieval. Switching waits for successful index tasks. Candidates are limited to currently published chunks of bound libraries. Credentials for the secondary index are reconstructed from Doca's configured models; masked secrets returned by Meilisearch GET are not usable credentials.

Vector settings synchronize during index preparation. Queries against ready indexes do not submit settings updates, avoiding a post-restart first-query index-queue delay. Attachments/follow-up questions derive core retrieval terms; calculation questions retrieve rules before substituting numbers. An answer without valid evidence IDs receives at most one check/correction, then is withdrawn if citations remain absent.

Deletion and tighter redaction immediately constrain prior publications and historical answers. Documents and Q&A indexes do not become two independently editable knowledge bodies.

## Independent Q&A and feedback

Q&A conversations are isolated by user and do not reuse the personal assistant's conversations or long-term memory. Compaction serves only the current conversation. Answers cite currently active knowledge and explicitly state insufficient evidence. Curation and Q&A use distinct book/check and robot icons.

Channels include the full Q&A page, `/knowledge/embed/<botId>`, streaming HTTP, and MCP. The personal assistant can consume bound bots as read-only retrieval tools. `DOCA_KNOWLEDGE_EMBED_ORIGINS` controls iframe origins. Public bots allow anonymous visitors with server-issued, bot-only, 24-hour credentials and isolated conversations. Removing public access or closing a channel invalidates them immediately. Visitor IP limits use local counters without Redis and shared counters with Redis; gateway limits can add protection. Never expose administrator/MCP keys to the webpage.

The Knowledge Q&A list opens chat, toolbar configuration, and Sharing/permissions. A library's Q&A assistants tab lists bound bots and creators, without granting bot usage/management. Creators and bot managers configure; readers ask questions. Library binding supports multiple libraries and checks the creator's current management rights on each retrieval, retaining valid bindings. Revocation rechecks historical citations and interrupts/withdraws invalid in-progress answers.

Attachments reuse AI upload/parsing, require sign-in and the bot manager's enabled setting, and are limited to eight files / 25 MB per message. They are conversation context, not library content or authoritative sources.

Each bot independently enables Web, embed, API, and MCP. Configuration generates channel-specific API/MCP keys, shown in plaintext once, stored as hashes, revocable, and normally valid for 90 days. `POST /api/v1/knowledge/assistants/:id/api/ask` accepts `query` and optional `conversationId`, uses `Authorization: Bearer <key>`, and returns the conversation ID/SSE address. Subsequent GET uses the same key; different keys cannot read each other's conversations. `POST /api/v1/knowledge/assistants/:id/mcp` uses an MCP key for `knowledge_search`, `knowledge_ask`, and `knowledge_answer`. A disabled key creator or loss of bot management invalidates the key immediately.

Internal authenticated HTTP remains `POST /api/v1/knowledge/assistants/:id/ask`, returning `conversationId` and `streamUrl`; pass `conversationId` for follow-up. SSE is `GET /api/v1/knowledge/conversations/:id/stream`. Internal MCP is `POST /api/v1/knowledge/mcp`; credentials must authorize all currently active bot libraries and only search/ask/answer are exposed.

Helpful/unhelpful feedback does not block chat. Cases preserve answers and evidence; managers classify in batches, generate revisions, and retest against the current published version and explicit expectations. AI self-evaluation supplements evidence rather than replacing authoritative fact checks.

## Acceptance material

- `artifacts/network-guide/`: 32 protocol chapters, 41 category guides, and generation/review records.
- `scripts/knowledge-studio-live-acceptance.ts`: real models, internal-source restrictions, schedules, and multi-round Q&A; records `live-acceptance.json`.
- `tests/knowledge-source-groups.test.ts`: groups, type isolation, recursion, scope changes, inheritance.
- `tests/knowledge-studio*.test.ts`: shared management, isolation, intent, checkpoint recovery, publication, human-edit conflicts.
- `tests/knowledge-bot-management.test.ts`: multi-library revocation, managers, direct sharing, attachments, keys, MCP.
- `tests/knowledge-query-readonly.test.ts`: retrieval does not update vector settings.
- `scripts/knowledge-bot-live-acceptance.ts`: multiple bindings, real attachment calculations, follow-ups; outputs `artifacts/network-guide/bot-live-acceptance.json`.

Real demos create/modify these dedicated demonstration libraries and call configured models/search. Automated tests use isolated databases and never collaboratively edit user documents.

### Curation workspace and human assistance

The Curation assistant tab opens the shared conversation directly. Inputs accept files/source references. Upload checks the operator's folder-edit permission before registering the folder in the library. Source-reading authorization applies only inside curation scope and does not grant other managers raw-source read/write access. Sources have editable names and enabled/disabled state; disabling preserves configuration and excludes future reads/scans.

The right panel combines unresolved human tasks from current and earlier conversations. Drafts, source suggestions, and decisions use stable deduplication keys and version checks. Adoption, replacement, source completion, or scope changes close stale tasks while preserving audit. `inspect`, `human_task`, and `resolve_human_task` expose/manage outstanding items; local blockers do not block other work. Human actions add operator-identified messages.

Q&A feedback remains independent of curation conversations, displaying the bot and frozen feedback conversation with the evaluated answer marked. Managers can start manual analysis or select off/daily/weekly feedback processing. Each schedule creates a new timestamp-named conversation. Votes can change or be withdrawn; withdrawal retains audit and removes the case from pending processing.
