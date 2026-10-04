# Install and deploy plugins

[中文](plugin-deployment.zh-CN.md)

The approved [managed storage contract](plugin-horizontal-scaling.md) requires `doca.storage: "host"` and host-owned persistence. Static rejection, managed SQL and private objects are implemented. Credentials are exported in SDK source 0.1.8; temporary workspaces and cluster task draining remain gaps. Plugins do not choose local/remote backends or receive business-data directories.

Administrators use **Admin → Plugins** to browse the official store, upload a local ZIP, install, upgrade, enable, disable or uninstall plugins. Changes are saved as the desired installation and take effect on each instance's next restart. The page shows the answering instance's running version separately from the global target. Current uninstall calls the required business cleanup hook, then clears the structure marker. Hook failure leaves installation intact. Host-managed private-store cleanup uses generation fencing and durable object garbage records; business task draining remains unimplemented; plugin filesystem deletion is prohibited. Upgrades of an installed plugin still require the same `doca.dataVersion`. Plugins check their actual database structure during initialization.

```dotenv
DOCA_PLUGIN_STORE_URL=https://store.smartdoca.cc
DOCA_PLUGINS_DIR=/data/plugins
```

The store address is a configurable HTTPS origin. Verify remote-service availability separately; an unavailable store leaves local upload and installed plugins usable. Empty `DOCA_PLUGINS_DIR` falls back to `${DOCA_DATA_DIR:-./data}/plugins`, relative to the working directory. Only the host configures durable database/object storage. There is no plugin business-data-directory environment variable; plugin APIs never expose whether the host stores locally or remotely.

For the supplied Compose deployment, execute in the deployment directory:

```sh
docker compose restart doca
```

Restart every instance in a multi-instance deployment; use the appropriate supervisor for other deployment types. The UI does not restart processes. During a rolling restart, drain traffic or use affinity if plugin APIs have changed. V1 does not promise zero-downtime mixed-version APIs.

## Implemented storage revision (2026-10-03, SDK source 0.1.8)

`@smartdoca/plugin-sdk/storage` now exports installation-bound `pluginDatabaseToken` (`storage.sql.v1`) and `pluginObjectStorageToken` (`storage.objects.v1`). The database subset is explicit schema version 1, text/int32/double columns, primary/unique constraints, structured select/insert/update/remove and transactions with callbacks executed once. SDK source 0.1.8 additionally exports `pluginCredentialToken` (`storage.credentials.v1`): server-only encrypted CRUD, metadata and revision checks. See [credential API](plugin-credentials.md). Joins, foreign keys, generic SQL, upsert and workspaces are not exported. Current SDK isolation is enforced by host-compiled queries over namespaced tables on the host connection; separate PostgreSQL roles/process isolation remain a stronger future boundary.

Logical databases use `plugin:<pluginId>`, user-file attribution and private objects use `plugins/<pluginId>`, and release ZIPs use `host/plugin-releases/<sha256>.zip`. Complete immutable ZIP bytes live in environment-configured file storage; the shared database holds registry version 2, archive references and trusted file-hash indexes. Verified cache hits do not download ZIPs again. All instances are restarted manually. The new host baseline rejects older databases/formats/SDK packages and preserves their data, with no migration or fallback. See [exact implementation and limitations](unified-storage-implementation.md).

## Distribution and filesystem

All instances use the same host database. PostgreSQL is the distributed deployment choice. The database stores an atomic desired registry and immutable archive references; complete ZIPs, including local uploads, live in the configured shared file store. Each instance has a private writable cache:

```text
/data/plugins/
  .releases/<sha256>/          verified immutable releases
  .staging/                   temporary extraction
  .imports/                   retained offline folder imports
```

Startup checks every file against the shared archive, restores missing or corrupted files and only then imports plugins. It never installs npm dependencies, compiles source or contacts the store. A missing or corrupt shared archive refuses startup. Back up both the shared database metadata and the configured file stores containing immutable releases. The host also backs up managed plugin records, private objects, user-file references and credentials. Multi-instance persistent backends must be shared; a directory name is not a distributed database.

Do not share a plugin cache directory between live instances. Installing on one instance does not require manually copying it to another. Historical versioned browser assets can also be restored on demand from the shared archives to handle load-balancer routing.

Offline installation: while an instance is stopped, put a complete release at `<DOCA_PLUGINS_DIR>/<plugin-id>/`. On startup, it is packed and published to the shared registry, then moved to `.imports/`. Other instances synchronize on restart. Routine administration should use ZIP upload. There is no root npm manifest or source-loading compatibility path.

Local ZIPs and store ZIPs have the same layout and checks. Use the [store protocol and package specification](plugin-store-protocol.md). Program files, writable business data and credentials must be separate. No scripts run during extraction. Complete runtime dependencies must ship as real files; pnpm links are not distributable artifacts.

## Lifecycle and retention

The host validates SDK range, duplicate IDs, data version and plugin dependencies before importing code. Configuration is global; request identity and permissions remain host-owned. Management writes use revision checks so conflicting administrators retry instead of overwriting each other. Operations create security-audit events.

Disabling and uninstalling apply on restart. Until then the old process still serves the old plugin. Old code caches and immutable archives are retained for running instances and reinstallation; there is no automatic archive garbage collection in v1. Disable/shutdown preserve durable state. User attachments, document payloads, other-business references and file receipts are not automatically deleted; managed private-state cleanup is host-owned and still requires a cluster coordinator. Cancellation restores the answering instance's startup selection; it is a new global desired-state change, not an instant rollback of other processes.

If initialization fails, Doca refuses startup rather than skipping a required plugin. Correct the package or desired installation using another healthy instance. The first release does not offer a repair-mode server, automatic database migrations, hot unloading, native mobile dynamic code or a cluster-wide completion dashboard.

Validation uses isolated databases and temporary directories. See [store acceptance](plugin-store-protocol.md#cross-repository-acceptance).
