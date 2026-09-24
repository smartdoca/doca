import { useEffect, useRef } from "react";
import { hasMailHtml, wrapEmailDocument } from "@web/features/mail/mail-html.js";

export function MailHtmlView({ html, text }: { html?: string; text?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const rich = hasMailHtml(html);

  useEffect(() => {
    if (!rich) return;
    const node = frame.current;
    if (!node) return;
    const resize = () => {
      const doc = node.contentDocument;
      if (!doc) return;
      node.style.height = `${Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 80)}px`;
    };
    node.addEventListener("load", resize);
    const timer = window.setTimeout(resize, 50);
    return () => {
      node.removeEventListener("load", resize);
      window.clearTimeout(timer);
    };
  }, [html, rich]);

  if (!rich) return <div className="mail-body is-plain">{text || "（无正文）"}</div>;
  return (
    <iframe
      ref={frame}
      className="mail-html-frame"
      title="邮件正文"
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      srcDoc={wrapEmailDocument(html!)}
    />
  );
}
