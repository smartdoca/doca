import { useState } from "react";
import { ArrowUpRight, Download, File } from "lucide-react";
import type { FileDelivery } from "@core/modules/ai/progress.js";
import { fileUrl } from "@web/shared/api.js";

function previewSrc(file: FileDelivery) {
  if (!file.mime?.startsWith("image/")) return "";
  const raw = file.downloadUrl || fileUrl(file.id);
  const [path, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  params.delete("download");
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}

function fileSubtitle(file: FileDelivery) {
  const path = file.path?.trim();
  if (path?.includes("/")) return path.slice(0, path.lastIndexOf("/")).trim();
  if (file.local) return "可下载到本机";
  if (file.mime?.startsWith("image/")) return "图片";
  return "文件";
}

export function FileDeliveryCard({
  file,
  onOpen,
}: {
  file: FileDelivery;
  onOpen?: (href: string) => void;
}) {
  const downloadHref = file.downloadUrl || fileUrl(file.id, true);
  const open = file.href && onOpen ? () => onOpen(file.href!) : undefined;
  const preview = previewSrc(file);
  const [previewFailed, setPreviewFailed] = useState(false);
  const body = (
    <>
      {preview && !previewFailed ? (
        <img
          className="ai-file-card-thumb"
          src={preview}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <span className="ai-document-card-icon">
          <File size={18} />
        </span>
      )}
      <span className="ai-document-card-copy">
        <small>{fileSubtitle(file)}</small>
        <span className="ai-document-card-title">{file.name}</span>
      </span>
    </>
  );
  return (
    <div className={`ai-document-card ai-file-card${open ? " is-openable" : ""}`}>
      {open ? (
        <button
          type="button"
          className="ai-file-card-main"
          aria-label={`打开文件：${file.name}`}
          onClick={open}
        >
          {body}
        </button>
      ) : (
        <div className="ai-file-card-main">{body}</div>
      )}
      <span className="ai-file-card-actions">
        <a
          className="ai-file-card-download"
          href={downloadHref}
          download={file.name}
          aria-label={`下载文件：${file.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Download size={15} />
        </a>
        {open ? (
          <button
            type="button"
            className="ai-file-card-open"
            aria-label={`打开文件位置：${file.name}`}
            onClick={open}
          >
            <ArrowUpRight size={16} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
