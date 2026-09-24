import { blankTemplateContent } from "@core/modules/templates/content.js";
import { templateFormatLabel } from "@web/features/documents/template-picker.js";
import { renderTemplatePreview } from "@web/features/documents/template-preview-image.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { api, type Resource } from "@web/shared/api.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

const TemplateSurface = lazy(() =>
  import("@web/features/documents/template-surfaces.js").then((mod) => ({
    default: mod.TemplateSurface,
  })),
);

type TemplateCard = {
  id: string;
  format: Resource["format"];
  title: string;
  preview: string;
  updated_at: string;
};
type Draft = {
  id?: string;
  format: Resource["format"];
  title: string;
  content: unknown;
};
const formats = Object.keys(templateFormatLabel) as Resource["format"][];

export function TemplateSettings() {
  const [format, setFormat] = useState<Resource["format"]>("rich_text");
  const [items, setItems] = useState<TemplateCard[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<TemplateCard | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(next = format) {
    setLoading(true);
    setError("");
    try {
      const page = await api<{ items: TemplateCard[] }>(`/templates?format=${next}`);
      setItems(page.items);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(format);
  }, [format]);
  async function open(item?: TemplateCard) {
    setError("");
    if (!item) {
      setDraft({
        format,
        title: "未命名模板",
        content: blankTemplateContent(format),
      });
      return;
    }
    try {
      const row = await api<Draft & { id: string }>(`/templates/${item.id}`);
      setDraft({ id: row.id, format: row.format, title: row.title, content: row.content });
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <>
      <div className="admin-section-heading">
        <div>
          <h2>文档模板</h2>
          <p>维护各类文档的模板。保存后，所有用户新建时都可以选用。</p>
        </div>
        <button className="primary" onClick={() => void open()}>
          <Plus size={16} />
          新建模板
        </button>
      </div>
      <div className="template-format-tabs" role="tablist" aria-label="模板类型">
        {formats.map((item) => (
          <button
            key={item}
            type="button"
            aria-current={format === item ? "true" : undefined}
            onClick={() => setFormat(item)}
          >
            {templateFormatLabel[item]}
          </button>
        ))}
      </div>
      {error && <Feedback message={error} tone="error" />}
      <section className="admin-card">
        {loading && <p>正在加载模板…</p>}
        {!loading && !items.length && <p>这个类型还没有模板。</p>}
        {!!items.length && (
          <div className="template-admin-list">
            {items.map((item) => (
              <article key={item.id}>
                {item.preview ? <img src={item.preview} alt="" /> : <span className="template-fallback" />}
                <div>
                  <strong>{item.title}</strong>
                  <small>{new Date(item.updated_at).toLocaleString()}</small>
                </div>
                <button type="button" onClick={() => void open(item)}>
                  编辑
                </button>
                <button type="button" className="danger" onClick={() => setRemoving(item)}>
                  删除
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {draft && (
        <TemplateEditor
          draft={draft}
          close={() => setDraft(null)}
          saved={() => {
            setDraft(null);
            void load();
          }}
        />
      )}
      {removing && (
        <Dialog title="删除模板" close={() => setRemoving(null)} className="modal-compact">
          <p>删除「{removing.title}」后，用户将不能再从它创建文档。已经创建的文档不会变化。</p>
          {error && <Feedback message={error} tone="error" />}
          <footer>
            <button type="button" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api(`/admin/templates/${removing.id}`, "DELETE")
                  .then(() => {
                    setRemoving(null);
                    return load();
                  })
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setBusy(false));
              }}
            >
              删除
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

function TemplateEditor({
  draft,
  close,
  saved,
}: {
  draft: Draft;
  close: () => void;
  saved: () => void;
}) {
  const reader = useRef<(() => Promise<unknown>) | null>(null);
  const [title, setTitle] = useState(draft.title);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = useCallback((read: () => Promise<unknown>) => {
    reader.current = read;
    setReady(true);
  }, []);
  return (
    <Dialog
      title={draft.id ? "编辑模板" : "新建模板"}
      close={close}
      className="template-editor-modal"
    >
      <label className="template-title-field">
        模板名称
        <input
          value={title}
          maxLength={160}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <p className="subtle">直接编辑后保存，不进入协同。</p>
      {error && <Feedback message={error} tone="error" />}
      <div className="template-editor-stage">
        <Suspense fallback={<p className="empty">正在加载编辑器…</p>}>
          <TemplateSurface format={draft.format} content={draft.content} onContent={accept} />
        </Suspense>
      </div>
      <footer>
        <button type="button" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !ready || !title.trim()}
          onClick={() => {
            setBusy(true);
            setError("");
            void (async () => {
              const content = await reader.current!();
              const preview = renderTemplatePreview(draft.format, content);
              const body = { title: title.trim(), content, preview };
              if (draft.id) await api(`/admin/templates/${draft.id}`, "PATCH", body);
              else
                await api("/admin/templates", "POST", { ...body, format: draft.format });
              saved();
            })().catch((reason: Error) => {
              setError(reason.message);
              setBusy(false);
            });
          }}
        >
          保存
        </button>
      </footer>
    </Dialog>
  );
}
