import { useEffect, useRef, useState } from "react";
import { Link2, Unlink } from "lucide-react";
import { Editor, Range, Transforms, type RangeRef } from "slate";
import type { RichTextEditorHandle } from "slatetsx-kit-editor";
import { internalDocumentId } from "@web/features/documents/document-link.js";
import { api, type Detail } from "@web/shared/api.js";
export function DocumentLinkControl({
  handle,
  disabled,
}: {
  handle: RichTextEditorHandle | null;
  disabled: boolean;
}) {
  const range = useRef<RangeRef | null>(null),
    menu = useRef<HTMLDetailsElement>(null);
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(
    () => () => {
      range.current?.unref();
    },
    [],
  );
  return (
    <details
      ref={menu}
      className="menu"
      onToggle={(e) => {
        if (!e.currentTarget.open) {
          range.current?.unref();
          range.current = null;
        }
      }}
    >
      <summary
        aria-label="设置超链接"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          if (!menu.current || disabled) return;
          if (!menu.current.open) {
            range.current?.unref();
            range.current = handle?.editor.selection
              ? Editor.rangeRef(handle.editor, handle.editor.selection)
              : null;
            const link =
              handle &&
              Editor.above(handle.editor, {
                match: (n) => "type" in n && n.type === "link",
              });
            setUrl(link && "url" in link[0] ? String(link[0].url) : "");
          }
          menu.current.open = !menu.current.open;
        }}
      >
        <Link2 size={16} />
      </summary>
      <form
        className="toolbar-link-form"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!handle || disabled) return;
          const href = url.trim(),
            id = internalDocumentId(href, location.origin);
          if (!id && !/^(https?:\/\/|mailto:)[^\s]+$/i.test(href)) {
            setError("请输入 HTTP(S)、邮箱或本站文档链接");
            return;
          }
          let label: string | undefined;
          if (id) {
            try {
              const d = await api<Detail>(`/resources/${id}`);
              if (d.resource.kind !== "document")
                throw new Error("请选择文档链接");
              label = d.resource.title;
            } catch (e) {
              setError((e as Error).message);
              return;
            }
          }
          if (!range.current?.current) {
            setError("选区已变化，请重新选择插入位置");
            return;
          }
          Transforms.select(handle.editor, range.current.current);
          if (id) {
            Editor.withoutNormalizing(handle.editor, () => {
              if (
                handle.editor.selection &&
                Range.isExpanded(handle.editor.selection)
              )
                Transforms.delete(handle.editor);
              Transforms.insertNodes(handle.editor, {
                id: crypto.randomUUID(),
                type: "custom:document-reference",
                documentId: id,
                label: label ?? "文档链接",
                children: [{ text: "" }],
              });
              Transforms.move(handle.editor);
            });
          } else handle.commands.insertLink(href, label);
          range.current?.unref();
          range.current = null;
          if (menu.current) menu.current.open = false;
          setError("");
          setUrl("");
        }}
      >
        <input
          aria-label="超链接地址"
          placeholder="输入链接地址"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="primary" disabled={disabled}>
          应用
        </button>
        <button
          type="button"
          disabled={disabled}
          title="移除超链接"
          aria-label="移除超链接"
          onClick={() => {
            if (range.current?.current && handle)
              Transforms.select(handle.editor, range.current.current);
            handle?.commands.removeLink();
            if (menu.current) menu.current.open = false;
          }}
        >
          <Unlink size={16} />
        </button>
        {error && <small role="alert">{error}</small>}
      </form>
    </details>
  );
}
