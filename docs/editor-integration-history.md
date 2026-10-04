# Document integration and discovery

[中文](editor-integration.zh-CN.md)

## What shipped

- Library settings keep the title and owner at the top. A favorite control sits after the library name. Home separates favorite documents and favorite libraries.
- Switching libraries loads the right context and mounts only that library's tree. A personal document opens as its own page without the sidebar. Lists are bound to the query id and do not reuse the previous resource type.
- Internal document references and user mentions use platform inline atoms and keep the SDK link encoding. A reference stores `#/r/{resource UUID}`, not the current domain. It can be deleted or copied as a whole, and a click navigates directly.
- References from this document and references to this document appear above likes. Only documents the current user can read are counted, including anonymous public access. Revocation and deletion do not leak a title, an id, or a hidden count.
- The title is one truncated line, followed by overlapping online avatars and the full member list. This uses the existing presence message. It does not open a second collaboration connection. User counts are deduplicated. Session cursors stay separate.
- The fixed toolbar can set or remove a link. The find panel can replace one match or all matches. Readonly, offline, and presentation modes do not offer replace. Replace goes through the editor model and the local collaboration transaction. It can be undone and does not edit the DOM.
- Upload progress uses the SDK range 0 to 1. Video, images, and attachments share the authorized upload. Download uses the authorized `?download=1` URL as an attachment. An image download is not treated as a preview, and it does not bypass the ACL.

## Access and active display

The administrator entry is user visibility, then grants and content display.

| Setting | Default | Behavior |
| --- | --- | --- |
| New collaborator | Grant immediately | Can switch to taking effect after the invitation is accepted. Existing rights are not revoked backwards |
| Documents shared with me | Show after interaction | Direct document grant plus opened or accepted. Can show as soon as the grant is active |
| Collaborating libraries | Show when the grant is active | Can switch to show after open or accept. The owner is always shown |
| Public libraries | Do not show proactively | The signed-in public library catalog can be turned on |

A public document does not enter the shared list only because it is public. A document you can read can still be searched. A child reached through whole-library collaboration is not a direct share. An explicit grant on that document is. Favorites and recent visits follow your own actions and current permission.

Pending shares are a separate entry on home's Shared with me tab and on the library list. They are not mixed into the file list. A direct grant can be accepted into the list before it is opened. An invitation does not add permission until it is accepted. Existing public read is unchanged. Rejecting deletes that explicit grant and does not affect other sources. After it is withdrawn it cannot be accepted. An invitation notification reveals only the title required for that targeted resource.

Permission records use the current `grants` state. Managers see pending. Changing a role does not accept automatically. Accept, reject, and resource version changes finish in one transaction so they do not overwrite a concurrent permission edit.

## API

- `GET /api/v1/admin/distribution`: an administrator reads the configuration and revision.
- `PUT /api/v1/admin/distribution`: `{revision, grantMode: direct|invite, sharedDocuments: granted|interacted, libraryMembers: granted|interacted, publicLibraries: boolean}`. An old revision returns 409.
- `GET /api/v1/me/invitations`: invitations waiting for the current user and direct grants not yet visited. Other users' invitations are not returned.
- `POST /api/v1/me/invitations/:id`: `{accept: boolean}` accepts or rejects the current user's explicit grant. Withdrawn or deleted returns 404.
- `GET /api/v1/resources/:id/references`: requires read access. Returns `{outgoing, incoming}` of `{id,title,format}`, filtered both ways by current permission. Public resources allow anonymous access.
- `GET /api/v1/assets/:id/content?download=1`: download under the same asset ACL, as an attachment. Download does not follow the preview CDN redirect.

## Database and references

- `distribution_settings(id, config, revision)`: site policy.
- `grant_responses(resource_id, user_id, state)`: composite key, pending, granted, or accepted. A missing older row keeps the original grant. Pending does not join effective grants.
- `document_references(source_id, target_id)`: a unique directed edge. The source is a foreign key. The target is a stable UUID, so a deleted or temporarily unreadable target can remain. The target index supports the reverse query.

The same transaction that writes the body updates reference edges. Deleting a reference deletes the edge. Import and copy also create edges in the write transaction. Reads query the current index and do not repair data.

## Component boundary

`$doca-editor-integration` is available with `$doca-collaboration`. The full notes are in [the integration reference](../skills/doca-editor-integration/references/integration.md). That reference separates props and commands that exist from capabilities other modules have not implemented. Do not treat a target interface as a published API.

Find, replace, and undo should eventually live in each editor package. The platform owns the panel, shortcuts, and permissions. The rich text package does not yet export a complete find and replace API. Doca uses a Slate model adapter. Spreadsheets should wrap their native capability later and should not reuse Slate ranges. Search is literal and case-insensitive. There is no regular expression. Atomic references are not part of text replace. Highlighting still uses the rendered view. Large virtualized documents should use the package's model find and reveal API.

This round did not change upstream rich text source or add a transport protocol. The host shared WebSocket and outbox are still used. Persistent offline safety, permanent spreadsheet region anchors, and a finished conversion of every format are not claimed.

## Acceptance

Automated tests cover accepting, rejecting, and withdrawing invitations, administrator configuration and revision, separation of public, direct, and whole-library rights from proactive display, anonymous reference filtering, adding and removing references without increasing seq, atomic reference backspace and CRDT round trip, cross-format replace and undo, and asset download ACL.

Isolated browser checks cover two pages editing and mentioning on one account, internal reference links and navigation, inserting a link from the fixed toolbar, copy and paste of rich text that survives refresh, both reference directions, replace staying consistent on two pages, the first library document, settings and favorites, the avatar list, no new writes during 60 idle seconds, refresh recovery, and fixed home tabs. An async link form that the global menu closed early, and a selection reference that was released, were fixed. A real Chinese input method, every spreadsheet operation, and a full offline failure matrix are not part of this round's verification.

## Plugin elements increment — 2026-10-02

Source host 0.1.8 and SDK 0.1.6 now implement `WebPluginBundle.elements` and `plugin-sdk/editor-elements`. These are current source exports, not proof of npm publication or native-device acceptance. `@smartdoca/slate` 0.4.12 has a host-owned permanent `custom:plugin-element` atomic inline codec/renderer; business registrations change only its registry lookup and never remount the editor. `@smartdoca/sheet` 0.2.0-rc.17 exposes native `cellRenderers` and range `setValue(ICellData)`; the host stores a whole-cell element in `custom.docaElement` with a static text `v`. The fixed built-in `SpreadsheetCellObject` union is not extended or coerced.

Configuration sessions capture a live rich range or stable single-cell anchor, recheck readonly/provider/current target, and commit native operations with native undo. Missing type, provider, format or exact version shows an error placeholder while retaining opaque bounded JSON. Existing internal reference readers are unchanged. No compatibility adapter, automatic conversion or migration is introduced. General blocks, floating spreadsheet objects and public arbitrary editor mutation handles remain unimplemented. See the repository source `docs/plugin-editor-elements.md` and independent example `examples/plugin-elements/README.md` for precise fields, limits and installation.

Performance: ordinary cells take a property-check fast path. Validation is memoized per immutable payload/provider; registry changes invalidate the canvas cache. Only painting a visible timed cell schedules another view refresh, at most once per second; hidden pages pause and sheets with no visible timed cells have no recurring canvas timer. No ticking data is persisted. Third-party renderers still own their CPU/network work and require their own performance acceptance.

## Markdown bootstrap correction — 2026-10-03

The host restores the authoritative checkpoint into an empty replica before calling the shipped Markdown session factory. It no longer stamps local metadata into a loading replica: those unsubmitted CRDT clocks caused the first text update to depend on items absent from the server. Session status snapshots retain the same doc/text/awareness/undo objects. No schema, epoch or persisted-format adapter changes; existing pending edits are preserved and are not silently converted or cleared. Regression acceptance includes first-edit durable restore, no remote/bootstrap echo and stable status handles; browser verification covers typing, cross-instance updates, reload and idle checks on isolated documents.
