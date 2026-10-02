# @smartdoca/plugin-sdk

Doca's public plugin SDK. Plugins declare service requirements and own their business implementation and storage. They must not import host source paths or use private runtime bridges.

## Public capabilities added in 0.1.4

- `users.v1` adds `me`, policy-aware `searchPage`, `resolveDirectory` and `validateSelection`. Internal document/file relationships and plugin sources share the directory registry; none/all skip relationship sources.
- `@smartdoca/plugin-sdk/documents` exports `documentReadServiceToken` (`documents.read.v1`) and `librariesServiceToken` (`libraries.v1`). Read persisted native content with a revision, current authorization and an explicit size limit; traverse authorized library structure. The separate `content.v1` remains for plain content.
- `@smartdoca/plugin-sdk/web` adds `PluginWebHost.platform`, a typed public client, and `PluginWebHost.ui.openView`. `WebPluginBundle` accepts optional commands/views/placements. Current Web slots cover global more, home, documents, libraries and files. No registration is required for existing page plugins.
- See `docs/plugin-extensions.md` in the host repository for exact methods, supported positions and limits. New methods require a host implementing SDK 0.1.4; there is no missing-method adapter. Source implementation does not imply npm publication or native-device acceptance.

## Public capabilities added in 0.1.3

- Installed plugins must implement `uninstall(context)`. The host calls it when an administrator uninstalls the plugin. The plugin deletes its own database and private state. The call must succeed again when that data is already gone. `dispose` only releases process resources and does not delete the database.
- `PLUGIN_SDK_VERSION` is this package's version. Import it from `@smartdoca/plugin-sdk` or `@smartdoca/plugin-sdk/version`.

## Public capabilities added in 0.1.2

- `@smartdoca/plugin-sdk/content`: `contentServiceToken` / `content.v1`. Required source methods are `list`, `read`, and `resolve`; `search` is optional and must match its declaration. `list` returns lightweight block references and fingerprints, never full bodies. Consumers enumerate a complete snapshot, read changed blocks with the expected fingerprint, and acknowledge consumption only after successful work. Current identity, source scope and authorization apply to every call. Cursor or snapshot failure must never be treated as a completed empty inventory.
- `@smartdoca/plugin-sdk/platform`: `activityServiceToken` / `activity.v1`. Plugins own recent-visit storage and provide authorized paginated records and current-item lookup. Registration follows plugin lifecycle.
- `@smartdoca/plugin-sdk/web`: `PluginWebHost.native` provides per-origin/user/plugin persistent storage and attachment save/share inside the Doca native container. It is null on Web. Cache usage is explicit; IndexedDB is not converted. Attachment paths are relative to the plugin API namespace. The native bearer token is not exposed to plugin JavaScript.
- `@smartdoca/plugin-sdk/native`: native request types and validation. The host handles system file dialogs and sharing; the plugin must not interpret `presented` as proof the user completed sharing.

The source types and generated declarations define exact request/response fields. The Doca repository's `docs/plugin-development.md` is the development entry point, with `docs/plugin-content.md`, `docs/plugin-activity.md`, and `docs/plugin-native.md` describing integration and limits. A source must implement the current protocol; the host does not convert the earlier knowledge source protocol.

## Template and material providers (SDK 0.1.5)

`@smartdoca/plugin-sdk/creation-resources` exports `templatesServiceToken` (`templates.v1`) and `materialsServiceToken` (`materials.v1`). Register providers/consumers through injected services; plugin lifecycle owns disposers. `host.platform.templates/materials` and injected `host.TemplatePicker/MaterialPicker` share the same authenticated services. No providers are installed by default. See [resource contract](../../docs/creation-resources.md).
