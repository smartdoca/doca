---
name: doca-collaboration
description: Implement, review, or upgrade realtime collaboration between Doca and any document-type editor subpackage (rich text, spreadsheet, Markdown, canvas, slides, and future formats) using the shared Yjs lifecycle, version, acknowledgement, presence, and comment-anchor contract. Use for collaboration SDK changes, subpackage development, and host package integration, not unrelated UI work.
---

# Doca collaboration

Read [the full contract](references/contract.md) before changing collaboration behavior. It is a target contract plus a dated implementation inventory, not evidence that an API already exists. Inspect the current package README, exports, source and tests before using any proposed API.

## Scope and maintenance

This contract governs every document-type editor subpackage — rich text, spreadsheet, Markdown, canvas, slides and future formats — not only slatetsx/exlsx. Format-specific rules (Excel baseline, stable row/column anchors) are the format's instances of the shared contract, not exceptions from it.

Subpackage developers and Doca host developers maintain this contract together: a change is only valid when both sides agree, and the project source documents (`docs/collaboration-sdk-contract.md`, `docs/editor-file-exchange-contract.md`) and every packaged skill copy (project `skills/` and user skills directories) must be updated in the same change. Do not let the copies drift.

## Core constraints

- Unify transport, authentication, durable ACK, outbox and reconnect behavior. Keep format-specific data models behind codec adapters; never convert a workbook into a text CRDT just for uniformity.
- Separate protocolVersion, codec/schemaVersion, epochId, seq, checkpointSeq, resource.version and business history IDs. Epoch identity is always carried as `epochId`.
- Initialize from a server-authoritative, atomically paired baseline and Yjs state, then mount one stable editor instance. Props, readonly, selection, save state and resize must not rebuild the document or mutate shared state.
- Only local content transactions enter the outbox. Remote/bootstrap/presence/focus/scroll changes must not generate writes or operation IDs. Do not introduce a second autosave transport.
- ACK only after database commit. Keep original bytes and message ID until the matching ACK; a sync response is not an ACK. Never infer dirty state from a nonempty vector diff: an already synchronized deletion set can still be returned.
- Replay unacknowledged updates on reconnect; refuse mismatched epochs and unknown schemas. Do not silently discard pending work or apply it to a replacement baseline. No offline-durability claims without persistent storage.
- Preserve CRDT identities in checkpoints. Excel restores immutable baseline plus commands of that epoch, never a latest workbook snapshot plus old commands.
- Session identity and color come from the server. Same account in two pages has two selections. Presence is temporary, permission checked and non-persistent. Text uses relative points; cells use sheet/range plus editing state; never transmit typed content through presence.
- Permanent comment anchors are distinct from presence coordinates. Excel needs stable row/column identities with deletion handling. Do not fake permanent anchors with A1 coordinates.
- Content changes, validation, ACL and persistence remain atomic. Recheck authorization on writes/broadcasts. Unknown/duplicate ACKs cannot clear other pending edits.

## Package upgrade workflow

Read the new package's integration documentation and compare exported APIs/schema with the currently installed build. Build/pack and install the actual updated artifact; when versions are reused, use a new hash-qualified filename and lockfile entry to avoid stale caches. Keep the previous artifact and a rollback route. Do not modify upstream source just to force host compatibility without task authorization.

Adapt host bindings, codec validation and exact current-schema negotiation together. This project accepts only the current empty-database/document baseline; schema changes replace that baseline and do not add migration paths. Declare upstream gaps explicitly rather than silently approximating them.

## Verification

Use isolated test data, not user documents. For affected paths verify:

- Idle open, selection, scroll and resize produce zero content updates for 60 seconds.
- Two replicas converge; remote application causes no echo. Same-user tabs show distinct presence; readonly does not publish/render editing selections.
- Pure deletions followed by repeated sync do not re-upload indefinitely.
- Lost/delayed/duplicate ACKs, reconnect and edits during remote reception do not lose data or show premature saved state.
- Snapshot plus log restoration and compaction preserve the online projection; mismatched epoch/schema is rejected.
- For Excel, test each changed operation class (row/column insertion/deletion, cells, formulas, merges, sorting/filtering, undo). Do not claim all operations converge from a cell-edit test.
- Revocation, disabled/anonymous users and spoofed identity/invalid ranges are handled.
- Format state drives both toolbars; no remount/focus loss on status updates.

In the handoff distinguish implemented behavior, verified tests, external-service verification, and still-proposed contract changes. A successful build alone is not collaboration verification.

For file import/export touching initialization or persistence, read [file exchange](references/file-exchange.md). Default imports establish a new resource and lineage; exports are read-only projections. A converter must not clear an outbox, initialize an already-open document, or silently replace the active baseline.
