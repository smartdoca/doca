const ALLOWED = new Set([
  "A", "ABBR", "B", "BLOCKQUOTE", "BR", "CAPTION", "CENTER", "CITE", "CODE", "COL", "COLGROUP",
  "DD", "DIV", "DL", "DT", "EM", "FONT", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "I", "IMG",
  "LI", "OL", "P", "PRE", "S", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "U", "UL", "STYLE",
]);

export function hasMailHtml(html?: string) {
  return !!html && /<[a-z][\s\S]*>/i.test(html);
}

export function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function sanitizeMailHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of [...doc.body.querySelectorAll("*")]) {
      if (!ALLOWED.has(node.tagName)) {
        node.replaceWith(...node.childNodes);
        changed = true;
      }
    }
  }
  for (const node of [...doc.body.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "xlink:href") {
        node.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src" || name === "poster") && /^(javascript|vbscript|data):/i.test(value) && !/^data:image\//i.test(value)) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG" && !node.getAttribute("src")) node.remove();
  }
  return doc.body.innerHTML;
}

export function wrapEmailDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>
html,body{margin:0;padding:0;background:transparent}
body{color:#202124;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
img,video{max-width:100%;height:auto}
table{max-width:100%;border-collapse:collapse}
blockquote{margin:8px 0;padding:0 0 0 12px;border-left:3px solid #dadce0;color:#5f6368}
pre,code{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:#1a73e8}
hr{border:0;border-top:1px solid #e8eaed}
</style></head><body>${sanitizeMailHtml(html)}</body></html>`;
}

export function textToHtml(text: string) {
  return `<p>${escapeText(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

export function quoteOriginal(message: { html?: string; text?: string; from: { name?: string; email: string }; subject: string }) {
  const inner = hasMailHtml(message.html) ? sanitizeMailHtml(message.html!) : textToHtml(message.text || "");
  return `<p></p><blockquote><p>----- 原始邮件 -----<br>发件人：${escapeText(message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email)}<br>主题：${escapeText(message.subject)}</p>${inner}</blockquote>`;
}
