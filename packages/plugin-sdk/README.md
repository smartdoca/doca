# @smartdoca/plugin-sdk

Doca's public plugin SDK. Plugins declare service requirements and own their business implementation and storage. They must not import host source paths or use private runtime bridges.

## Public capabilities added in 0.1.2

- `@smartdoca/plugin-sdk/content`: `contentServiceToken` / `content.v1`. Required source methods are `list`, `read`, and `resolve`; `search` is optional and must match its declaration. `list` returns lightweight block references and fingerprints, never full bodies. Consumers enumerate a complete snapshot, read changed blocks with the expected fingerprint, and acknowledge consumption only after successful work. Current identity, source scope and authorization apply to every call. Cursor or snapshot failure must never be treated as a completed empty inventory.
- `@smartdoca/plugin-sdk/platform`: `activityServiceToken` / `activity.v1`. Plugins own recent-visit storage and provide authorized paginated records and current-item lookup. Registration follows plugin lifecycle.
- `@smartdoca/plugin-sdk/web`: `PluginWebHost.native` provides per-origin/user/plugin persistent storage and attachment save/share inside the Doca native container. It is null on Web. Cache usage is explicit; IndexedDB is not converted. Attachment paths are relative to the plugin API namespace. The native bearer token is not exposed to plugin JavaScript.
- `@smartdoca/plugin-sdk/native`: native request types and validation. The host handles system file dialogs and sharing; the plugin must not interpret `presented` as proof the user completed sharing.

The source types and generated declarations define exact request/response fields. The Doca repository's `docs/plugin-development.md` is the development entry point, with `docs/plugin-content.md`, `docs/plugin-activity.md`, and `docs/plugin-native.md` describing integration and limits. A source must implement the current protocol; the host does not convert the earlier knowledge source protocol.
