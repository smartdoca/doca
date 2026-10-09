import { createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { RichTextEditor, type EditorValue, type EditorPlugin } from "@smartdoca/slate";
import { YjsDocument, createYjsAdapter } from "@smartdoca/slate/yjs";
import { createTableBlock } from "@smartdoca/slate/headless";
import { renderKatex } from "@smartdoca/slate/katex";
import { MarkdownPreview } from "@smartdoca/markdown";
import { useRichTextPdfProjection } from "../../apps/web/src/features/documents/rich-text-pdf.js";
import { exportMarkdownPdf, capturePdfView } from "../../apps/web/src/features/documents/rendered-pdf.js";
import { importEditablePdf } from "../../apps/web/src/features/documents/pdf-import.js";
import "@smartdoca/slate/style.css";
import "@smartdoca/markdown/style.css";
import "katex/dist/katex.min.css";
import "../../apps/web/src/features/documents/editor.css";
import "../../apps/web/src/features/documents/markdown.css";

const assetId = "10000000-0000-4000-8000-000000000001";
const resources = { resolveUrl: () => `/api/v1/assets/${assetId}/content` };
const HostContext = createContext("missing-host-context");
function HostLabel() {
  const host = useContext(HostContext);
  if (host !== "retained-host-context") throw Error("PDF projection lost the host context");
  return <span>Host context retained</span>;
}
const plugins: EditorPlugin[] = [{ key: "pdf-qa-context", renderElement: props => props.element.type === "custom:pdf-qa" ? <span {...props.attributes}><HostLabel />{props.children}</span> : undefined }];
const formulaRenderer = renderKatex;
const table = createTableBlock(35, 3);
table.children.forEach((row, r) => row.children.forEach((cell, c) => {
  cell.children = [{ text: `Row ${r} / ${c}`, bold: r === 0, ...(r === 0 ? { color: "#245bdb" } : {}) }];
}));
const value: EditorValue = [
  { id: "title", type: "paragraph", title: "h1", align: "center", children: [{ text: "中文 PDF 样式验收", color: "#245bdb" }] },
  { id: "body", type: "paragraph", children: [{ text: "Editable text " }, { text: "bold", bold: true }, { text: " italic", italic: true }, { text: " color", color: "#d13b37", backgroundColor: "#ffeeaa", fontSize: 22 }] },
  { id: "todo", type: "paragraph", list: "checkbox", checked: true, children: [{ text: "Completed item" }] },
  { id: "formula", type: "formula", source: "E = mc^2 + \\frac{1}{2}", children: [{ text: "" }] },
  { id: "image", type: "image", path: assetId, alt: "Local image", width: 200, children: [{ text: "" }] },
  { id: "host", type: "custom:pdf-qa", children: [{ text: "" }] },
  { id: "attachment", type: "attachment", name: "Readable attachment.pdf", path: assetId, children: [{ text: "" }] },
  { id: "code", type: "code-block", language: "javascript", code: "const answer = 42;\nconsole.log(answer);", children: [{ text: "" }] },
  table,
  { id: "end", type: "paragraph", children: [{ text: "Last row remains visible" }] },
];
const doc = new Y.Doc(), runtime = new YjsDocument(doc);
runtime.initialize(value);
const collaboration = createYjsAdapter(runtime);
let updates = 0;
doc.on("update", () => updates++);
const markdown = `# Markdown 中文验收\n\n**Bold** and *italic*.\n\n| Name | Value |\n| --- | --- |\n| First | 42 |\n\n![Local image](${assetId})\n\n$$E=mc^2$$\n\n\`\`\`mermaid\ngraph LR\n A[Start] --> B[Finish]\n\`\`\`\n\nLast Markdown paragraph`;
function Fixture() {
  const pdf = useRichTextPdfProjection({ resources, plugins, locale: "en", formulaRenderer });
  (window as any).pdfQA = {
    exportRich: async () => {
      const before = JSON.stringify(runtime.getValue()), count = updates;
      const result = await pdf.exportPdf(runtime.getValue(), "pdf-qa", "rich", 794);
      return { bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())), unchanged: before === JSON.stringify(runtime.getValue()) && count === updates };
    },
    exportMarkdown: async () => Array.from(new Uint8Array(await (await exportMarkdownPdf(markdown, "pdf-qa", "markdown", "en")).blob.arrayBuffer())),
    captureMarkdown: () => capturePdfView(document.querySelector<HTMLElement>("#markdown .markdown-body")!),
    importPdf: (bytes: number[]) => importEditablePdf(new File([new Uint8Array(bytes)], "isolated.pdf")),
  };
  return <>
    {pdf.view}
    <div id="rich" className="document-editor-shell" style={{ width: 794 }}><div className="editor-content"><RichTextEditor mode="readonly" collaboration={collaboration} plugins={plugins} resources={resources} locale="en" formulaRenderer={formulaRenderer} /></div></div>
    <div id="markdown" className="doca-markdown" style={{ width: 794 }}><div className="exmd-editor"><MarkdownPreview value={markdown} locale="en" resolveImageUrl={resources.resolveUrl} /></div></div>
  </>;
}
const fixtureRoot = ((window as any).pdfFixtureRoot ??= createRoot(document.getElementById("root")!));
fixtureRoot.render(<HostContext.Provider value="retained-host-context"><Fixture /></HostContext.Provider>);
