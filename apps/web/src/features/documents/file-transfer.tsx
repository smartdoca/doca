import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { DocumentSubmenu } from "@web/features/documents/document-submenu.js";
import {
  api,
  assetUrl,
  MAX_ASSET_UPLOAD_BYTES,
  uploadFile,
  type Resource,
  type UploadProgress,
} from "@web/shared/api.js";
import { notifyFeedback } from "@web/shared/components/feedback.js";
import { useI18n } from "@web/shared/i18n.js";
import "@web/features/documents/document-download.css";

export const importFormats = {
  presentation: {
    label: "在线演示文稿",
    accept: ".pptx",
    description:
      "PowerPoint（.pptx），最大 30 MB。支持基础文字、图形、表格和图片；复杂母版、动画等可能简化，不支持旧版 .ppt。",
  },
  rich_text: {
    label: "在线文档",
    accept: ".md,.markdown,.docx,.pdf",
    description:
      "Word（.docx）、Markdown 或 PDF；不支持旧版 .doc。复杂排版可能简化。",
  },
  spreadsheet: {
    label: "在线表格",
    accept: ".xlsx",
    description: "Excel 工作簿（.xlsx）；图片、图表等不支持的内容会给出提示。",
  },
  markdown: {
    label: "在线 Markdown",
    accept: ".md,.markdown,.pdf",
    description: "Markdown（.md / .markdown）或 PDF（转为 Markdown）",
  },
  canvas: {
    label: "在线画板",
    accept: ".png,.jpg,.jpeg,.webp,.svg",
    description:
      "PNG / JPEG / WebP / SVG，作为图片素材创建画板，不恢复原生图层。",
  },
} as const;
export async function readImport(format: Resource["format"], file: File) {
  if (format === "markdown") {
    const { importMarkdownFile } = await import("@smartdoca/markdown");
    const result = await importMarkdownFile(file);
    if (!result.ok) throw Error(result.error.message);
    reportWarnings(result.warnings);
    return { markdown: result.markdown };
  }
  if (format === "spreadsheet") {
    if (!/\.xlsx$/i.test(file.name)) throw Error("请选择 .xlsx 文件");
    const { importSpreadsheetXlsx } = await import(
      "@web/features/documents/spreadsheet-xlsx.js"
    );
    const result = await importSpreadsheetXlsx(file, crypto.randomUUID());
    reportWarnings(result.warnings);
    return { initialContent: result.snapshot };
  }
  throw Error("此格式需要通过素材导入流程创建");
}
export function reportWarnings(warnings: { message: string }[] = []) {
  if (warnings.length)
    notifyFeedback(
      [...new Set(warnings.map((w) => w.message))].slice(0, 5).join("；"),
      "warning",
    );
}
export async function readAsset(
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!/^[a-f0-9-]{36}$/i.test(path)) throw Error("无效的资源标识");
  const response = await fetch(assetUrl(path) + "?download=1", { signal });
  if (!response.ok) throw Error("资源读取失败或无下载权限");
  return response.blob();
}

export function embeddedImage(path: string): Blob | null {
  const match = path.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

export async function preparePdfImage(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png" || blob.type === "image/jpeg") return blob;
  if (!blob.type.startsWith("image/")) throw Error("资源不是图片");
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const maxPixels = 16_000_000;
    const scale = Math.min(
      1,
      Math.sqrt(maxPixels / Math.max(1, image.naturalWidth * image.naturalHeight)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("无法创建图片画布");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw Error("图片转换失败");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function downloadResult(result: {
  blob: Blob;
  filename?: string;
  fileName?: string;
  warnings?: { message: string }[];
}) {
  reportWarnings(result.warnings);
  const url = URL.createObjectURL(result.blob),
    a = document.createElement("a");
  a.href = url;
  a.download = (result.filename || result.fileName || "document").replace(
    /[\\/:*?"<>|]/g,
    "_",
  );
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ImportProgress = {
  phase: "parsing" | "preparing" | "uploading" | "finalizing";
  message: string;
  current?: number;
  total?: number;
  percent?: number;
};
type ImportProgressHandler = (progress: ImportProgress) => void;

function reportProgress(
  onProgress: ImportProgressHandler | undefined,
  update: ImportProgress,
) {
  onProgress?.(update);
}

async function prepareImportAsset(file: File): Promise<File> {
  if (file.size <= MAX_ASSET_UPLOAD_BYTES) return file;
  if (!file.type.startsWith("image/"))
    throw Error(`导入素材“${file.name}”超过 20MB，无法上传`);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const maxPixels = 16_000_000;
    const pixels = image.naturalWidth * image.naturalHeight;
    const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, pixels)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("无法准备 PDF 图片素材");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.86;
    let blob: Blob | null = null;
    while (quality >= 0.42) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob && blob.size <= MAX_ASSET_UPLOAD_BYTES) break;
      quality -= 0.1;
    }
    if (!blob || blob.size > MAX_ASSET_UPLOAD_BYTES)
      throw Error(`导入素材“${file.name}”压缩后仍超过 20MB`);
    return new File(
      [blob],
      file.name.replace(/\.[^.]+$/u, "") + ".jpg",
      { type: "image/jpeg" },
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareImportAssets(
  pending: { key: string; file: File }[],
  onProgress: ImportProgressHandler | undefined,
) {
  for (let index = 0; index < pending.length; index++) {
    reportProgress(onProgress, {
      phase: "preparing",
      message: `正在整理素材 ${index + 1}/${pending.length}`,
      current: index + 1,
      total: pending.length,
      percent: Math.round(((index + 1) / pending.length) * 100),
    });
    pending[index]!.file = await prepareImportAsset(pending[index]!.file);
  }
}

async function uploadImportAssets(
  pending: { key: string; file: File }[],
  resourceId: string,
  onProgress: ImportProgressHandler | undefined,
  signal?: AbortSignal,
) {
  const mapping = new Map<string, string>();
  const totalBytes = pending.reduce((sum, item) => sum + item.file.size, 0);
  let completedBytes = 0;
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]!;
    const reportUpload = (upload: UploadProgress) => {
      const loaded = completedBytes + upload.loaded;
      reportProgress(onProgress, {
        phase: "uploading",
        message: `正在上传素材 ${index + 1}/${pending.length}`,
        current: index + 1,
        total: pending.length,
        percent: totalBytes
          ? Math.min(100, Math.round((loaded / totalBytes) * 100))
          : 100,
      });
    };
    const uploaded = await uploadFile(
      item.file,
      "attachment",
      resourceId,
      signal,
      reportUpload,
    );
    mapping.set(item.key, uploaded.id);
    completedBytes += item.file.size;
  }
  return mapping;
}

export async function createImportedDocument(
  input: Record<string, unknown> & { format: Resource["format"] },
  file: File,
  onProgress?: ImportProgressHandler,
  signal?: AbortSignal,
): Promise<Resource> {
  reportProgress(onProgress, { phase: "parsing", message: "正在读取文件…" });
  if (
    (input.format === "markdown" && !/\.pdf$/i.test(file.name)) ||
    input.format === "spreadsheet"
  ) {
    reportProgress(onProgress, { phase: "parsing", message: "正在解析文件…" });
    const imported = await readImport(input.format, file);
    reportProgress(onProgress, { phase: "finalizing", message: "正在创建文档…" });
    return api("/resources", "POST", {
      ...input,
      ...imported,
    });
  }
  const pending: { key: string; file: File }[] = [];
  let value: unknown;
  if (input.format === "presentation") {
    reportProgress(onProgress, {
      phase: "parsing",
      message: "正在解析演示文稿…",
    });
    const { importPptx, validatePptxFile } = await import("@smartdoca/slides/pptx");
    validatePptxFile(file);
    const result = await importPptx(await file.arrayBuffer());
    value = { ...result.document, assets: {} };
    for (const asset of result.assets)
      pending.push({
        key: asset.id,
        file: new File([new Uint8Array(asset.bytes)], asset.name, {
          type: asset.mime,
        }),
      });
    reportWarnings(result.warnings);
  } else if (input.format === "rich_text") {
    if (/\.pdf$/i.test(file.name)) {
      reportProgress(onProgress, {
        phase: "parsing",
        message: "正在识别 PDF 内容…",
      });
      const { importPdfFile } = await import("@smartdoca/markdown");
      const pdf = await importPdfFile(file, { signal });
      reportProgress(onProgress, {
        phase: "preparing",
        message: "正在整理 PDF 结构…",
      });
      const pathMap = new Map<string, string>();
      for (const [index, resource] of pdf.resources.entries()) {
        const key = `pdf-pending-resource-${index}-${crypto.randomUUID()}`;
        pathMap.set(resource.key, key);
        pending.push({
          key,
          file: new File([new Uint8Array(resource.bytes)], resource.filename, {
            type: resource.mimeType,
          }),
        });
      }
      const { importDocument } = await import("@smartdoca/slate/conversion");
      const { createEditorDocument } =
        await import("@smartdoca/slate/headless");
      const result = await importDocument(pdf.markdown, {
        filename: file.name.replace(/\.pdf$/i, ".md"),
        signal: signal ?? new AbortController().signal,
        resources: {
          signal: signal ?? new AbortController().signal,
          importResource: async (r) => {
            const key = r.path ? pathMap.get(r.path) : undefined;
            if (!key) throw Error("PDF 图片资源未找到");
            return { path: key };
          },
        },
      });
      value = createEditorDocument(result.initialValue);
      reportWarnings([...pdf.warnings, ...result.warnings]);
    } else {
      reportProgress(onProgress, {
        phase: "parsing",
        message: "正在解析文档内容…",
      });
      if (!/\.(docx|md|markdown)$/i.test(file.name))
        throw Error("请选择 .docx、Markdown 或 PDF 文件");
      const { importDocument } = await import("@smartdoca/slate/conversion");
      const { createEditorDocument } =
        await import("@smartdoca/slate/headless");
      const result = await importDocument(file, {
        filename: file.name,
        resources: {
          signal: signal ?? new AbortController().signal,
          importResource: async (r) => {
            if (!r.bytes) throw Error("外部图片未自动下载，保留可读占位");
            const key = crypto.randomUUID();
            pending.push({
              key,
              file: new File([new Uint8Array(r.bytes)], r.filename, {
                type: r.mimeType,
              }),
            });
            return { path: key };
          },
        },
      });
      value = createEditorDocument(result.initialValue);
      reportWarnings(result.warnings);
    }
  } else if (input.format === "canvas") {
    const { parseCanvasFile, createCanvasImportValue } =
      await import("@smartdoca/canvas/io");
    const result = await parseCanvasFile(file),
      map: Record<string, string> = {};
    for (const r of result.resources) {
      const key = crypto.randomUUID();
      map[r.id] = key;
      let blob = r.blob,
        filename = result.filename;
      if (r.mimeType === "image/svg+xml") {
        // The asset service deliberately serves no active SVG. Rasterize only the
        // SDK-sanitized image, then use the existing safe image upload pipeline.
        const url = URL.createObjectURL(blob);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = r.width;
          canvas.height = r.height;
          canvas.getContext("2d")!.drawImage(image, 0, 0);
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(Error("SVG 素材转换失败"))),
              "image/png",
            ),
          );
          filename = filename.replace(/\.svg$/i, ".png");
          reportWarnings([
            { message: "SVG 已作为图片素材导入，不保留原生矢量图层。" },
          ]);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      pending.push({
        key,
        file: new File([blob], filename, { type: blob.type }),
      });
    }
    value = createCanvasImportValue(result, map);
    reportWarnings(result.warnings);
  } else if (!(input.format === "markdown" && /\.pdf$/i.test(file.name)))
    throw Error("暂不支持此类型导入");
  if (input.format === "markdown" && /\.pdf$/i.test(file.name)) {
    reportProgress(onProgress, {
      phase: "parsing",
      message: "正在识别 PDF 内容…",
    });
    const { importPdfFile } = await import("@smartdoca/markdown");
    const pdf = await importPdfFile(file, { signal });
    reportWarnings(pdf.warnings);
    if (!pdf.resources.length) {
      reportProgress(onProgress, { phase: "finalizing", message: "正在创建文档…" });
      return api("/resources", "POST", { ...input, markdown: pdf.markdown });
    }
    for (const asset of pdf.resources)
      pending.push({
        key: asset.key,
        file: new File([new Uint8Array(asset.bytes)], asset.filename, {
          type: asset.mimeType,
        }),
      });
    reportProgress(onProgress, {
      phase: "preparing",
      message: "正在整理 PDF 素材…",
    });
    try {
      await prepareImportAssets(pending, onProgress);
    } catch (error) {
      throw Error(`导入失败，PDF 素材无法准备：${(error as Error).message}`);
    }
    reportProgress(onProgress, { phase: "finalizing", message: "正在创建文档…" });
    const resource = await api<Resource>("/resources", "POST", input);
    try {
      const mapping = await uploadImportAssets(
        pending,
        resource.id,
        onProgress,
        signal,
      );
      let markdown = pdf.markdown;
      for (const [from, to] of mapping) markdown = markdown.split(from).join(to);
      reportProgress(onProgress, {
        phase: "finalizing",
        message: "正在完成文档导入…",
      });
      return await api<Resource>(
        `/resources/${resource.id}/import-markdown-initial`,
        "POST",
        { markdown },
      );
    } catch (error) {
      throw Error(
        `导入未完成，已保留空文档和已上传素材，可在文档列表清理。${(error as Error).message}`,
      );
    }
  }
  if (!pending.length) {
    reportProgress(onProgress, { phase: "finalizing", message: "正在创建文档…" });
    return api("/resources", "POST", { ...input, initialContent: value });
  }
  // Assets require a resource ACL. This new resource may be initialized exactly once;
  // the server refuses if anybody opened/edited it while files were uploading.
  await prepareImportAssets(pending, onProgress);
  reportProgress(onProgress, { phase: "finalizing", message: "正在创建文档…" });
  const resource = await api<Resource>("/resources", "POST", input);
  try {
    const mapping = await uploadImportAssets(
      pending,
      resource.id,
      onProgress,
      signal,
    );
    const remap = (v: unknown): unknown =>
      typeof v === "string"
        ? (mapping.get(v) ?? v)
        : Array.isArray(v)
          ? v.map(remap)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, child]) => [k, remap(child)]),
              )
            : v;
    reportProgress(onProgress, {
      phase: "finalizing",
      message: "正在完成文档导入…",
    });
    return await api<Resource>(
      `/resources/${resource.id}/import-initial`,
      "POST",
      { initialContent: remap(value) },
    );
  } catch (error) {
    throw Error(
      `导入未完成，已保留空文档和已上传素材，可在文档列表清理。${(error as Error).message}`,
    );
  }
}
export function saveFile(
  title: string,
  suffix: string,
  body: BlobPart,
  type: string,
) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "未命名"}.${suffix}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function saveToPlatformFolder(blob: Blob, filename: string) {
  const response = await fetch(`/api/v1/files/items?parentType=system&parentId=root&filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? "保存到平台文件夹失败");
  }
}
export function DocumentDownload({
  options,
  disabled = false,
  onError,
}: {
  options: { label: string; run: () => void | Promise<void> }[];
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [slot, setSlot] = useState<HTMLElement | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => setSlot(document.getElementById("document-export-slot")), []);
  async function run(option: (typeof options)[number]) {
    setBusy(true);
    try {
      await option.run();
    } catch (e) {
      onError(e instanceof Error ? e.message : t("doc.downloadFailed"));
    } finally {
      setBusy(false);
    }
  }
  if (!slot) return null;
  return createPortal(
    options.length === 1 ? (
      <button
        className="document-download-item"
        disabled={disabled || busy}
        onClick={() => void run(options[0]!)}
      >
        <Download size={16} />
        {busy ? t("doc.downloading") : t("doc.download")}
      </button>
    ) : (
      <DocumentSubmenu
        label={t("doc.download")}
        panelLabel={t("doc.downloadFormat")}
        icon={<Download size={16} />}
      >
        {options.map((option) => (
          <button
            key={option.label}
            disabled={disabled || busy}
            onClick={() => void run(option)}
          >
            {option.label}
          </button>
        ))}
      </DocumentSubmenu>
    ),
    slot,
  );
}
