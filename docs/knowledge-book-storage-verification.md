# Knowledge-book storage verification and operations

[简体中文](knowledge-book-storage-verification.zh-CN.md)

The complete plan was explicitly approved on 2026-10-12. Implementation and isolated verification completed on 2026-10-13; that verification did not convert a user database or deploy production. See the [implementation plan](knowledge-book-payload-storage-plan.md).

## Automatic startup upgrade in 0.1.24

Stop every old host and back up SQL, private storage and configuration. Starting 0.1.24 on released 0.1.22 generation `doca-2026-10-09-history-storage-v1` automatically compares the whole schema with current DDL. Once the plan passes review, the schema-lock transaction reconciles declared additions and records the target generation. Every business row and publication pointer remains untouched, including old SQL-generated outcomes, runs and human tasks. Existing 0.1.23 object storage data remains byte-exact. No manual book command is required, and no separate cleanup, automatic conversion or legacy runtime reader is added. Residual old book outcomes can require manual handling before their book is usable.

All structure/generation changes roll back on failure. Repeated/concurrent startup retains every row. Unknown, earlier and interrupted generations stop without changing data; unrelated unknown tables still require review. Preserve all data and post-upgrade writes during any backup recovery. Update all host and web instances together.

The existing maintenance commands below remain optional if old generated outcomes must be preserved in a usable native format. Execute the upgrade before first startup; schema alignment changes the source generation. The historical verification below establishes that optional conversion, not automatic adaptation of leftover SQL JSON.

Automatic alignment evidence: actual released 0.1.22 fixtures on SQLite/PostgreSQL 17/18 retained every row of 114 business tables and all 20 SQL bodies; new native objects remained readable after repeated/concurrent startup. PostgreSQL 17/18 each passed 91 regression cases, including rollback and strict legacy-body rejection. See [verification](verification/book-schema-startup-2026-10-13/verification.json).

## Maintenance commands

Use a new host build containing these changes and the existing deployment environment. Released `smartdoca/doca:0.1.22` is the conversion source and does not contain the new command. Stop every host and back up SQL (including SQLite WAL), private objects and configuration. Preserve the original master key, store IDs and backend configuration. Update all hosts and web builds together.

The command opens the existing database without initialization. Default mode performs full read-only preflight. Applying requires `--apply --hosts-stopped` and a new recovery manifest path. Manifests use mode 0600 and preserve the original footprint, owner identities, sizes and hashes without body mirrors.

```sh
pnpm knowledge-books:storage upgrade
pnpm knowledge-books:storage upgrade --apply --hosts-stopped --manifest /secure/book-upgrade.json
```

Only `doca-2026-10-09-history-storage-v1` is accepted. Earlier generations must first complete their exact supported history conversion. Running book tasks, unknown body formats, corrupt data and review-required structural differences block conversion without partial writes. Resolve the specific condition rather than cancelling unknown jobs, inventing historical fields or clearing SQL.

After interruption, ordinary startup rejects the progress generation. Resume the same command with the same manifest path. Converted bytes must still match that manifest; replacing it cannot bypass changed data. On completion, startup accepts only `doca-2026-10-12-book-payload-storage-v1`. The independent heartbeat reconciles outstanding notifications after startup; completed historical tasks are not backfilled. Historical outputs and errors remain preserved.

Current rollback rejects nonempty `knowledge_book_batch_checkpoints` before modification: their references require a separately approved preservation/recovery plan. Do not delete checkpoints or bypass the generation/structure checks. See [checkpoint retention and recovery](knowledge-book-generation-performance.md#deployment-retention-and-recovery). The historical roundtrip below predates batch checkpoints and does not verify arbitrary current-to-0.1.22 downgrades.

Stop all hosts again for an eligible rollback and preserve a new backup and recovery manifest. Preflight reads every object and verifies its original bytes. Rollback restores post-upgrade writes too and retains cloud objects and recovery materials.

```sh
pnpm knowledge-books:storage rollback
pnpm knowledge-books:storage rollback --apply --hosts-stopped --manifest /secure/book-rollback.json
```

Interrupted rollback resumes with its original manifest. After all JSON is restored and verified, only the four storage-extension tables are removed and the reviewed footprint/old generation are recorded. The target is the preceding 0.1.22 host. Complete book rollback before any optional older document-history rollback. Freed SQLite pages do not automatically shrink the file; no automatic VACUUM is performed.

## Isolated evidence

The actual source image was `smartdoca/doca:0.1.22`, image ID `sha256:a5316eb01bf25b0d89801139de85d34a35528be376699c4981ab8a09fd14f04c`. Its real runner generated published, failed and awaiting-publication synthetic tasks. No production database or user document was accessed.

Each SQLite/PostgreSQL 17/PostgreSQL 18 fixture contained 20 nonempty original bodies. Explicit upgrade, two ordinary startups and explicit rollback verified all 20 original JSON byte sequences and hashes, preserving states, errors, configuration and human tasks. Records are in `docs/verification/knowledge-book-storage-plan-2026-10-12/actual-roundtrip*.json`.

| Metric | SQLite | PostgreSQL 17/18 |
| --- | ---: | ---: |
| Original SQL body bytes | 3,698,834 | 3,698,834 |
| New SQL reference bytes | 7,170 | 7,170 |
| Serialized metadata JSON bytes | 403,190 | 404,294 |
| Unique objects | 266 | 266 |
| Roots / references | 8 / 20 | 8 / 20 |
| Registered compressed object bytes | 94,508 | 94,499 / 94,478 |

Metadata figures serialize objects, references, operations and dependency edges; they are not physical SQL page/index/WAL or backup measurements. This synthetic prose repeats heavily and cannot establish production savings.

Regression cases cover bounded chunks, escaping/Unicode, within-book sharing and cross-book isolation, competing uploads, interruption/resume, corruption, unknown-format rejection without partial DDL, rollback of newer writes, SQL-only summaries, cache permission revocation, trash/purge and late-upload cleanup. The CI PostgreSQL matrix includes knowledge-book and payload tests.

Browser evidence in `lazy-candidate.json` shows zero eager body reads, one read on expansion, reuse on reopening, body removal after revocation and no browser errors. Mermaid stability is recorded separately in `docs/verification/knowledge-book-reliability-2026-10-12/preview-result.json`.

## Operational boundaries

The host private local/S3 configuration is reused without public body URLs or module-owned credentials. Back up SQL and objects as a consistent set. Missing/corrupt objects fail explicitly while retaining references; empty bodies never substitute for unavailable content.

Cleanup deletes only unreachable objects. Trash retains references; permanent purge releases them. Live upload dependencies are protected and failed/late uploads retain durable keys for retries. Completed journals keep only losing concurrent physical uploads, while installed dependencies remain in objects/edges. No historical TTL is added.

Final checks: the 126-case SQLite relevant suite passed, followed by the 60-case books/payload suite after final endpoint/permission checks. Both PostgreSQL 17/18 relevant 68-case suites passed, and final 11-case payload suites passed on both engines. Type checking, Web build, documentation links and diff whitespace checks passed. See `docs/verification/knowledge-book-storage-plan-2026-10-12/verification.json`. Heartbeat and object cleanup use independent scheduling so cloud requests do not occupy heartbeat reconciliation.
