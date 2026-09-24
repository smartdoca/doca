import { ArrowUp, Pencil, X } from "lucide-react";
import { Button } from "antd";
import {
  previewQuestion,
  type PendingSendItem,
} from "@web/features/ai/ai-session-ux.js";

export function AIPendingQueue({
  items,
  waiting,
  onEdit,
  onWithdraw,
  onBump,
}: {
  items: PendingSendItem[];
  waiting?: boolean;
  onEdit: (item: PendingSendItem) => void;
  onWithdraw: (id: string) => void;
  onBump: (item: PendingSendItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="ai-pending-list" aria-label="待发送">
      <div className="ai-pending-heading">
        待发送 {items.length} 条
        {waiting ? " · 回复结束后依次发出" : " · 即将发出"}
      </div>
      {items.map((item, index) => (
        <div className="ai-pending-item" key={item.id}>
          <span className="ai-pending-index">{index + 1}</span>
          <span className="ai-pending-text" title={item.text}>
            {previewQuestion(item.text, 72)}
            {!!item.attachments.length && (
              <em> · {item.attachments.length} 个附件</em>
            )}
          </span>
          <Button
            type="text"
            size="small"
            title={waiting ? "停止当前回复并立即发送" : "立即发送"}
            aria-label={waiting ? "停止当前回复并立即发送" : "立即发送"}
            onClick={() => onBump(item)}
          >
            <ArrowUp size={13} />
          </Button>
          <Button
            type="text"
            size="small"
            title="撤回修改"
            aria-label="撤回修改"
            onClick={() => onEdit(item)}
          >
            <Pencil size={13} />
          </Button>
          <Button
            type="text"
            size="small"
            title="撤回"
            aria-label="撤回"
            onClick={() => onWithdraw(item.id)}
          >
            <X size={13} />
          </Button>
        </div>
      ))}
    </div>
  );
}
