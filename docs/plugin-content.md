# Content providers: content.v1

[中文](plugin-content.zh-CN.md)

The public entry is `@smartdoca/plugin-sdk/content`. The host defines the contract and invocation boundary; plugins implement business behavior. Built-in documents/files register through the same interface. Registering a source does not automatically expose every source to AI.

## Contract

- `sources(context, purpose)` discovers source declarations.
- Sources require `list`, `read`, and `resolve`. Optional `search` must agree exactly with the capability declaration.
- `list(context, {config, cursor, limit})` returns lightweight `{items,nextCursor,snapshot}`. Each item includes `ref:{sourceId,resourceId,blockId}`, `fingerprint`, and `title`, optionally `order`, `anchor`, and a short `excerpt`. Body `text` is forbidden.
- `read(context, {config,ref,fingerprint})` returns the list fields plus the selected block's `text`, or null when currently unreadable. A changed fingerprint produces a conflict and requires re-enumeration.
- `resolve(context,ref)` reauthorizes and returns `{path,fingerprint}` or null. Paths must be inside the application.
- `search(context, {config,cursor,limit,query})` returns the same lightweight list. Sources implement search; the host does not substitute a full-body scan.

Service list/read/search calls also carry `sourceId` and `purpose`. Callbacks receive the actual `principalId`, `purpose`, and `signal`. Every invocation checks account, configured scope, and current permissions; body-supplied user IDs are untrusted. The host checks user/source lifecycle before and after calls and applies a 20-second timeout.

```ts
const content = context.inject(contentServiceToken);
content.register({
  id: "example.tasks.content", pluginId: "example.tasks", version: 1,
  title: { zh: "待办", en: "Tasks" }, contentTypes: ["task"],
  purposes: ["analysis", "knowledge"], capabilities: { search: false },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  list: listAuthorizedTaskBlocks,
  read: readAuthorizedTaskBlock,
  resolve: resolveAuthorizedTaskBlock,
});
```

The plugin implements all three callbacks. It must not read private host tables/source or another plugin's database.

## Reconciliation

Consumers store references/fingerprints under the current identity and subscription configuration. After complete enumeration, unchanged blocks need no read/AI analysis, while changed blocks are read directly. Only a successful complete traversal establishes disappearance. Timeouts, failed pages, changed snapshots, and uncertain permission cannot be treated as an empty set or advance consumed fingerprints.

`cursor=null` begins; `nextCursor=null` ends. A traversal's snapshot must remain consistent. Cursors enumerate pages; they are not durable incremental-log positions. Reject old cursors when content, scope, or permissions invalidate completeness. Separate `listChanges`/`readChanges` are not required.

Limits: 100 items per page, 2 million body characters per block, 100,000 blocks in a complete inventory. The host validates references, duplicates, cursors, and cancellation. Analysis helpers bound the total changed text and fail explicitly on overflow rather than truncating and claiming completeness.

Built-in sources use paragraph content addressing. Inserting a paragraph before an unchanged paragraph does not change its identity. Editing a body removes the old block and creates a new one. These are not native editor stable node IDs. Duplicate-block, heading-context, and long-paragraph slicing rules are in the [fingerprint record](content-fingerprint-reconciliation.md).

## Host APIs and consumers

HTTP: `GET /api/v1/content/sources?purpose=analysis`; POST `/api/v1/content/list`, `/read`, `/resolve`, `/search`. Identity comes from the host session and responses use no-store.

Global search calls only sources declaring search. Document/library filters that cannot apply to plugin business scopes exclude those plugin results. Clicking resolves access again.

Knowledge content subscriptions reuse `knowledge_subscriptions`, `knowledge_source_groups.config`, and existing curation jobs. Configuration stores source settings, identity, and consumed fingerprints without mirroring complete email bodies. `POST /api/v1/knowledge/libraries/:id/content-subscriptions` takes `{sourceId,config,title}` and requires the source's knowledge purpose. Curation analyzes changed blocks and confirms fingerprints only in successful transactions; draft citations carry `contentRef`.

The existing agreed policy for deleted/unbound/revoked sources suspends derived access/retrieval and preserves content for managers. New document reads, lists/search candidates, and Q&A snapshots filter by the current inventory/fingerprints. Source failures block the operation rather than delete content; management retains entries. This increment does not guarantee immediate eviction of already-open collaborative sessions or recall of already-delivered content.

External source revalidation happens before transactions. Transactions commit only configuration CAS, subscription state, and consumed fingerprints. Operation-scoped prechecks bind reader identity and entry-reference signatures. Transaction reads without prechecks conservatively block derived content. A specified document/library bounds prechecks; cross-library lists check candidate derived entries.

The source picker provides basic schema forms; complex nested configuration needs the plugin's own page. `PUT /api/v1/knowledge/libraries/:id/content-source-groups/:groupId` takes the creation parameters. Only the subscribing principal can change scope. Changes trigger reconciliation and preserve existing content for review.

`knowledge.sources.v1` is not automatically adapted to `content.v1`; business plugins implement the public standard. This increment introduced no new database structure, historical conversion, or old-protocol compatibility code.
