import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Button, Popover, Spin } from "antd";
import { FileText, Quote, ArrowUpRight } from "lucide-react";
import type { AIReference } from "@core/workflows/ai-documents.js";
import { api } from "@web/shared/api.js";
import type { SurfacePreviewData } from "@web/features/documents/surface-preview.js";
const RichPreview = lazy(() => import("@web/features/documents/version-preview.js"));
const MarkdownPreview = lazy(() => import("@web/features/documents/markdown-preview.js"));
const SurfacePreview = lazy(() => import("@web/features/documents/surface-preview.js"));
const formats: Record<string, string> = {
  rich_text: "文档",
  markdown: "Markdown",
  spreadsheet: "表格",
  canvas: "画板",
  presentation: "演示",
};
const compact = (s: string, max: number) =>
  s.replace(/\s+/g, " ").trim().slice(0, max) + (s.length > max ? "…" : "");
export function referenceLabel(ref: AIReference) {
  const title = compact(ref.label ?? "未命名文档", 28);
  return ref.anchor
    ? `${title} · ${compact(ref.anchor.quote || ref.description || "选中内容", 24)}`
    : `${formats[ref.format ?? ""] ?? "文档"} · ${title}`;
}
function ReferencePreview({
  reference,
  reveal,
}: {
  reference: AIReference;
  reveal: () => void;
}) {
  const [data, setData] = useState<{
    resource: { title: string };
    value?: any;
    markdown?: string;
    surface?: SurfacePreviewData;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<NonNullable<typeof data>>(
      `/ai/resources/${reference.resourceId}/preview`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [reference.resourceId]);
  return (
    <section className="ai-reference-preview" aria-label="引用文档预览">
      <header>
        <strong>{data?.resource.title ?? reference.label}</strong>
        <Button type="text" size="small" onClick={reveal}>
          打开文档
          <ArrowUpRight size={14} />
        </Button>
      </header>
      <div className="ai-reference-preview-content">
        {error ? (
          <Alert type="error" title={error} />
        ) : !data ? (
          <Spin />
        ) : (
          <Suspense fallback={<Spin />}>
            {typeof data.markdown === "string" ? (
              <MarkdownPreview value={data.markdown} />
            ) : data.value ? (
              <RichPreview value={data.value} />
            ) : data.surface ? (
              <SurfacePreview
                id={reference.resourceId}
                surface={data.surface}
              />
            ) : null}
          </Suspense>
        )}
      </div>
    </section>
  );
}
export function AIReferenceTag({
  reference,
  reveal,
}: {
  reference: AIReference;
  reveal: () => void;
}) {
  const region = !!reference.anchor;
  const label = referenceLabel(reference);
  const button = (
    <Button
      type="text"
      size="small"
      className={`ai-inline-reference ai-inline-reference-${region ? "region" : "document"}`}
      title={
        region
          ? `定位内容：${reference.anchor.quote || reference.description || reference.label}`
          : `预览文档：${reference.label}`
      }
      aria-label={`${region ? "定位内容" : "预览文档"}：${label}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={region ? reveal : undefined}
    >
      {region ? <Quote size={12} /> : <FileText size={12} />}@{label}
    </Button>
  );
  return region ? (
    button
  ) : (
    <Popover
      trigger="click"
      placement="top"
      destroyOnHidden
      styles={{ container: { borderRadius: 12, padding: 0 } }}
      content={<ReferencePreview reference={reference} reveal={reveal} />}
    >
      {button}
    </Popover>
  );
}
