# Historical change: independent plugin databases

Historical record: this per-plugin database design was released in 0.1.25. [0.1.26](0.1.26.md) replaces it with one shared plugin business database and requires uninstall/reinstall without data migration.
[简体中文](pending-plugin-database-isolation.zh-CN.md)

Original status on 2026-10-14: the candidate had not yet been published or deployed. The release status above supersedes that status; the verification results below retain their original scope.

Plugin SQL business tables move to host-managed independent databases: one SQLite file or one configured PostgreSQL database with a restricted role per plugin. Public SDK APIs remain unchanged. Core documents, users, permissions, ordinary user files and platform-owned plugin metadata remain in their current stores.

This change deliberately does not migrate existing plugin data. Normally uninstall all external plugins on the previous host, stop every instance, deploy, then reinstall and restart. The old host's uninstall deletes private business data, encrypted plugin credentials and private objects; reconfigure and rebind afterward. The new host rejects active old installations and residual old business tables without deleting them. See the [upgrade, recovery and storage contract](../plugin-database-isolation.md).

Verification completed on 2026-10-14:

- SQLite: 250 relevant regression tests passed; four PostgreSQL-only cases were skipped. The suite includes plugin SDK/runtime/installation, credentials, storage, core schema/baseline and file-store checks.
- PostgreSQL 17.11 and 18.6: 82 cases passed on each engine, including restricted-role/core-access rejection, independent pools, repeated declaration, callback rollback, stale-generation fencing, interrupted declaration/cleanup, schema reconciliation, files/folder sharing and knowledge-book startup upgrade.
- Actual released `smartdoca/doca:0.1.24` image, cached registry digest `sha256:a7520b7e49b8c645944402bfa098faa546f3ba5d57923515596f59032c2b1f59`: the approved uninstall → upgrade → reinstall workflow passed on SQLite and both PostgreSQL engines. Synthetic users, document records and encoded document states, permissions/settings and ordinary folders were compared with the old snapshot. Old plugin rows were deliberately discarded; the new independent business store was empty before its first write. Residual old installations/tables were rejected without deleting them.
- `pnpm typecheck`, documentation link/heading checks, Compose configuration validation and `git diff --check` passed.

All fixtures used newly created temporary directories and owned PostgreSQL schemas/databases/roles. Test helpers ignore deployment plugin database configuration. No production database or user document was modified. Production rollout and mixed-version operation are outside this verification.

To reproduce the released-image check, run `pnpm exec tsx scripts/verify-plugin-database-isolation-upgrade.ts sqlite`; for each dedicated PostgreSQL 17/18 test server, set `DOCA_TEST_POSTGRES` and run the same script with `postgres`. The script requires Docker and the released image, creates its own fixture databases/roles and cleans them afterward.
