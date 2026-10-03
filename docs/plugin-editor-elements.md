# Plugin document elements (SDK 0.1.6 source)

Implemented on 2026-10-02 in host source 0.1.8, SDK 0.1.6, contracts 0.1.6 and Web registry 0.1.3. This records source exports and isolated acceptance, not npm publication, production installation or native-device acceptance. The agreed storage policy is exact-version support: unknown types and versions display an error placeholder and retain their original JSON. No adapter, automatic conversion, migration or data reset is introduced. Existing internal document-reference readers are unchanged.

## Public registration

Import `PluginElementContribution`, `PluginElementPayload`, `createPluginElementPayload`, `pluginElementState`, `isPluginElementPayload` and `validatePluginElementPayload` from `@smartdoca/plugin-sdk/editor-elements`. Return optional `elements` from the normal installed Web plugin bundle. The host registers each contribution in `WebPluginRegistry.elements` under the owning plugin namespace and disposes it with the bundle. Duplicate ids and invalid declarations fail registration and roll back the bundle's registrations.

```ts
import type { PluginElementContribution } from "@smartdoca/plugin-sdk/editor-elements";

// Return this contribution from the injected Web plugin factory.
const element: PluginElementContribution = {
  id: "example.elements.countdown", pluginId: "example.elements",
  title: { zh: "倒计时", en: "Countdown" }, dataVersion: 1,
  formats: ["rich_text", "spreadsheet"],
  validate: data => typeof data.targetAt === "string" &&
    Number.isFinite(Date.parse(data.targetAt)),
  text: data => `Countdown: ${data.targetAt}`,
  renderEditor: context => /* injected React configuration form */ null,
  render: (payload, context) => /* injected React inline view */ null,
  renderCell: context => { /* draw within context.rect using context.canvas */ },
  refreshIntervalMs: 1000,
};
```

This declaration illustrates the exported signatures; [the independent example](../examples/plugin-elements/README.md) includes working forms, renderers and installation files. Plugins use injected host React and bundle their own dependencies. They must not import host source paths or use global editor bridges.

Every contribution requires localized `title`, a positive integer `dataVersion`, at least one supported format, `validate`, `text` and `renderEditor`. `rich_text` requires `render`; `spreadsheet` requires `renderCell`. Optional `onCellClick` receives the payload and public context. Optional `refreshIntervalMs` is an integer from 1000 to 60000 and refreshes the canvas view only.

The context contains `documentId`, `format`, `locale` (`zh` or `en`), `readOnly` and an `AbortSignal`. Form context additionally provides cloned `initialData` or null, `submit(data)` and `cancel()`. Canvas context provides a cloned `payload`, the canvas and the clipped cell rectangle. Configuration is submitted through the host; plugins receive no mutable editor handle, private runtime or independent persistence channel. Render errors produce a localized placeholder. Plugins handle their own event/async failures and cancel work when the signal aborts.

## Stored content

```json
{
  "version": 1,
  "pluginId": "example.elements",
  "type": "example.elements.countdown",
  "dataVersion": 1,
  "data": { "label": "Launch", "targetAt": "2026-10-04T00:00:00.000Z" },
  "text": "Launch · 2026-10-04T00:00:00.000Z"
}
```

`version` is the envelope version; `dataVersion` is the contribution's exact data version. `data` contains plain JSON configuration. `text` is a bounded static projection for text-based consumers. Do not persist render functions, credentials, temporary URLs, ticking values or timers. Opaque payloads must be plain JSON objects, at most 32 KiB UTF-8, depth 20 and 4096 nodes. Unsafe prototype keys and non-finite/non-JSON values are rejected before persistence.

The current envelope recognizer accepts only the six declared fields. A structurally valid unknown envelope, uninstalled/disabled provider, unknown type, unsupported format or mismatched version renders an unsupported placeholder. A current provider rejecting configuration renders an invalid placeholder. Neither condition rewrites or drops data. The host does not call a mismatched provider's renderer or configuration editor. Users can explicitly remove an unsupported element through native editing and undo that removal. Re-enabling the exact provider can display the retained configuration again.

## Native editor integration

- Rich text uses one permanent host atomic inline extension, `custom:plugin-element`, and its shared codec. Its codec stores the entire opaque payload even with no business plugins loaded. Insertion captures a live Slate range, and editing locates the node by id. Insert/configuration/remove use native operations and native undo. This release supports inline atoms; arbitrary block layouts are not exported.
- Spreadsheet uses the public `cellRenderers` canvas extension and `custom.docaElement` on native `ICellData`. The cell's `v` is the static text projection. Insert/configuration commits retain the current cell style and set native text wrapping to CLIP so the projection does not overflow adjacent cells. Insertion replaces the selected whole cell's value/formula/rich text/custom data, which the dialog states explicitly. There are no floating objects or inline positions inside cell text. A stable single-cell anchor follows row/column edits while the form is open; a deleted or concurrently changed target fails submission. Native range commands provide copy, delete, undo and collaboration.
- Closing the dialog, changing editor context or leaving edit mode cancels the session. Submission rechecks the active provider, handle, readonly state and target. Rendering/registry changes do not remount the document editor. Plugin view refresh does not emit a document write.

The existing rich schema 3 and spreadsheet schema 6 keep their native checkpoints and reliable collaboration outbox. There is no second JSON autosave, transport, Yjs replay lane or business-plugin database for element content. Native checkpoints and same-model clipboard preserve payloads; existing text/Markdown/Office conversion limitations still apply. Rich atomic exports degrade to labels with the existing conversion warning; spreadsheet consumers can read the cell's static value. Exporting plain text is not a lossless plugin-element backup.

## Lifecycle, installation and rollback

No element provider is installed by default. Discover plugins only through the existing installation directory/ZIP mechanism. The current example manifest requires SDK `^0.1.7`; publish/install an SDK and host containing this increment before independent production use. Its server factory owns no business data, and uninstall does not delete document content.

Plugin disable/uninstall unregisters renderers, not persisted elements. Reinstalling an exact matching provider requires no data conversion. Rolling back to an older host that lacks the permanent native codec is not supported for editing these documents; preserve database/checkpoint backups and use the implementing host to access them. No downgrade rewrite or destructive cleanup is supplied.

## Acceptance

The isolated tests in `tests/plugin-editor-elements.test.ts` cover registry ownership/disposal/rollback, strict versions and JSON limits, rich atomic clipboard/deletion/undo and opaque CRDT round trips, native persistence/ACK replay/two-replica no-echo behavior, spreadsheet stable anchors/row insertion/copy/deletion/undo/reload/convergence, readonly authorization and atomic oversized-payload rejection. They create isolated databases and documents. The SDK verification script also checks a packed-style independent JavaScript and NodeNext declaration consumer with no host paths.

Browser acceptance uses an isolated database and a temporary installation of the independent countdown/news example. Real native containers and third-party plugins require their own acceptance. General block elements, cross-format lossless export and public arbitrary editor mutation commands remain future work.

Verified browser operations include rich insert/configuration/undo/redo/reload/readonly, sheet configuration/insert/undo/redo/reload, and unknown-type placeholders with removal-only configuration. The sheet projection clip was checked after saving and reloading. Final combined verification: TypeScript passed; 171 test files passed (1,066 tests passed, 3 skipped); SDK build and independent consumption passed; Web production build and whitespace checks passed.

## Performance acceptance (2026-10-02)

Run `node --import tsx scripts/benchmark-plugin-elements.mts`. On this macOS arm64 machine with Node 24.15.0, median native projection of 1,000 ordinary paragraphs was 0.513 ms with the two original inline codecs and 0.515 ms with the element codec added. The paired median delta was within measurement noise. The added sparse element check for 10,000 occupied ordinary cells cost 0.039 ms; with 100 configured elements it cost 0.111 ms. First validation of 100 countdown payloads cost 0.188 ms, while cloning and invoking 100 example canvas callbacks cost 0.101 ms. The callback benchmark uses a mock canvas and does not measure native painting.

Ordinary cells exit after checking the custom property. Rich validation is memoized, and canvas validation is cached per payload/provider and invalidated on registry changes. A single coalesced view timer is rearmed only by drawing a visible timed cell, with a minimum 1-second period. Hidden pages cancel it. A sheet without visible timed cells has no recurring refresh timer. Scheduler tests cover zero idle timers, coalescing 100 elements, leaving the viewport, hiding and disposal. Browser observation of ticking documents for more than 60 idle seconds showed no new content seq/history; timers never enter the persistence outbox.

These measurements show negligible added host CPU work for the tested cases. They do not guarantee zero cost for arbitrary third-party rendering, external fetching, huge visible element counts or every device. A production provider must validate its own render/async workload.
