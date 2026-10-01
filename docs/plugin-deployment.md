# Install and deploy plugins

[中文](plugin-deployment.zh-CN.md)

Administrators use **Admin → Plugins** to browse the official store, upload a local ZIP, install, upgrade, enable, disable or uninstall plugins. Changes are saved as the desired installation and take effect on each instance's next restart. The page shows the answering instance's running version separately from the global target. Uninstall calls the plugin's required uninstall method so the plugin deletes its own business data, then clears the data version marker. A later install may use another structure. If uninstall fails, the plugin stays installed. Upgrades of an installed plugin still require the same `doca.dataVersion`. Plugins check their actual database structure during initialization.

```dotenv
DOCA_PLUGIN_STORE_URL=https://store.smartdoca.cc
DOCA_PLUGINS_DIR=/data/plugins
```

The store address is a configurable HTTPS origin. It is not deployed yet; an unavailable store leaves local upload and installed plugins usable. Empty `DOCA_PLUGINS_DIR` falls back to `${DOCA_DATA_DIR:-./data}/plugins`, relative to the working directory. Docker uses container paths. The supplied Compose file places the directory under the `/data` volume.

For the supplied Compose deployment, execute in the deployment directory:

```sh
docker compose restart doca
```

Restart every instance in a multi-instance deployment; use the appropriate supervisor for other deployment types. The UI does not restart processes. During a rolling restart, drain traffic or use affinity if plugin APIs have changed. V1 does not promise zero-downtime mixed-version APIs.

## Distribution and filesystem

All instances use the same host database. PostgreSQL is the distributed deployment choice. The host stores an atomic desired registry and immutable full plugin archives, including local uploads. Each instance has a private writable cache:

```text
/data/plugins/
  .releases/<sha256>/          verified immutable releases
  .staging/                   temporary extraction
  .imports/                   retained offline folder imports
/data/plugin-data/            suggested separate plugin-owned business data
```

Startup checks every file against the shared archive, restores missing or corrupted files and only then imports plugins. It never installs npm dependencies, compiles source or contacts the store. A missing or corrupt shared archive refuses startup. Back up the shared database as the plugin distribution source of truth. Plugin-owned databases and credentials have their own backups.

Do not share a plugin cache directory between live instances. Installing on one instance does not require manually copying it to another. Historical versioned browser assets can also be restored on demand from the shared archives to handle load-balancer routing.

Offline installation: while an instance is stopped, put a complete release at `<DOCA_PLUGINS_DIR>/<plugin-id>/`. On startup, it is packed and published to the shared registry, then moved to `.imports/`. Other instances synchronize on restart. Routine administration should use ZIP upload. There is no root npm manifest or source-loading compatibility path.

Local ZIPs and store ZIPs have the same layout and checks. Use the [store protocol and package specification](plugin-store-protocol.md). Program files, writable business data and credentials must be separate. No scripts run during extraction. Complete runtime dependencies must ship as real files; pnpm links are not distributable artifacts.

## Lifecycle and retention

The host validates SDK range, duplicate IDs, data version and plugin dependencies before importing code. Configuration is global; request identity and permissions remain host-owned. Management writes use revision checks so conflicting administrators retry instead of overwriting each other. Operations create security-audit events.

Disabling and uninstalling apply on restart. Until then the old process still serves the old plugin. Old code caches and immutable archives are retained for running instances and reinstallation; there is no automatic archive garbage collection in v1. Removing a plugin never deletes private business data or attachments. Cancellation restores the answering instance's startup selection; it is a new global desired-state change, not an instant rollback of other processes.

If initialization fails, Doca refuses startup rather than skipping a required plugin. Correct the package or desired installation using another healthy instance. The first release does not offer a repair-mode server, automatic database migrations, hot unloading, native mobile dynamic code or a cluster-wide completion dashboard.

Validation uses isolated databases and temporary directories. See [store acceptance](plugin-store-protocol.md#remote-store-acceptance-checklist).
