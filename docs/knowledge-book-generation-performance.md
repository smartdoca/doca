# Knowledge-book generation performance and batch checkpoints

[简体中文](knowledge-book-generation-performance.zh-CN.md)

2026-10-19. The user explicitly approved the new checkpoint table and private persistence format. Implementation was validated with isolated data in that acceptance run, which did not deploy production. The reported 150,000-character, eight-hour production run was not available locally; these tests do not establish its specific causes or predict production duration.

## Execution improvements

Planned writing sizes claim batches against the model output budget before a paid request. Character allocations, exact claim coverage, bounded repair and explicit failure remain enforced. Independent review consolidation runs with the existing two-worker limit and preserves order and every negative finding. Single observations need no redundant consolidation call. Whole-book acceptance and required quality gates remain in force.

Previously only complete nodes survived a process restart. Complete validated requests now survive within an unfinished node, including outlines, claim assignment, extraction, writing, organization and quality reviews. Complete host subdivision decisions are saved so a known oversized parent need not be requested again. Partial model streams are never stored.

## Approved persistence contract

- Add an empty `knowledge_book_batch_checkpoints` table through latest DDL and `schemaEvolution` in the existing `doca-2026-10-12-book-payload-storage-v1` generation. No old rows are converted or backfilled. Historical complete-node reuse and its existing legacy-body boundary remain unchanged.
- Use a separate private `knowledge_book_batch_checkpoint_ref` v1 marker and batch owner with the existing immutable object codec and upload journal. Large results stay outside SQL. Existing node/run/release reference constraints and published v1 configuration/artifact formats are unchanged.
- Bind each request to its original run/node, frozen configuration, node input, source versions/content hashes and weights, current candidate, nonsecret model settings, algorithm version and exact request scope. `scope_hash`, `plan_hash`, `input_hash` and `batch_key` enforce identity. Never copy batches across runs.
- Persist only validated complete results or complete host subdivision decisions. Preserve negative verdicts and detailed diagnostics. Final aggregation, diagram validation, source authorization, quotas and publication acceptance still apply.
- Recheck source permissions and the active lease before reading, producing and transactionally installing a result. Competing instances install one immutable winner. Cancellation or permission/lease loss during upload prevents installation.
- The internal `evidenceInventory` stores source locators, versions, hashes, weights and permission references without source title/text copies. The model fingerprint contains provider, model, endpoint, API mode/version, input/output budgets and tool configuration, excluding API keys, aliases and prices.
- Content repair through the existing explicit resume flow establishes a new content scope and preserves old checkpoints without reusing them. A model or algorithm change in the same scope requires a new run. Unknown versions, corruption, invalid results or missing objects stop recovery; they never silently trigger regeneration or conversion.

These are new private checkpoints, not an adapter for old result formats. Existing rows without batch checkpoints keep their complete-node behavior until an unfinished node executes new requests.

## Deployment, retention and recovery

Back up the database and private object store, retain the original credential master key, stop executors, and update every executor and garbage collector together. Schema reconciliation adds the empty table transactionally and records its footprint without a generation bump. Mixed old/new executors or collectors are unsupported because old code cannot protect new references.

`DOCA_BOOK_BATCH_CHECKPOINTS` defaults to `on`; only `on` and `off` are accepted, and invalid values fail startup before opening the database. Restart after changing it. On the current binary, `off` reruns incomplete nodes while preserving all checkpoint rows and object pins. It does not bypass quality gates or modify data. Failures, trashing and mismatched scopes do not delete checkpoints; permanent book deletion releases their references through the existing explicit deletion path.

Offline body-storage rollback refuses existing checkpoints before modification. Downgrading binaries, restoring backups or converting checkpoints requires a separately approved preservation and recovery plan. Do not remove rows, objects or the table to bypass this boundary.

## Verification

The complete synthetic pipeline fails its second writing batch, replaces the entire runtime and resumes: total writing requests increase from two to three, not four, and all 42 claims proceed through acceptance and publication. Other tests restore long-form plans/assignments, negative diagnostics and subdivision decisions. A real file-store test commits one batch and kills the process with SIGKILL; a fresh process and lease restore the first batch with zero producer calls and execute only the missing batch once.

The actual released `smartdoca/doca:0.2.3` image created isolated SQLite and PostgreSQL 17/18 fixtures. Upgrading preserves all 13 old table record hashes, node/run/release body bytes, publication pointers and the generation; the new table starts empty. See the [verification record](verification/knowledge-book-checkpoints-2026-10-19/README.md) for commands, results and limits.
