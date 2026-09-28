import { ArrowUpRight, Folder, Share2 } from "lucide-react";
import type { FolderDelivery } from "@core/modules/ai/progress.js";

export function FolderDeliveryCard({
  folder,
  onOpen,
}: {
  folder: FolderDelivery;
  onOpen: (href: string) => void;
}) {
  return (
    <button
      type="button"
      className={`ai-document-card ai-folder-card${folder.shared ? " ai-folder-card-shared" : ""}`}
      aria-label={`打开${folder.shared ? "共享文件夹" : "文件夹"}：${folder.name}`}
      onClick={() => onOpen(folder.href)}
    >
      <span className="ai-document-card-icon">
        {folder.shared ? <Share2 size={18} /> : <Folder size={18} />}
      </span>
      <span className="ai-document-card-copy">
        <small>{folder.shared ? "共享文件夹" : "文件夹"}</small>
        <span className="ai-document-card-title">{folder.name}</span>
      </span>
      <span className="ai-document-card-format">
        {folder.shared ? "共享" : "文件夹"}
      </span>
      <ArrowUpRight className="ai-document-card-arrow" size={16} />
    </button>
  );
}
