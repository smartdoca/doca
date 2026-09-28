# Install and deploy plugins

[中文](plugin-deployment.zh-CN.md)

Plugins come from their own npm installation directory. Set `DOCA_PLUGINS_DIR=/var/lib/doca/plugins`, create a `package.json` there, and install plugins as direct dependencies with npm or pnpm. If that directory has no manifest, Doca starts with no business plugins.

`DOCA_PLUGINS_DIR` may be set in `.env` in the working directory. An unset, empty, or blank value falls back to `${DOCA_DATA_DIR:-./data}/plugins`. A relative path is resolved from the working directory. Restart after a change. Inside Docker the path is inside the container: mount a volume, and do not point at a path that exists only on the host.

Keep the program directory, the plugin install directory, and runtime data separate. Startup does not run install, does not scan transitive dependencies, and does not read plugin source from this repository. A plugin provides a static manifest, compiled server JavaScript, and optional browser assets. The package shape is in the [development guide](plugin-development.md).

The server checks the SDK range and dependencies, then runs the lifecycle. The web app loads the matching build from the bootstrap manifest and does not require a host rebuild. A registration error or load timeout is isolated to that plugin.

Install, upgrade, and remove while Doca is stopped, then restart. Hot removal of routes is not promised. A core upgrade does not overwrite the plugin root or its lockfile. Compatibility is still the SDK range check. A business plugin keeps its own data. It does not add business tables to the host, import host source, or use a global bridge.

`dispose` releases runtime resources and does not delete stored data.

Test a standalone package install, startup with no plugins, dependency conflicts, cross-user denial, instance isolation, and cleanup on shutdown. Mail has been removed from the host. A future mail plugin is verified in its own project.

In `initialize`, connect the plugin's own empty current-baseline database and register cleanup. Start private jobs in `ready`. Drain and close them in `dispose`. A mismatched schema refuses to start. Do not run upgrade scripts. Do not store the business database or credentials inside Doca, and keep the package directory separate from private data. The latest integration notes are in the [mail handoff](plugin-mail-handoff.md).

## Delivery and upgrades

An SDK range check does not replace a schema check. A plugin accepts only an empty database that matches its current package. A mismatch refuses startup. There is no downgrade or database upgrade path.

Disabling takes effect after a stop, a config change, and a restart: jobs stop, sources unregister, and business access is denied. Uninstall keeps data by default. An explicit wipe is a separate operation that states its scope and asks for confirmation, and it rechecks other live references to attachments. The admin UI for this is not fully delivered, so do not promise hot unload or an automatic wipe.

Acceptance uses a real host build, the SDK, and plugin tarballs outside this repository, with a complete dependency closure. Install and startup do not fetch from a package registry, follow source links, or use an undeclared cache. Keep versions, checksums, the lockfile, and results. Cover web loading, the business flow, revocation, retry, and restart. Importing the SDK is not end-to-end acceptance. The priority order is in the [mail handoff](plugin-mail-handoff.md#adjusted-acceptance-order).
