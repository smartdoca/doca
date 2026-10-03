# @smartdoca/plugin-sdk

Doca's public plugin SDK. Plugins declare service requirements and own business models and authorization. All persistence uses public host-managed services; installed packages must declare `doca.storage: "host"` and never select local/remote backends or storage paths. Managed SQL/private objects are exported in 0.1.7, managed credentials in source 0.1.8; temporary workspaces are not exported; see the [storage contract](../../docs/plugin-horizontal-scaling.md). They must not import host source paths or use private runtime bridges.

## Public capabilities added in 0.1.6 (source)

`PluginWebHost.ai.open({prompt, context, documentIds, attachmentFileIds, sessionId, modelId, autoSend})` opens the personal assistant on Web and in the native App container. It pre-fills an editable draft unless `autoSend: true` explicitly submits a host job. All resource/session/model authorization and execution policies use the existing host flows. See the [launch contract and examples](../../docs/plugin-assistant.md). This source addition does not imply npm publication or an updated native App.

Template and material queries accept multi-source `providerIds`. Providers name and describe their own sources and optionally declare retrieval modes with an indexed/remote `retrieve` method. Public clients expose `templates.retrieve` and `materials.retrieve`; results and picker selections carry host-owned source metadata. The host never substitutes a full browse scan for unsupported retrieval. The agreed protocol change rejects singular query `providerId`, while resource references and stored content remain unchanged. See the [resource protocol and AI tools](../../docs/creation-resources.md).

`@smartdoca/plugin-sdk/editor-elements` exports typed document-element contributions, payload validation and exact-version state checks. Optional `WebPluginBundle.elements` registers rich atomic inline views and spreadsheet whole-cell canvas renderers/configuration forms. Unknown types or versions retain their original JSON and display an error placeholder; no conversion or migration is supplied. Native editing, undo and the host collaboration queue persist changes. No providers are installed by default. See the [element contract](../../docs/plugin-editor-elements.md) and [independent countdown/news example](../../examples/plugin-elements/README.md).

This source version also contains the sidebar `web.leftMore` / `global.leftMore` slots. Build and independent-consumer verification do not imply npm publication, production installation or native-device acceptance.

## Public capabilities added in 0.1.4

- `users.v1` adds `me`, policy-aware `searchPage`, `resolveDirectory` and `validateSelection`. Internal document/file relationships and plugin sources share the directory registry; none/all skip relationship sources.
- `@smartdoca/plugin-sdk/documents` exports `documentReadServiceToken` (`documents.read.v1`) and `librariesServiceToken` (`libraries.v1`). Read persisted native content with a revision, current authorization and an explicit size limit; traverse authorized library structure. The separate `content.v1` remains for plain content.
- `@smartdoca/plugin-sdk/web` adds `PluginWebHost.platform`, a typed public client, and `PluginWebHost.ui.openView`. `WebPluginBundle` accepts optional commands/views/placements. Current Web slots cover global more, home, documents, libraries and files. No registration is required for existing page plugins.
  Source now also exports optional `web.leftMore` navigation and `global.leftMore` UI placements for the sidebar dropdown. Existing `web.more` / `global.more` remain the top-right icon menu. These new slots require an SDK release containing this increment; the previously published 0.1.5 package does not include them.
- See `docs/plugin-extensions.md` in the host repository for exact methods, supported positions and limits. New methods require a host implementing SDK 0.1.4; there is no missing-method adapter. Source implementation does not imply npm publication or native-device acceptance.

## Public capabilities added in 0.1.3

- Installed plugins must implement `uninstall(context)`. The host calls it when an administrator uninstalls the plugin. The hook performs business cleanup through public host services, never by opening/deleting storage paths. Managed private-store cleanup belongs to the host and its cluster coordinator is not implemented yet. The call is idempotent. `dispose` only releases process resources and preserves durable state.
- `PLUGIN_SDK_VERSION` is this package's version. Import it from `@smartdoca/plugin-sdk` or `@smartdoca/plugin-sdk/version`.

## Public capabilities added in 0.1.2

- `@smartdoca/plugin-sdk/content`: `contentServiceToken` / `content.v1`. Required source methods are `list`, `read`, and `resolve`; `search` is optional and must match its declaration. `list` returns lightweight block references and fingerprints, never full bodies. Consumers enumerate a complete snapshot, read changed blocks with the expected fingerprint, and acknowledge consumption only after successful work. Current identity, source scope and authorization apply to every call. Cursor or snapshot failure must never be treated as a completed empty inventory.
- `@smartdoca/plugin-sdk/platform`: `activityServiceToken` / `activity.v1`. Plugins own recent-visit storage and provide authorized paginated records and current-item lookup. Registration follows plugin lifecycle.
- `@smartdoca/plugin-sdk/web`: `PluginWebHost.native` provides per-origin/user/plugin persistent storage and attachment save/share inside the Doca native container. It is null on Web. Cache usage is explicit; IndexedDB is not converted. Attachment paths are relative to the plugin API namespace. The native bearer token is not exposed to plugin JavaScript.
- `@smartdoca/plugin-sdk/native`: native request types and validation. The host handles system file dialogs and sharing; the plugin must not interpret `presented` as proof the user completed sharing.

The source types and generated declarations define exact request/response fields. The Doca repository's `docs/plugin-development.md` is the development entry point, with `docs/plugin-content.md`, `docs/plugin-activity.md`, and `docs/plugin-native.md` describing integration and limits. A source must implement the current protocol; the host does not convert the earlier knowledge source protocol.

## Template and material providers (SDK 0.1.5)

`@smartdoca/plugin-sdk/creation-resources` exports `templatesServiceToken` (`templates.v1`) and `materialsServiceToken` (`materials.v2`). Register providers/consumers through injected services; plugin lifecycle owns disposers. `host.platform.templates/materials` and injected `host.TemplatePicker/MaterialPicker` share the same authenticated services. No providers are installed by default. See [resource contract](../../docs/creation-resources.md).

## Managed storage

- `@smartdoca/plugin-sdk/storage` (source 0.1.7): `pluginDatabaseToken` provides an installation-bound structured relational database and once-only transactions; `pluginObjectStorageToken` provides opaque immutable private objects (32 MiB maximum). Ordinary files use `files.v1`; shared content/templates/materials use their existing services. No raw DB handle, filesystem path, other-plugin selector or backend connection credentials are exposed. See [implementation](../../docs/unified-storage-implementation.md).

- `@smartdoca/plugin-sdk/storage` (source 0.1.8): `pluginCredentialToken` (`storage.credentials.v1`) provides `create`, `inspect`, `get`, revision-checked `update` and `remove`. Plaintext is server-only; IDs are host-generated and bound to the receiving plugin installation. The host requires `DOCA_CREDENTIAL_MASTER_KEY`; plugins authorize their accounts before access. See [usage and deployment](../../docs/plugin-credentials.md).

Material collections (SDK source 0.1.9, contracts source 0.1.7): `MaterialsServiceV2` and version 2 providers require an explicit `collections` capability (methods or null). Material cards contain collection references; unified search/retrieve return separate `materials` and `collections` groups. Fetch collection metadata and paginated members with `collectionDescribe` / `collectionItems`. Source constraints and independent tags apply to UI and AI. No materials.v1 adapter or stored-data migration. See the [resource protocol](../../docs/creation-resources.md).
