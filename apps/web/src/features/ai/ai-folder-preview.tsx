import { Alert, Empty, Modal, Spin } from "antd";
import { File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { api, fileUrl } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { fileLocationError } from "@web/shared/utils/system-labels.js";

type FolderItem = {
  id: string;
  name: string;
  type: "folder" | "document" | "system";
};
type Page = {
  folders: FolderItem[];
  files: { id: string; name: string; size: number }[];
};

export function AIFolderPreview({
  folder,
  close,
}: {
  folder: { id: string; name?: string };
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const [trail, setTrail] = useState<FolderItem[]>([
    { ...folder, name: folder.name || t("trash.folder"), type: /^(ai-session:|knowledge-session:|knowledge-assistant:)/.test(folder.id) ? "system" : "folder" },
  ]);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const current = trail[trail.length - 1]!;
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError("");
    void api<Page>(
      `/files?parentType=${current.type}&parentId=${encodeURIComponent(current.id)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(fileLocationError(e.message, t));
      });
    return () => controller.abort();
  }, [current.id, current.type]);
  return (
    <Modal
      open
      title={folder.name || t("trash.folder")}
      footer={null}
      onCancel={close}
    >
      <nav className="ai-folder-preview-trail">
        {trail.map((item, index) => (
          <button
            type="button"
            key={item.id}
            onClick={() => setTrail((items) => items.slice(0, index + 1))}
          >
            {index > 0 && " / "}
            {item.name}
          </button>
        ))}
      </nav>
      {error ? (
        <Alert type="error" title={error} />
      ) : !page ? (
        <Spin />
      ) : (
        <div className="ai-folder-preview-items">
          {!page.folders.length && !page.files.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("fileManager.emptyPicker")}
            />
          )}
          {page.folders.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => setTrail((items) => [...items, item])}
            >
              <Folder size={18} />
              <span>{item.name}</span>
            </button>
          ))}
          {page.files.map((item) => (
            <a
              key={item.id}
              href={fileUrl(item.id)}
              target="_blank"
              rel="noreferrer"
            >
              <File size={18} />
              <span>{item.name}</span>
              <small>
                {(item.size / 1024).toLocaleString(locale, {
                  maximumFractionDigits: 1,
                })}{" "}
                KB
              </small>
            </a>
          ))}
        </div>
      )}
    </Modal>
  );
}
