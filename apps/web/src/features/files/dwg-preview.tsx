import { useEffect, useRef, useState } from "react";
import type { PreviewSource } from "./open-file-viewer-preview.js";

const workerBase = "/cad/";
const dwgParserUrl = `${workerBase}libredwg-parser-worker.js`;
const mtextRenderUrl = `${workerBase}mtext-renderer-worker.js`;

type CadManager = {
  closeDocument: () => Promise<boolean>;
  openDocument: (
    fileName: string,
    content: ArrayBuffer,
    options: {
      drawNoPlotLayers?: boolean;
      progressiveRendering?: boolean;
      waitForTextGeometry?: boolean;
    },
  ) => Promise<boolean>;
};

let viewerReady: Promise<CadManager> | null = null;
let openChain: Promise<unknown> = Promise.resolve();
let openedKey = "";
const stage = typeof document === "undefined" ? null : document.createElement("div");
const hosts: HTMLElement[] = [];

if (stage) {
  stage.className = "dwg-preview-stage";
}

function parkStage(host: HTMLElement) {
  if (!stage) return;
  if (!hosts.includes(host)) hosts.push(host);
  host.replaceChildren(stage);
}

function releaseStage(host: HTMLElement) {
  const index = hosts.lastIndexOf(host);
  if (index >= 0) hosts.splice(index, 1);
  const next = hosts.at(-1);
  if (next && stage && next !== stage.parentElement) next.replaceChildren(stage);
}

async function ensureViewer() {
  if (!stage) throw new Error("图纸预览只能在浏览器里打开");
  if (!viewerReady) {
    viewerReady = (async () => {
      const [{ AcApDocManager }, dataModel, converter] = await Promise.all([
        import("@mlightcad/cad-simple-viewer"),
        import("@mlightcad/data-model"),
        import("@mlightcad/libredwg-converter"),
      ]);
      const converters = dataModel.AcDbDatabaseConverterManager.instance;
      if (!converters.get(dataModel.AcDbFileType.DWG)) {
        converters.register(
          dataModel.AcDbFileType.DWG,
          new converter.AcDbLibreDwgConverter({
            parserWorkerUrl: dwgParserUrl,
          }),
        );
      }
      const workers = { dwgParser: dwgParserUrl, mtextRender: mtextRenderUrl };
      if (!(await AcApDocManager.checkWebworkerReadiness(workers))) {
        throw new Error("图纸解析组件没有加载出来");
      }
      const manager = AcApDocManager.createInstance({
        container: stage,
        autoResize: true,
        baseUrl: "https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/",
        webworkerFileUrls: workers,
        builtinOpenFileDialog: false,
        notificationCenter: false,
        useMainThreadDraw: true,
      }) ?? AcApDocManager.tryGetInstance();
      if (!manager) throw new Error("图纸预览没有初始化");
      return manager;
    })().catch((error) => {
      viewerReady = null;
      throw error;
    });
  }
  return viewerReady;
}

function openDrawing(key: string, name: string, content: ArrayBuffer) {
  const run = openChain.then(async () => {
    if (openedKey === key) return;
    const manager = await ensureViewer();
    if (openedKey) {
      openedKey = "";
      await manager.closeDocument();
    }
    const opened = await manager.openDocument(name, content, {
      drawNoPlotLayers: false,
      progressiveRendering: true,
      waitForTextGeometry: false,
    });
    if (!opened) throw new Error("这份 DWG 暂时无法预览");
    openedKey = key;
  });
  openChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function DwgFilePreview({ file }: { file: PreviewSource }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const controller = new AbortController();
    parkStage(host);
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(file.url, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("文件内容读取失败");
        const content = await response.arrayBuffer();
        if (cancelled) return;
        await openDrawing(file.url, file.name, content);
        if (!cancelled) setLoading(false);
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "图纸预览失败");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      releaseStage(host);
    };
  }, [file.name, file.url]);

  return (
    <div className="dwg-preview">
      <div ref={hostRef} className="dwg-preview-host" />
      {loading || error ? (
        <div className="file-preview-empty dwg-preview-status">
          {error ? (
            <>
              <strong>图纸预览失败</strong>
              <span>{error}</span>
              <a className="primary file-preview-download" href={file.url.includes("?") ? `${file.url}&download=1` : `${file.url}?download=1`}>下载文件</a>
            </>
          ) : (
            <span>正在打开图纸…</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
