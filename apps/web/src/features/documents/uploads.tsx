import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Upload, Paperclip, Download, FolderOpen, X } from "lucide-react";
import { api, assetUrl, uploadFile, roleRank, type FileItem, type Resource } from "@web/shared/api.js";
import { Dialog } from "@web/features/documents/dialogs.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";

export function CoverDialog({
  resource,
  close,
  saved,
}: {
  resource: Resource;
  close: () => void;
  saved: () => void;
}) {
const { t } = useI18n();

  const [assetId, setAssetId] = useState(resource.cover_asset_id ?? null),
    [busy, setBusy] = useState(false),
    [picking, setPicking] = useState<boolean | "materials">(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [error, setError] = useState("");
  const localInput = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      title={t("library.coverTitle")}
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="cover-preview">
        {assetId ? (
          <img src={assetUrl(assetId)} alt={t("library.coverPreview")} />
        ) : (
          <>
            <ImagePlus size={36} />
            <p>{t("library.coverEmpty")}</p>
          </>
        )}
      </div>
      <div className="inline">
        <button className="upload-control" disabled={busy} onClick={() => setSourceOpen(true)}><ImagePlus size={15} /><span>{t("library.chooseCover")}</span></button>
        <label className="upload-control" hidden>
          <ImagePlus size={16} />
          <span>{busy ? t("library.working") : t("library.chooseCover")}</span>
          <input
            ref={localInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              setError("");
              try {
                setAssetId((await uploadFile(file, "cover", resource.id)).id);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {assetId && (
          <button disabled={busy} onClick={() => setAssetId(null)}>
            <X size={15} />
            {t("library.removeCover")}
          </button>
        )}
      </div>
      <p className="subtle">{t("library.coverHelp")}</p>
      {error && (
        <Feedback message={error} tone="error" />
      )}
      {picking && <FolderFilePicker initialSource={picking === "materials" ? "materials" : "folders"} accept={(file) => file.mime.startsWith("image/")} close={() => setPicking(false)} select={async (file: FileItem) => { const response = await fetch(`/api/v1/files/items/${file.id}/content`); if (!response.ok) throw new Error(t("library.coverReadFailed")); const selected = new File([await response.blob()], file.name, { type: file.mime }); setAssetId((await uploadFile(selected, "cover", resource.id)).id); }} />}
      {sourceOpen && <FileSourceDialog title={t("library.chooseCover")} close={() => setSourceOpen(false)} chooseDoca={source => setPicking(source ?? true)} chooseLocal={() => localInput.current?.click()} />}
      <footer>
        <button disabled={busy} onClick={close}>{t("common.cancel")}</button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api(`/resources/${resource.id}/cover`, "PUT", {
                version: resource.version,
                assetId,
              });
              saved();
              close();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("library.saveCover")}
        </button>
      </footer>
    </Dialog>
  );
}

export function ResourceActionDialog({
  resource,
  action,
  close,
  saved,
}: {
  resource: Resource;
  action: "rename" | "trash" | "restore";
  close: () => void;
  saved: () => void;
}) {
const { t } = useI18n();

  const [title, setTitle] = useState(resource.title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label =
    action === "rename"
      ? t("shell.rename")
      : action === "trash"
        ? t("library.moveToTrash")
        : t("library.restoreContent");
  return (
    <Dialog
      title={label}
      close={() => {
        if (!busy) close();
      }}
      className="modal-compact"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(
              `/resources/${resource.id}${action === "rename" ? "" : "/" + action}`,
              action === "rename" ? "PATCH" : "POST",
              {
                version: resource.version,
                ...(action === "rename" ? { title: title.trim() } : {}),
              },
            );
            saved();
            close();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {action === "rename" ? (
          <label>
            {resource.kind === "library"
              ? t("library.libraryName")
              : t("library.documentName")}
            <input
              autoFocus
              required
              maxLength={160}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </label>
        ) : (
          <p>
            {action === "trash"
              ? t("library.confirmTrash", { title: resource.title })
              : t("library.confirmRestore", { title: resource.title })}
          </p>
        )}
        {error && (
          <Feedback message={error} tone="error" />
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>{t("common.cancel")}</button>
          <button
            disabled={busy || !title.trim()}
            className={action === "trash" ? "danger" : "primary"}
          >
            {busy ? t("library.working") : label}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

type Asset = { id: string; filename: string; mime: string; size: number };
export function Attachments({ resource }: { resource: Resource }) {
const { t } = useI18n();

  const [items, setItems] = useState<Asset[]>([]),
    [busy, setBusy] = useState(false),
    [picking, setPicking] = useState<boolean | "materials">(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [error, setError] = useState("");
  const localInput = useRef<HTMLInputElement>(null);
  async function load() {
    setItems(
      (await api<{ items: Asset[] }>(`/resources/${resource.id}/assets`)).items,
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [resource.id]);
  return <>
    <section className="attachment-panel">
      <div className="inline">
        <h3>
          <Paperclip size={17} />
          文件与图片
        </h3>
        <div className="grow" />
        {roleRank(resource.role) >= 3 && (
          <button className="upload-control" disabled={busy} onClick={() => setSourceOpen(true)}><Upload size={15} /><span>{t("toolbar.addAttachment")}</span></button>
        )}
        {roleRank(resource.role) >= 3 && (
          <label className="upload-control" hidden>
            <Upload size={15} />
            <span>{busy ? "上传中…" : "上传附件"}</span>
            <input
              ref={localInput}
              type="file"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                setError("");
                try {
                  await uploadFile(file, "attachment", resource.id);
                  await load();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        )}
      </div>
      <p className="subtle">
        单个文件最大
        20MB，访问权限随本文档。也可以使用正文编辑器的插入菜单添加图片。
      </p>
      {error && (
        <Feedback message={error} tone="error" />
      )}
      {!items.length ? (
        <p className="subtle">暂无附件</p>
      ) : (
        items.map((item) => (
          <a
            className="attachment-row"
            key={item.id}
            href={assetUrl(item.id)}
            target="_blank"
            rel="noreferrer"
          >
            {item.mime === "image/webp" ? (
              <img src={assetUrl(item.id)} alt="" />
            ) : (
              <Paperclip size={20} />
            )}
            <span>
              {item.filename}
              <small>{(item.size / 1024).toFixed(1)} KB</small>
            </span>
            <Download size={17} />
          </a>
        ))
      )}
    </section>
    {picking && <FolderFilePicker initialSource={picking === "materials" ? "materials" : "folders"} close={() => setPicking(false)} select={async (file: FileItem) => { setBusy(true); try { await api(`/files/items/${file.id}/attach`, "POST", { purpose: "attachment", resourceId: resource.id }); await load(); } finally { setBusy(false); } }} />}
    {sourceOpen && <FileSourceDialog title={t("toolbar.addAttachment")} close={() => setSourceOpen(false)} chooseDoca={source => setPicking(source ?? true)} chooseLocal={() => localInput.current?.click()} />}
  </>;
}
