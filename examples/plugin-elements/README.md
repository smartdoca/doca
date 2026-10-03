# Countdown and news element plugin

This is a complete dependency-free prebuilt example. It uses the public Web bundle
contract in SDK 0.1.6 and host-injected React. It is not installed by default.

Copy the **contents** of this directory into an independent installation directory
`<DOCA_PLUGINS_DIR>/example.elements/` while the host is stopped, then restart.
Alternatively ZIP package.json, manifest.json, server.js and web/ at the archive
root and upload through Admin → Plugins. Do not configure discovery from this
repository or import host source paths. It also works as an npm tgz for the store.

In a rich-text document, place the cursor and choose **Plugin elements**. In a
spreadsheet, select one cell and choose the same entry. The sheet operation
replaces the entire cell. Use the element settings control (rich text) or select
the cell and reopen the entry (sheet) to configure/remove it. Native undo restores
the previous contents. Countdown uses an absolute ISO timestamp; ticking only
repaints. News cards retain the supplied title and HTTP(S) URL, without fetching
news or credentials.

The package declares `doca.storage: "host"`; the host stores content and permissions. Disable/uninstall removes renderers and
leaves document payloads intact as error placeholders. No plugin business database
is created. Unknown versions are not converted. See
[the element contract](../../docs/plugin-editor-elements.md).
