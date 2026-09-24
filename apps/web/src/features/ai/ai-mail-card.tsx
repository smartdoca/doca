import { ArrowUpRight, Mail, SquarePen } from "lucide-react";
import type { MailComposeDraft, MailDelivery } from "@core/modules/ai/progress.js";

export function MailDeliveryCard({
  mail,
  onOpen,
}: {
  mail: MailDelivery;
  onOpen?: (href: string) => void;
}) {
  const label = `打开邮件：${mail.subject || "（无主题）"}`;
  const body = (
    <>
      <span className="ai-document-card-icon">
        <Mail size={18} />
      </span>
      <span className="ai-document-card-copy">
        <small>{mail.from || "邮件"}</small>
        <span className="ai-document-card-title">{mail.subject || "（无主题）"}</span>
      </span>
      <span className="ai-document-card-format">邮件</span>
      <ArrowUpRight className="ai-document-card-arrow" size={16} />
    </>
  );
  if (!onOpen) {
    return (
      <a className="ai-document-card ai-mail-card" href={mail.href} aria-label={label}>
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="ai-document-card ai-mail-card"
      aria-label={label}
      title={mail.snippet || undefined}
      onClick={() => onOpen(mail.href)}
    >
      {body}
    </button>
  );
}

export function MailComposeCard({
  draft,
  onOpen,
}: {
  draft: MailComposeDraft;
  onOpen: () => void;
}) {
  const title = draft.subject.trim() || "未发送的邮件";
  return (
    <button
      type="button"
      className="ai-document-card ai-mail-card"
      aria-label={`打开写邮件：${title}`}
      onClick={onOpen}
    >
      <span className="ai-document-card-icon">
        <SquarePen size={18} />
      </span>
      <span className="ai-document-card-copy">
        <small>{draft.to.trim() || "待填写收件人"}</small>
        <span className="ai-document-card-title">{title}</span>
      </span>
      <span className="ai-document-card-format">写邮件</span>
      <ArrowUpRight className="ai-document-card-arrow" size={16} />
    </button>
  );
}
