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
  const [assetId, setAssetId] = useState(resource.cover_asset_id ?? null),
    [busy, setBusy] = useState(false),
    [picking, setPicking] = useState(false),
    [sourceOpen, setSourceOpen] = useState(false),
    [error, setError] = useState("");
  const localInput = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      title="知识库封面"
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="cover-preview">
        {assetId ? (
          <img src={assetUrl(assetId)} alt="封面预览" />
        ) : (
          <>
            <ImagePlus size={36} />
            <p>上传一张封面，让知识库更易辨认</p>
          </>
        )}
      </div>
      <div className="inline">
        <button className="upload-control" disabled={busy} onClick={() => setSourceOpen(true)}><ImagePlus size={15} /><span>选择封面图片</span></button>
        <label className="upload-control" hidden>
          <ImagePlus size={16} />
          <span>{busy ? "处理中…" : "选择封面图片"}</span>
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
            移除封面
          </button>
        )}
      </div>
      <p className="subtle">
        最大 5MB，支持 PNG、JPEG、WebP、GIF；图片自动压缩，封面居中裁切展示。
      </p>
      {error && (
        <Feedback message={error} tone="error" />
      )}
      {picking && <FolderFilePicker accept={(file) => file.mime.startsWith("image/")} close={() => setPicking(false)} select={async (file: FileItem) => { const response = await fetch(`/api/v1/files/items/${file.id}/content`); if (!response.ok) throw new Error("图片读取失败"); const selected = new File([await response.blob()], file.name, { type: file.mime }); setAssetId((await uploadFile(selected, "cover", resource.id)).id); }} />}
      {sourceOpen && <FileSourceDialog title="选择封面图片" close={() => setSourceOpen(false)} chooseDoca={() => setPicking(true)} chooseLocal={() => localInput.current?.click()} />}
      <footer>
        <button disabled={busy} onClick={close}>
          取消
        </button>
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
          保存封面
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
  const [title, setTitle] = useState(resource.title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label =
    action === "rename"
      ? "重命名"
      : action === "trash"
        ? "移入回收站"
        : "恢复内容";
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
            {resource.kind === "library" ? "知识库名称" : "文档名称"}
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
            确认{action === "trash" ? "将" : "恢复"}「{resource.title}」
            {action === "trash"
              ? "及其子文档移入回收站？内容可在回收站恢复。"
              : "？"}
          </p>
        )}
        {error && (
          <Feedback message={error} tone="error" />
        )}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            disabled={busy || !title.trim()}
            className={action === "trash" ? "danger" : "primary"}
          >
            {busy ? "处理中…" : label}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

type Asset = { id: string; filename: string; mime: string; size: number };
export function Attachments({ resource }: { resource: Resource }) {
  const [items, setItems] = useState<Asset[]>([]),
    [busy, setBusy] = useState(false),
    [picking, setPicking] = useState(false),
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
          <button className="upload-control" disabled={busy} onClick={() => setSourceOpen(true)}><Upload size={15} /><span>添加附件</span></button>
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
    {picking && <FolderFilePicker close={() => setPicking(false)} select={async (file: FileItem) => { setBusy(true); try { await api(`/files/items/${file.id}/attach`, "POST", { purpose: "attachment", resourceId: resource.id }); await load(); } finally { setBusy(false); } }} />}
    {sourceOpen && <FileSourceDialog title="添加附件" close={() => setSourceOpen(false)} chooseDoca={() => setPicking(true)} chooseLocal={() => localInput.current?.click()} />}
  </>;
}
