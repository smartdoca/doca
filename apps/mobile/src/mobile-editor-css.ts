export const mobileEditorCss = `
html, body { width: 100% !important; max-width: 100% !important; overflow-x: hidden !important; }
.app-shell.mobile-editor-shell > .workspace { padding-top: 12px !important; }
.editor-columns, .editor-columns.with-comments, .compact-document .editor-columns {
  display: block !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; padding: 8px 0 0 !important;
}
.editor-content, .sk-page-shell, .sk-editor, .sk-page, [data-slate-editor="true"] {
  width: 100% !important; max-width: 100% !important; min-width: 0 !important; box-sizing: border-box !important;
}
.sk-page { margin: 0 !important; padding: 20px 16px 72px !important; border: 0 !important; box-shadow: none !important; }
[data-slate-editor="true"], [data-slate-editor="true"] * {
  max-width: 100%; overflow-wrap: anywhere !important; word-break: break-word !important; white-space: pre-wrap !important;
}
.sk-columns { display: flex !important; flex-direction: column !important; width: 100% !important; }
.sk-column { width: 100% !important; max-width: 100% !important; }
.sk-code, .sk-code-body, .markdown-body pre, .cm-scroller {
  max-width: 100% !important; overflow-x: auto !important;
}
[data-slate-editor="true"] .sk-code, [data-slate-editor="true"] .sk-code *,
.sk-code, .sk-code *, .sk-code-body, .sk-code-body pre, .markdown-body pre, .cm-scroller, .cm-scroller * {
  white-space: pre !important; overflow-wrap: normal !important; word-break: normal !important;
}
.sk-code *, .cm-scroller * { max-width: none !important; }
.sk-table-block, .sk-table-scroll {
  display: block; width: 100% !important; max-width: 100% !important; min-width: 0 !important; margin-left: 0 !important;
  padding-left: 0 !important; overflow-x: auto !important; overflow-y: hidden !important;
}
.sk-table-block table { width: max-content !important; min-width: 100% !important; max-width: none !important; table-layout: auto !important; }
.sk-table-block td, .sk-table-block th {
  min-width: 112px !important; max-width: 240px !important; vertical-align: top !important;
  white-space: pre-wrap !important; overflow-wrap: anywhere !important; word-break: break-word !important;
}
.sk-table-block td *, .sk-table-block th * {
  white-space: pre-wrap !important; overflow-wrap: anywhere !important; word-break: break-word !important; max-width: 100% !important;
}
.sk-table-block .sk-code, .sk-table-block .sk-code * {
  white-space: pre !important; overflow-wrap: normal !important; word-break: normal !important; max-width: none !important;
}
.sk-page img, .markdown-body img { max-width: 100% !important; height: auto !important; }
.sk-table-block td img, .sk-table-block th img, .sk-table-block td video, .sk-table-block th video, .sk-table-block td svg, .sk-table-block th svg {
  display: block !important; width: auto !important; max-width: 200px !important; height: auto !important;
}
.sk-block-gutter, .sk-block-menu, .sk-floating, .document-scroll-buttons, .document-outline,
.outline-floating-toggle, .outline-drawer-host, .content-comments, .note-float, .note-float-pill {
  display: none !important;
}
`;

export const mobileEditorScript = `
(function () {
  var style = document.getElementById("doca-mobile-editor");
  if (!style) {
    style = document.createElement("style");
    style.id = "doca-mobile-editor";
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = ${JSON.stringify(mobileEditorCss)};
  document.documentElement.dataset.editorShell = "mobile";
})();
true;
`;
