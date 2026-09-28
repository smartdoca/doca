# Editors, collaboration, notifications, and search

[中文](collaboration.zh-CN.md)

Rich text and spreadsheets share a local queue of increments waiting for acknowledgement. Spreadsheets publish the live cell selection. The shared protocol, version fields, and component interface are in the [collaboration contract](collaboration-sdk-contract.md). Where an older paragraph below is narrower than the current code, the current code wins.

## Packages

The host depends on the published npm packages `@smartdoca/slate`, `@smartdoca/sheet`, `@smartdoca/markdown`, `@smartdoca/canvas`, and `@smartdoca/slides`. Do not point a deployment at a private working tree. Bump the package version in the lockfile instead of replacing a tarball that keeps the same version.

The rich text stack is slate and slate-dom 0.118.1, slate-react 0.118.2, and slate-history 0.113.1. React 19 stays. Type resolution uses Bundler because upstream `.d.ts` files omit extensions. Vite builds the web app. tsx runs the server.

The web app imports the package entry and `style.css`. It holds one `Doc`, one `YjsDocument`, and a stable `createYjsAdapter`. The editor mounts only after the first sync. Do not rebuild the CRDT from a React controlled value. The server imports `/yjs` and does not load the browser UI. Spreadsheet and slides keep their own codec ids. They are not treated as rich text.

## WebSocket contract

`GET /api/v1/ws` upgrades on the same origin. The Vite dev proxy must enable WebSocket. A reverse proxy forwards `Upgrade` and `Connection` and sets a reasonable idle timeout. Host and Origin match the configured address exactly. The session comes from the HttpOnly cookie. A public document allows an anonymous read-only connection. A signed-out connection does not receive notifications or site statistics.

The envelope is JSON. Yjs bytes are standard base64. One browser tab has one connection and joins one document. Notifications reuse that connection.

| Direction | type | Meaning |
| --- | --- | --- |
| Server to client | ready | The connection is usable. The client joins again |
| Client to server | join | id, room (document UUID), optional vector |
| Client to server | sync-request | id, room, vector. Only a document already joined |
| Server to client | sync-response | id, room, update, vector, seq, rank, metadata |
| Client to server | update | id, room, update. Only editor and above may submit a state-changing update |
| Server to client | ack | id, room, seq, metadata. The transaction committed. Receipt is not enough |
| Server to other clients | update | room, update, seq, metadata. Not echoed to the sender |
| Client to server | leave | Leave the current document |
| Server to client | presence | room, users[{id, display_name}]. Several tabs of one user count once |
| Client to server | cursor | id, room, selection null or {anchor, focus}. Editor and above may publish a non-empty cursor |
| Server to client | cursors | room, self connectionId, sessions[{connectionId, userId, name, color, selection}]. The current connection is excluded. Other connections of the same account are not |
| Server to client | document.changed | HTTP management or a comment changed. Reread the detail and the sync vector |
| Server to client | notifications.changed | Invalidation. Refetch the current user's persisted list over HTTP |
| Server to client | error | optional id and room, status, message. Do not present it as saved |

Reconnect asks the server for the difference from the local state vector, then sends the local difference. Duplicate delivery is allowed. This is not the hocuspocus or y-websocket wire protocol.

Every message rechecks the session. Every edit rechecks the ACL under the metadata lock. Broadcast checks that the target user can still read. Sign-out, disable, and permission changes trigger a check, plus a 30 second ping and session recheck. Identity comes from the server. The client cannot claim a name.

Limits: one update is 1 MiB, a full Yjs state is 16 MiB, and one connection may queue 64 messages or 500 messages in 10 seconds. A slow client with more than 4 MiB of send buffer is disconnected. After a network loss the editor becomes readonly, keeps this page's memory, and reconnects. There is no IndexedDB offline store, so closing a page before ACK is not saved.

## Persistence and snapshots

`packages/core/src/modules/collaboration/documents.ts` stores and validates collaboration. `apps/server/src/services/realtime/gateway.ts` owns connections and message scheduling.

1. The first open of a placeholder or a new document initializes the title paragraph and empty body in one transaction and saves a Yjs checkpoint. The client never initializes the shared document.
2. Recovery is the checkpoint plus increments ordered by seq. Updates are merged and validated. Rewriting initialization metadata, missing dependencies, illegal links or file paths, dangerous attributes, and structures that are too deep or too large are rejected.
3. The same transaction stores the update, seq, searchable body text, and the title derived from the first line, and increments the resource metadata version.
4. ACK and broadcast happen after commit. A repeated update does not increment seq again.
5. Every 50 valid updates, or the next valid update more than 5 minutes after the last checkpoint, saves a full Yjs checkpoint and deletes increments the checkpoint already covers. CRDT identity and command history are kept. The document is not rebuilt from JSON. Increments are already durable while writing is idle. A timer does not force another snapshot.

Metadata version, collaboration seq, and the Yjs state vector have different jobs. They are not a future desktop backup version. Without Redis, the realtime room is one process. Several processes can serialize writes through the database, but they do not broadcast across processes. A multi-replica collaboration cluster needs the shared bus in [horizontal scaling](horizontal-scaling.md).

An independent copy creates a new Yjs identity, remaps upload asset ids, and keeps content. It does not copy comments, grants, or revocation history. Renaming an initialized rich document updates the first line in the same transaction and keeps the Yjs identity. Online pages receive an invalidation and pull the difference.

## Selection comments

HTTP comment create, update, and delete keep their permission rules. A root comment may also carry `anchor`, a JSON string:

```json
{"blockId":"block-id","quote":"selected text","start":"base64-relative-position","end":"base64-relative-position"}
```

The client computes UTF-16 offsets inside the block from the real Slate selection. Links recurse. A mention counts as one object character. The current support is a selection inside one text block. The server restores the stored Yjs, parses and re-encodes the anchor, and refuses an anchor on an unrelated document or on a reply. The quoted text is at most 5,000 characters.

Full-document comments sit at the bottom. Each root selection comment is a card on the right, positioned from the anchor's current DOM coordinates without overlap. Replies and the editor stay in that card. Deleted quoted text shows that the original text is gone. It does not guess a new position. The comment, author, and resolution state stay in business tables, not in the editable CRDT. The rail can collapse. A narrow screen shows it as an overlay. Body-range highlighting for comments is not implemented yet.

## Session cursors

A plain text position is `{blockId, position}` where position is the SDK relative position in base64. The client publishes at most every 150 ms, and only when the selection changes. It does not send the whole document. The server assigns connectionId and color and takes the name from the authenticated session. Online counts deduplicate users. Cursors are per connection, so two tabs of one account can see each other. Normal editing shows the cursor and selection background. Disconnect, leave, and lost permission clear them. Readonly and presentation modes do not show or publish a non-empty cursor.

A code block is its own textarea: `{kind:"code", blockId, offset, fingerprint}`. The fingerprint only checks that the text version matches. It is not authentication or a content digest. A mismatch is not drawn. A match measures the caret with a same-font mirror. Code blocks show an insertion caret, not a remote selection range. Mentions in the body count as one UTF-16 object. A selection across paragraphs uses two independent endpoints. Custom non-text controls such as chart interiors do not have a cursor adapter yet.

Cursors stay in process memory. They are not stored and do not create snapshots. Existing message size limits and document permissions apply. Extra fields are dropped. A text position is at most 512 characters. A code offset is at most one million. Closing a connection or leaving a room broadcasts the session list again.

## Meilisearch

An administrator configures document search: enabled, service URL, index name, status, and rebuild. The API key and allowed origins are under Platform settings, Service credentials, Document search, and are stored in the database. Allowed origins limit which service URL can be contacted. Redirects and URLs that contain credentials are rejected.

When enabled, the background uploads titles and bodies in batches, waits for Meilisearch tasks, then consumes durable increments about once a second. Each indexed document carries a content hash of the title and body. An unchanged hash is not uploaded again. The index returns only ids to the application search API. The browser does not talk to the search service. Before documents, counts, or pages are returned, the application runs the current ACL and every filter again. An old index row for a deleted or revoked document must not leak it.

The default reconciliation is every 6 hours, configurable from 1 to 168 hours, or started by hand. Remote ids and hashes are enumerated first, then compared with the current document projection. Missing, stale, and leftover deletes enter the existing sync queue. The scan does not call recognition or an embedding model. The list, cursor, lease, and repair state survive restart. Enumeration finishes before this round's cleanup, so the scan's own deletes do not skip offsets. Ordinary increments can still change remote pages during the scan. Later rounds converge. There is no atomic site-wide snapshot. Changing the index target or turning search on or off invalidates an old scan generation.

Image recognition is off by default. The policy version is stored and audited. The current version does not run an OCR or vision pipeline. The page says the setting is a preference for later. Turning it on does not mean images are recognized.

When search is off, building, or failing, title and body matching falls back to the database. The response includes `engine: database|meilisearch` and a notice when degraded. The database does not offer tokenizer forgiveness. Visible candidate ids are enumerated first and then given to Meilisearch. At 1,000 candidates with more pages, search falls back to the database. That is not a plan for a hundred-thousand-document deployment. The index contains private body text. Run it on a trusted network, with authentication, and include it in data protection.

The adapter is tested with a simulated API, following Meilisearch search-with-POST. A real Meilisearch and a real PostgreSQL server still need a deployment check.

## Acceptance boundary

Automation covers concurrent merge, idempotence, snapshot recovery, readonly rejection, Origin rejection, realtime push and online deduplication, relative-position comments, copy, and permission-filtered search. The browser uses an isolated acceptance document for two tabs typing, live display, and saving a selection comment.

This is not a full production certification. Chinese IME, very large spreadsheets, long concurrency, and fault injection still need acceptance on the editor packages. Export, persistent offline recovery, comment range highlighting, comment paging, and load tests against real Meilisearch and PostgreSQL are not finished. Other modules follow their own documents.
