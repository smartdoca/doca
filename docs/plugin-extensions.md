# Public reads and UI extensions

[中文](plugin-extensions.zh-CN.md)

This reference covers public read services and reusable Web commands, views, and placements. The original read/UI additions entered SDK source `0.1.4`; document elements entered `0.1.6`. For the current host, use SDK `0.1.9` and declare a matching `sdkRange` such as `^0.1.9`. Check the installed host and built SDK artifacts before relying on an API; a source implementation does not prove that an npm artifact or deployment has been updated.

## Public services

| Service / export | Methods | Purpose and boundary |
| --- | --- | --- |
| `users.v1` / `@smartdoca/plugin-sdk/platform` | `me`, `searchPage`, `resolveDirectory`, `validateSelection` | Honor administrator overrides and none/all/related directory policies; search exposes public display projections; self-profile reads are separate |
| `permissions.v1` | `registerDirectory` | Internal modules and plugins share `DirectorySource`; only related mode calls sources, verifies candidates, and merges user IDs |
| `documents.read.v1` / `@smartdoca/plugin-sdk/documents` | `get`, `readSnapshot`, `capabilities`, `references` | Document metadata, complete persisted native content, current capabilities, and references; separate from internal collaboration service `documents.v1` |
| `libraries.v1` / `@smartdoca/plugin-sdk/documents` | `list`, `children`, `path` | Discoverable libraries, paginated direct children, and authorized ancestor paths; content requires its own authorization |
| `files.v1` / `@smartdoca/plugin-sdk/files` | folders/files/uploads/bindings/content/receipts | Folder structure, file information, authorized streams, attachment bindings, uploads, and receipts |
| `content.v1` / `@smartdoca/plugin-sdk/content` | `list`, `read`, `resolve`, `search` | Content retrieval, analysis, and knowledge subscriptions; does not replace native document structure |

Tokens are `usersServiceToken`, `permissionsServiceToken`, `documentReadServiceToken`, `librariesServiceToken`, `filesServiceToken`, and `contentServiceToken`. Declare server requirements in `injections.required` and obtain implementations through `context.inject(token)`. Register a directory source only when contributing a relationship source. Source IDs must belong to the plugin namespace. The lifecycle owns registration; its disposer releases runtime contributions only.

`DirectorySource` retains schemaVersion 1 and the related/verify protocol. Built-in documents and shared folders also register sources. none search returns no candidates; use `me` to read yourself. all queries active site accounts directly without calling sources. related aggregates active sources in parallel, verifies candidates, and filters account status. Candidates from a source are rejected on errors, repeated cursors, exceeded budgets, or unregistration during execution. Paginated results report partial source failure with `complete: false`. Each source has a 2-second budget, at most 40 pages, and at most 250 candidates per page.

`searchPage({query,cursor?,limit?})` returns `{items,nextCursor,complete}`; limit is 1–100, default 20. Cursors bind the caller, query, and effective directory mode; each page reauthorizes. A policy change during pagination returns 409: restart from page one. `resolveDirectory({ids})` and `validateSelection({ids})` accept at most 100 IDs and recheck the current directory. Discovering an account does not grant sharing, assignment, or business-resource permissions. Existing `search` still returns an array of at most 20 items; the trusted server-only `list` is not exposed to browsers.

`readSnapshot({documentId,expectedRevision?})` returns `{documentId,format,codec,schemaVersion,revision,epochId,seq,content,assets}`. Supported formats are rich_text, markdown, spreadsheet, canvas, and presentation. content is the editor's native model (a string for Markdown), rather than a summary or Yjs update. revision is an opaque content identifier incorporating actual content, codec/schema, and epoch/seq facts; it is separate from metadata version. An expectedRevision mismatch returns 409. Persisted rich text without a collaboration epoch returns `epochId: null` without creating an epoch. Missing persisted state returns 409 without initialization. Body JSON above 16 MiB returns 413.

A consistent transaction restores persisted content without mixing in unsaved editor changes or writing content, history, or ACKs. assets exposes only currently authorized stable fileId/name/mime, excluding storage keys, physical paths, and persisted temporary URLs. capabilities describes current resource permissions and snapshot support; it does not imply a public document-write service.

Library list/children returns `{items,nextCursor}`, using the host's current 100-item pages. children accepts `{libraryId,parentId,cursor?}` with parentId=null at the root; path accepts `{resourceId}`. Discovery and reading are distinct: a visible title may have role=none while body access is denied. Each page rechecks access and does not represent a frozen inventory. An incomplete traversal cannot establish that content has been deleted.

## Browser and App WebView

`PluginWebHost.platform` provides typed clients for these application services:

```js
const page = await host.platform.users.searchPage({ query: "张", limit: 20 });
const self = await host.platform.users.me();
const snapshot = await host.platform.documents.readSnapshot(
  { documentId }, { signal: context.signal },
);
const children = await host.platform.libraries.children({ libraryId, parentId: null });
const folders = await host.platform.files.folders.list({ parentId: null });
```

The users client includes me/searchPage/resolveDirectory/validateSelection; documents and libraries expose all reads above; files exposes folders.get/list and files.get/list. File writes, content streams, and attachment downloads use server `files.v1` or existing attachment capabilities; streams are not JSON.

Authenticated calls use `POST /api/v1/plugin-platform/{pluginId}/{operation}`. Only running installed-plugin namespaces and explicitly listed operations are accepted. Input cannot supply principal, mode, or an arbitrary service name. Responses are not cached. Existing `host.request` remains limited to the plugin's `/api/v1/plugins/{pluginId}/` API.

Mobile plugins use host-issued WebView sessions scoped to a single plugin. Public calls must stay within that namespace; the backend still checks current user and resource permissions. Plugins do not receive the native bearer token. Isolated tests cover the HTTP session boundary. These card and document placements are Web UI implementations; native mobile placements have not been implemented or accepted on devices.

## Commands, views, and placements

`WebPluginBundle` includes three optional collections:

- commands: reusable actions with id/pluginId/title/supportedContexts/execute.
- views: reusable views with id/pluginId/title/supportedContexts/render.
- placements: mounting records with id/pluginId/slot/order?/conditions?, referencing exactly one commandId or viewId. A view may specify dialog/drawer/sidebar presentation; otherwise it renders in place.

Titles use `{zh,en}`; IDs belong to the plugin namespace. supportedContexts is global/home/document/library/folder/resources. conditions filters targets, resourceKinds, formats, and capabilities. Support and visibility are display rules, separate from server authorization. Duplicate IDs, invalid slots, missing references, and cross-plugin references reject the whole bundle and withdraw registered contributions.

| Implemented Web slot | Context |
| --- | --- |
| global.more | Global actions share the upper-right app icon with web.more navigation; action/view entries use icons with hover labels; hide when both filtered sets are empty |
| global.leftMore | Global actions share the left More dropdown with web.leftMore navigation; hide when both filtered sets are empty |
| home.cards / home.actions | Home cards and shortcuts |
| document.toolbar / document.menu | Document ID, format, and current permissions; the same action can occupy both |
| document.sidebar / document.status | Sidebar and status content; on narrow screens the sidebar follows the document body |
| library.toolbar / library.nodeMenu | Library entry and directory nodes |
| folder.toolbar / folder.rowMenu | Current folder or row resource |
| resource.bulkActions / resource.details | Nonempty selection and document-detail extensions |

Context includes scope/target/locale/resource?/resources?/capabilities/signal, without automatically providing the body or full user directory. The host provides resource.read/comment/edit/manage display capabilities. File placements do not yet have a unified capability projection; absence does not establish access authorization.

Navigation management labels `web.more` as upper-right More and `web.leftMore` as left More. Administrators can place a plugin page on the left only after its server navigation allowedSlots explicitly includes `web.leftMore`; built-in user entries support both. `global.leftMore` is a separate optional client command/view slot supporting global context. Views without presentation expand within the menu.

The existing rules confirmed on 2026-10-02 keep `web.more` and `global.more` in the upper right. Existing configuration is not migrated and existing plugins do not automatically acquire left placements. Left More requires explicit declaration/configuration and does not receive automatic overflow. An entry can explicitly occupy both More locations; other deduplication/overflow rules remain. Navigation storage uses schemaVersion=1. Before rolling back to a host without left-slot support, remove and publish all web.leftMore configuration: the older strict validator cannot convert it. Also withdraw new client/server slot declarations or roll back the plugin.

This browser ESM example consumes no host source paths:

```js
export default host => {
  const pluginId = "example.tools";
  const viewId = "example.tools.preview";
  return {
    manifest: { pluginId, version: "1.0.0", targets: ["web"] },
    views: [{
      id: viewId, pluginId,
      title: { zh: "预览", en: "Preview" }, supportedContexts: ["document"],
      render(context) {
        return host.React.createElement("p", null, context.resource.title);
      },
    }],
    commands: [{
      id: "example.tools.open", pluginId,
      title: { zh: "预览", en: "Preview" }, supportedContexts: ["document"],
      execute(context) {
        host.ui.openView({ viewId, presentation: "dialog", context });
      },
    }],
    placements: ["document.toolbar", "document.menu"].map((slot, index) => ({
      id: `example.tools.placement${index}`, pluginId, slot,
      commandId: "example.tools.open",
    })),
  };
};
```

Views use the host React instance and bundle their dependencies; the host does not resolve bare npm imports in plugin ESM. Render/child-component errors are isolated, rejected command promises show feedback, and executing buttons are disabled. Plugin-created event handlers and asynchronous work must handle errors and cancellation themselves.

An in-place command/view signal is cancelled when context changes or the component unmounts. Opening a dialog/drawer transfers context to the panel's own session, so closing the triggering menu does not destroy it. Closing the panel, changing route, or opening another panel cancels that session. An old close handle cannot close a newer panel. These resource operations expose no selection handle or unsaved-model write contract.

## Capability boundaries

Selection/block/insertion positions, document mutation commands, public comments/history, sharing invitations, public AI execution, event field scopes, and theme contributions require their own contracts and implementation. This read/UI extension does not grant arbitrary global CSS/DOM mutation or introduce layout persistence, database migrations, or stored-format conversion.

Templates and materials now have a separate [creation resource contract](creation-resources.md). It reuses public packages, string tokens, plugin namespaces, lifecycle/disposers, authenticated context, and typed clients. It does not turn the existing document_templates table into a provider. files.v1 and content.v1 keep their existing semantics.

## Verification record

The original isolated checks cover directory aggregation/unregistration/policy changes, native models and revisions for all five formats, authorized pagination after rejected candidates, traversal, registration rollback, panel cancellation and stale handles, the HTTP allowlist, and cross-plugin mobile-session rejection.

`pnpm build:plugin-sdk` builds release artifacts. `node scripts/verify-plugin-sdk.mjs` copies artifacts into temporary independent node_modules, executes JavaScript, and checks .d.ts in a NodeNext project without host path mappings. It neither publishes npm packages nor installs into user plugin directories.

An isolated example was checked in a browser for home cards, upper-right More, document menu/toolbar, desktop sidebar, and snapshot dialogs. The two personal plugins and physical mobile devices require their own acceptance. The recorded 2026-10-02 run passed type checking, 162 test files (1021 passed, 3 skipped), SDK build/independent consumption, Web build, and whitespace checks. These are historical results, not checks rerun by reading this page.

## Document plugin elements

SDK source `0.1.6` introduced optional Web bundle `elements` and `@smartdoca/plugin-sdk/editor-elements`. It supports atomic rich-text inline elements, whole-cell spreadsheet canvas rendering, and configuration forms. The host commits configuration through native commands and undo; plugins receive no unrestricted editor handles. Unknown types/versions show an error placeholder while retaining the original JSON without conversion, migration, or cleanup. No provider is installed by default. See the [element contract](plugin-editor-elements.md) and [standalone countdown/news-link example](../examples/plugin-elements/README.md). Source acceptance does not establish npm publication, production installation, or device acceptance.
