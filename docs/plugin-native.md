# Native plugin cache and attachments

[中文](plugin-native.zh-CN.md)

In the native plugin container, `host.ai.open` uses `assistant.open` to open the native personal assistant. Parameters and errors follow the [launch contract](plugin-assistant.md). Prompts and context stay out of navigation URLs; account credentials stay out of the WebView. Prefill requests are consumed in memory under the current account and a one-time launch identifier.

Public types come from `@smartdoca/plugin-sdk/native`, exposed through `PluginWebHost.native`. This property is null on Web. The App plugin container provides:

- `storage.get(key)` / `set(key, value)` / `remove(key)` / `clear()`: string cache, at most 2 million characters per value and 20 million per plugin.
- `attachments.save({path,name,mime})` / `share(...)`: `path` is relative to the plugin API, for example `/mailboxes/123/attachments/456?download=true`.

The native host binds the cache namespace to the server, online-verified user ID, and plugin ID. Plugins cannot choose another identity. Data lives in the App's persistent directory, survives restarts, and is cleared for the corresponding server when signing out or removing the account. Writes are serialized; a new snapshot finishes before replacing the previous one. The WebView remains temporary and isolated; login cookies are not a persistent-cache mechanism.

The native host verifies the signed-in identity online before loading a plugin. Existing plugin IndexedDB code is not automatically migrated or adopted; plugins explicitly use `native.storage`. Fully offline cold starts are unsupported. App removal or system storage cleanup may remove the cache.

Attachment downloads use internal authenticated host dispatch. Redirects to external origins are forbidden and the native session token is never provided to the WebView. Attachments are at most 32 MiB. Temporary files are cleaned after save/share.

Android save uses the system directory picker and returns `completed` or `canceled`. iOS save and share present the system share sheet and return `presented`. The system API does not reliably report final save/cancel results, so `presented` does not establish a successful save.

Page disposal or account switching cancels active native requests. Mail account linking happens on Web; there is no native OAuth flow.

Type checks and protocol/host-download tests passed in the recorded implementation. Cache persistence, system sharing, and saving still require iOS/Android device acceptance.
