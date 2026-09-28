import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Editor, Element, Node, Point, Range, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import {
  createAtomicInlineExtension,
  type CustomElement,
  type EditorPlugin,
  type RichTextEditorHandle,
} from "@smartdoca/slate";
import { lookupUsers, mentionHandle, mentionLabel, type MentionUser } from "@web/features/comments/rich-comments.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { UserMention } from "@web/shared/components/user-mention.js";
export const mentionUrl = (id: string) => `#/u/${id}`;
import { mentionCodec } from "@core/modules/documents/codecs/rich-runtime.js";
export const mentionPlugin = createAtomicInlineExtension({
  ...mentionCodec,
  decode: (data, identity) =>
    mentionCodec.decode(data, identity) as CustomElement,
  render: (e) => (
    <UserMention
      id={String(e.userId)}
      name={String(e.label)}
      className="document-user-mention"
    />
  ),
}).plugin;
const mentionTextBefore = (editor: Editor, anchor: Point) => {
  const block = Editor.above(editor, {
    at: anchor,
    match: (n) => Element.isElement(n) && Editor.isBlock(editor, n),
  });
  const blockStart = block
    ? Editor.start(editor, block[1])
    : Editor.start(editor, []);
  const before = Editor.before(editor, anchor, {
    unit: "character",
    distance: 100,
  });
  const from =
    before && Point.compare(before, blockStart) > 0 ? before : blockStart;
  return Editor.string(editor, { anchor: from, focus: anchor });
};
export function DocumentMentions({
  handle,
  revision,
  enabled,
}: {
  handle: RichTextEditorHandle | null;
  revision: number;
  enabled: boolean;
}) {
const { t } = useI18n();

  const [target, setTarget] = useState<{
    range: Range;
    q: string;
    left: number;
    top: number;
  } | null>(null);
  const [users, setUsers] = useState<MentionUser[]>([]),
    [index, setIndex] = useState(0),
    [error, setError] = useState("");
  const suppressed = useRef("");
  useEffect(() => {
    const editor = handle?.editor,
      s = editor?.selection;
    if (
      !enabled ||
      !editor ||
      !s ||
      !Range.isCollapsed(s) ||
      ReactEditor.isComposing(editor)
    ) {
      setTarget(null);
      return;
    }
    try {
      const text = mentionTextBefore(editor, s.anchor);
      const match = /(?:^|[^\w@])@([^\s@]{0,60})$/.exec(text);
      const key = JSON.stringify(s) + text;
      if (!match) {
        suppressed.current = "";
        setTarget(null);
        return;
      }
      if (key === suppressed.current) {
        setTarget(null);
        return;
      }
      if (
        Editor.above(editor, {
          match: (n) => !Editor.isEditor(n) && "type" in n && n.type === "link",
        })
      ) {
        setTarget(null);
        return;
      }
      const start = Editor.before(editor, s.anchor, {
        unit: "character",
        distance: match[1]!.length + 1,
      });
      if (!start) {
        setTarget(null);
        return;
      }
      const range = { anchor: start, focus: s.anchor },
        r = ReactEditor.toDOMRange(editor, range).getBoundingClientRect();
      setTarget({
        range,
        q: match[1]!,
        left: Math.max(8, Math.min(r.left, innerWidth - 290)),
        top: Math.max(8, Math.min(r.bottom + 8, innerHeight - 300)),
      });
    } catch {
      setTarget(null);
    }
  }, [handle, revision, enabled]);
  useEffect(() => {
    setUsers([]);
    setIndex(0);
    setError("");
    if (!target) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      void lookupUsers(target.q, c.signal)
        .then(setUsers)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 180);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [target?.q, !!target]);
  const close = () => {
    suppressed.current = handle?.editor.selection
      ? JSON.stringify(handle.editor.selection) +
        mentionTextBefore(handle.editor, handle.editor.selection.anchor)
      : "";
    setTarget(null);
  };
  const insert = (u: MentionUser) => {
    if (!target || !handle || !enabled) return;
    const e = handle.editor;
    ReactEditor.focus(e);
    Transforms.select(e, target.range);
    const label = mentionLabel(u);
    Transforms.insertNodes(e, {
      id: crypto.randomUUID(),
      type: "custom:user-mention",
      userId: u.id,
      label,
      children: [{ text: "" }],
    });
    Transforms.move(e);
    e.insertText(" ");
    setTarget(null);
  };
  useEffect(() => {
    if (!target) return;
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setIndex(
          (i) =>
            (i + (e.key === "ArrowDown" ? 1 : -1) + Math.max(users.length, 1)) %
            Math.max(users.length, 1),
        );
      } else if ((e.key === "Enter" || e.key === "Tab") && users[index]) {
        e.preventDefault();
        e.stopPropagation();
        insert(users[index]!);
      }
    };
    const dismiss = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".document-mention-menu")) close();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [target, users, index]);
  return target
    ? createPortal(
        <div
          className="document-mention-menu"
          role="listbox"
          aria-label={t("comment.mention")}
          style={{ left: target.left, top: target.top }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {users.map((u, i) => {
            const label = mentionLabel(u),
              handleId = mentionHandle(u);
            return (
            <button
              role="option"
              aria-selected={i === index}
              key={u.id}
              className={i === index ? "selected" : ""}
              type="button"
              onClick={() => insert(u)}
            >
              <UserBadge id={u.id} name={label} avatarOnly passive />
              <span className="mention-option-name">{label}</span>
              {handleId && (
                <span className="mention-option-id">({handleId})</span>
              )}
            </button>
            );
          })}
          {!users.length && <p>{error || "没有可提及的用户"}</p>}
        </div>,
        document.body,
      )
    : null;
}
