import { useEffect, useState, type ReactElement } from "react";
import { useI18n } from "@web/shared/i18n.js";
import { MarkdownPreview } from "@smartdoca/markdown";
import type { FileItem } from "@web/shared/api.js";
import { fileUrl } from "@web/shared/api.js";
import { isDwgFile } from "./dwg-file.js";
import { DwgFilePreview } from "./dwg-preview.js";
import "@smartdoca/markdown/style.css";
import "@web/features/documents/markdown.css";

export type PreviewSource = {
  url: string;
  name: string;
  mime: string;
};

type Viewer = {
  FileViewer: (props: Record<string, unknown>) => ReactElement;
  plugins: unknown[];
};

const asSource = (file: FileItem | PreviewSource): PreviewSource =>
  "preview_url" in file
    ? { url: fileUrl(file.id), name: file.name, mime: file.mime }
    : file;

const isMarkdown = (file: PreviewSource) =>
  file.mime === "text/markdown" || /\.md(?:own)?$/i.test(file.name);

function MarkdownFilePreview({ file }: { file: PreviewSource }) {
  const { t, locale } = useI18n();
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<"source" | "rendered">("source");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setSource("");
    setError("");
    void fetch(file.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("文件内容读取失败");
        setSource(await response.text());
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "文件内容读取失败");
      });
    return () => controller.abort();
  }, [file.url]);
  return (
    <div className="file-markdown-preview">
      <div className="file-markdown-toolbar" role="toolbar" aria-label="Markdown 展示方式">
        <button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>源码</button>
        <button className={mode === "rendered" ? "active" : ""} onClick={() => setMode("rendered")}>{t("doc.mode.read")}</button>
      </div>
      <div className={`file-markdown-body ${mode === "source" ? "source" : "rendered"}`}>
        {error ? <div className="file-preview-empty"><strong>预览加载失败</strong><span>{error}</span></div> : !source ? <div className="file-preview-empty"><span>正在加载文件…</span></div> : mode === "source" ? <pre>{source}</pre> : <div className="doca-markdown markdown-preview-only"><MarkdownPreview locale={locale} value={source} resolveImageUrl={() => ""} /></div>}
      </div>
    </div>
  );
}

function GenericFilePreview({ file }: { file: PreviewSource }) {
const { t } = useI18n();

  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Language files expect a global Prism object. Production ESM chunks
        // still need the Vite rewrite; this assignment covers runtime checks.
        const prismModule = await import("prismjs");
        (globalThis as { Prism?: unknown }).Prism = prismModule.default ?? prismModule;
        const [{ FileViewer }, core, worker] = await Promise.all([
          import("@open-file-viewer/react"),
          import("@open-file-viewer/core"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        if (cancelled) return;
        setViewer({
          FileViewer: FileViewer as Viewer["FileViewer"],
          plugins: [
            core.imagePlugin(), core.textPlugin(), core.pdfPlugin({ workerSrc: worker.default }), core.officePlugin(),
            core.videoPlugin(), core.audioPlugin(), core.archivePlugin(), core.emailPlugin(),
          ],
        });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "预览组件加载失败");
      }
    })();
    return () => { cancelled = true; };
  }, []);
  if (file.mime.startsWith("image/")) {
    return <img className="file-preview-image file-preview-image-direct" src={file.url} alt={file.name} />;
  }
  if (error) return <div className="file-preview-empty"><strong>预览加载失败</strong><span>{error}</span><a className="primary file-preview-download" href={file.url.includes("?") ? `${file.url}&download=1` : `${file.url}?download=1`}>下载文件</a></div>;
  if (!viewer) return <div className="file-preview-empty"><span>{t("trash.loadingPreview")}</span></div>;
  const Component = viewer.FileViewer;
  return <Component file={file.url} fileName={file.name} mimeType={file.mime} width="100%" height="100%" fit="contain" toolbar={false} plugins={viewer.plugins} fallback="download" />;
}

export function OpenFileViewerPreview({ file }: { file: FileItem | PreviewSource }) {
  const source = asSource(file);
  if (isDwgFile(source.name, source.mime)) return <DwgFilePreview file={source} />;
  if (isMarkdown(source)) return <MarkdownFilePreview file={source} />;
  if (source.mime.startsWith("image/")) {
    return <img className="file-preview-image file-preview-image-direct" src={source.url} alt={source.name} />;
  }
  return <GenericFilePreview file={source} />;
}
