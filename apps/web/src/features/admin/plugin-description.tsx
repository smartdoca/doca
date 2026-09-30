import { createElement, Fragment, type ReactNode } from "react";
import { useI18n } from "@web/shared/i18n.js";
export function PluginDescription({
  description,
}: {
  description: { format: string; version: number; nodes: unknown[] };
}) {
  const { t } = useI18n();
  let count = 0,
    characters = 0,
    unsupported = false;
  const render = (value: unknown, depth = 0): ReactNode => {
    if (++count > 5000 || depth > 16 || !value || typeof value !== "object") {
      unsupported = true;
      return null;
    }
    const n = value as Record<string, unknown>;
    if (typeof n.text === "string") {
      characters += n.text.length;
      if (characters > 200000) {
        unsupported = true;
        return null;
      }
      let text: ReactNode = n.text;
      for (const [mark, tag] of [
        ["bold", "strong"],
        ["italic", "em"],
        ["underline", "u"],
        ["strikethrough", "s"],
        ["code", "code"],
      ] as const)
        if (n[mark] === true) text = createElement(tag, {}, text);
      return text;
    }
    const children = Array.isArray(n.children)
      ? n.children.map((x, i) => (
          <Fragment key={i}>
            {render(x, depth + 1)}
          </Fragment>
        ))
      : null;
    switch (n.type) {
      case "paragraph":
        return <p>{children}</p>;
      case "heading":
        return createElement(
          `h${Math.min(6, Math.max(1, Number(n.level) || 2))}`,
          {},
          children,
        );
      case "blockquote":
        return <blockquote>{children}</blockquote>;
      case "bulleted-list":
        return <ul>{children}</ul>;
      case "numbered-list":
        return <ol>{children}</ol>;
      case "list-item":
        return <li>{children}</li>;
      case "code-block":
        return (
          <pre>
            <code>{children}</code>
          </pre>
        );
      case "divider":
        return <hr />;
      case "link":
        if (
          typeof n.url === "string" &&
          /^(https?:\/\/|mailto:)/.test(n.url) &&
          !/[\x00-\x20]/.test(n.url)
        )
          return (
            <a href={n.url} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        break;
      case "image":
        if (
          typeof n.src === "string" &&
          n.src.length < 350000 &&
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
            n.src,
          )
        )
          return (
            <img
              src={n.src}
              alt={typeof n.alt === "string" ? n.alt : ""}
              style={{ maxWidth: "100%" }}
            />
          );
        break;
    }
    unsupported = true;
    return children;
  };
  if (description.format !== "doca-slate" || description.version !== 1)
    return <p>{t("plugins.contentUnsupported")}</p>;
  const content = description.nodes.map((n, i) => (
    <div key={i}>{render(n)}</div>
  ));
  return (
    <div className="plugin-rich-description">
      {content}
      {unsupported && <p>{t("plugins.contentUnsupported")}</p>}
    </div>
  );
}
