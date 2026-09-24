import { Feedback } from "@web/shared/components/feedback.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { api, type Resource } from "@web/shared/api.js";
import { lazy, Suspense, useEffect, useState } from "react";
import { Plus } from "lucide-react";

const TemplateSurface = lazy(() =>
  import("@web/features/documents/template-surfaces.js").then((mod) => ({
    default: mod.TemplateSurface,
  })),
);

export const templateFormatLabel: Record<Resource["format"], string> = {
  rich_text: "文档",
  spreadsheet: "表格",
  markdown: "Markdown",
  canvas: "无限画板",
  presentation: "演示文稿",
};

type TemplateCard = {
  id: string;
  format: Resource["format"];
  title: string;
  preview: string;
  updated_at: string;
};

export function TemplatePicker({
  format,
  parentId,
  libraryId,
  close,
  created,
}: {
  format: Resource["format"];
  parentId: string | null;
  libraryId: string | null;
  close: () => void;
  created: (resourceId: string) => void;
}) {
  const [items, setItems] = useState<TemplateCard[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TemplateCard | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: TemplateCard[] }>(
      `/templates?format=${format}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((page) => setItems(page.items))
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [format]);
  async function create(template?: TemplateCard) {
    setBusy(true);
    setError("");
    try {
      const resource = await api<Resource>("/resources", "POST", {
        kind: "document",
        format,
        title: template?.title || "未命名",
        parentId,
        libraryId,
        ...(template ? { templateId: template.id } : {}),
      });
      created(resource.id);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
    <Dialog
      title={`新建${templateFormatLabel[format]}`}
      close={close}
      className="modal-gallery"
    >
      {error && <Feedback message={error} tone="error" />}
      {items === null && !error && <p>正在加载模板…</p>}
      {items && (
        <div className="template-grid">
          <button
            type="button"
            className="template-blank"
            disabled={busy}
            onClick={() => void create()}
          >
            <Plus size={22} />
            <strong>空白</strong>
            <span>从空文档开始</span>
          </button>
          {items.map((item) => (
            <article className="template-card" key={item.id}>
              <strong title={item.title}>{item.title}</strong>
              <div className="template-card-cover">
                <TemplateCardCover item={item} />
                <div className="template-card-actions">
                  <button type="button" disabled={busy} onClick={() => setPreview(item)}>
                    预览
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void create(item)}
                  >
                    创建
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </Dialog>
    {preview && (
      <TemplatePreview
        card={preview}
        busy={busy}
        close={() => setPreview(null)}
        create={() => void create(preview)}
      />
    )}
    </>
  );
}

function TemplateCardCover({ item }: { item: TemplateCard }) {
  const [content, setContent] = useState<unknown>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    api<{ content: unknown }>(`/templates/${item.id}`, "GET", undefined, controller.signal)
      .then((row) => setContent(row.content))
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setContent(null);
      });
    return () => controller.abort();
  }, [item.id]);
  if (content)
    return (
      <div className="template-card-scale" data-format={item.format} aria-hidden="true">
        <Suspense fallback={<span className="template-fallback" />}>
          <TemplateSurface format={item.format} content={content} readOnly />
        </Suspense>
      </div>
    );
  if (item.preview) return <img src={item.preview} alt="" />;
  return <span className="template-fallback" />;
}

function TemplatePreview({
  card,
  busy,
  close,
  create,
}: {
  card: TemplateCard;
  busy: boolean;
  close: () => void;
  create: () => void;
}) {
  const [content, setContent] = useState<unknown>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<{ content: unknown }>(`/templates/${card.id}`, "GET", undefined, controller.signal)
      .then((row) => setContent(row.content))
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      });
    return () => controller.abort();
  }, [card.id]);
  return (
    <Dialog title={card.title} close={close} className="modal-preview">
      {error && <Feedback message={error} tone="error" />}
      {content === undefined && !error && <p>正在打开预览…</p>}
      {content !== undefined && (
        <div className="template-document-demo" data-format={card.format}>
          <Suspense fallback={<p>正在打开预览…</p>}>
            <TemplateSurface format={card.format} content={content} readOnly />
          </Suspense>
        </div>
      )}
      <footer>
        <button type="button" onClick={close}>
          返回
        </button>
        <button type="button" className="primary" disabled={busy} onClick={create}>
          创建
        </button>
      </footer>
    </Dialog>
  );
}

