# Realtime collaboration and saving

[中文](collaboration.zh-CN.md)

This page describes current host 0.1.10 behavior. Target component APIs and remaining work are in the [collaboration contract](collaboration-sdk-contract.md); former single-process and temporary-package records are in [research](research.md).

## Integrated formats

Rich text, Markdown, spreadsheets, canvas, and slides are integrated. The host installs public `@smartdoca/slate`, `@smartdoca/markdown`, `@smartdoca/sheet`, `@smartdoca/canvas`, and `@smartdoca/slides` packages, pinned by package.json and the lockfile. No private source directory or old vendor tarball is required.

All five share transport, authorization, and a local pending-update queue while retaining their own model, codec, schema, epoch, and view. Components restore authoritative checkpoints/baselines before mounting. Locale, readonly, selection, and save-state changes do not rebuild the document. Spreadsheets retain their immutable baseline and protocol data instead of using a rich-text model.

## Connection and messages

WebSocket uses `/api/v1/ws`. Browsers upgrade on the same origin with their session cookie; proxies forward Upgrade/Connection. Public resources allow readonly connections within their visibility. Each tab reuses the host connection for content, notifications, and presence.

Yjs bytes use base64 in JSON envelopes. Actual messages and format validation are defined by the [gateway](../apps/server/src/services/realtime/gateway.ts) and [protocol checks](../packages/core/src/modules/collaboration/protocol.ts):

| Message | Current purpose |
| --- | --- |
| ready / join | Connection ready, join and negotiate codec/schema/protocolVersion |
| sync-request / sync-response | Authoritative differences, epochId, seq, format baseline, and access; a sync response is not a save ACK |
| update / ack | Submit local edits; acknowledge the matching message after database commit |
| presence / cursor / cursors | User presence and temporary per-session selections |
| document.changed / notifications.changed | Invalidate content/detail or persisted notification reads |
| leave / error | Leave or report authorization, protocol, and connection errors |

Once the epoch is known, edits must carry matching protocol, codec/schema, and epoch. Identity, connection ID, name, and color come from the server. Writes and broadcasts recheck current access, never client-claimed identity.

## Save, reconnect, and history

Only actual local content transactions enter `update-outbox.ts`. Initialization, remote application, presence, scrolling, and resize do not submit content. Pending edits retain original bytes and message IDs. A matching ACK removes its update; sync responses and unknown ACKs never clear the queue.

The server validates and persists content and derived projections in a transaction, then acknowledges and broadcasts. Receipts deduplicate by resource, epoch, and message ID; the same ID with different bytes is rejected. Checkpoints preserve CRDT identity; independent history records retain their own format, lineage, and assets. See [history and restore](document-experience.md#history-and-restore).

Disconnection retains the current page's memory. Reconnect pulls authoritative state and retries unacknowledged edits. There is no persistent IndexedDB outbox; refresh or page close can lose unacknowledged content, so persistent offline editing is not promised.

## Presence and comments

User counts are deduplicated; editing selections belong to connections, including separate tabs of one account. Presence is temporary and creates no content/history writes. Rich text, Markdown, spreadsheets, canvas, and slides use their own implemented adapters. Readonly views do not publish editing selections.

Permanent comment anchors are separate: rich-text anchors, Markdown ranges, stable spreadsheet row/column identities, and canvas/slide element regions use format-specific validation. Spreadsheet comments follow stable records through supported structural changes; temporary A1 selections are not their persisted anchor. See [comments and notifications](comments-and-community.md).

## One instance and replicas

Without Redis, broadcast, presence, and limits stay in the process. With Redis, content changes, permission invalidation, notifications, and presence cross instances. Shared database content remains authoritative; Redis Pub/Sub is not a durable log. Configured Redis failure never silently falls back to the local bus.

Replicas also require shared PostgreSQL, file storage, and consistent desired plugin versions, with independent installation caches. See [horizontal scaling](horizontal-scaling.md). Full load, network-failure matrices, and real devices require target-environment acceptance; automated tests use isolated data.
