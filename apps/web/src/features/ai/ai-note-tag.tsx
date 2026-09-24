import { useEffect, useState } from "react";
import { Button, Popover } from "antd";
import { FileText, Paperclip } from "lucide-react";
import type { QuickNoteReference } from "@web/features/ai/ai-context.js";
import { api, assetUrl } from "@web/shared/api.js";
import { QuickNoteBody } from "@web/features/quick-notes/quick-note-editor.js";
import {
  inlineNoteAssets,
  noteHasText,
  type NoteContent,
} from "@core/shared/quick-notes.js";
const stamp = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function NoteCardPreview({ note }: { note: QuickNoteReference }) {
  const outside = note.attachments.filter(
    (a) => !inlineNoteAssets(note.content).includes(a.id),
  );
  return (
    <article className="note-card ai-note-preview" aria-label={`${note.label}预览`}>
      <header>
        <time dateTime={note.createdAt}>{stamp(note.createdAt)}</time>
      </header>
      <div className="note-card-content expanded">
        <QuickNoteBody content={note.content} />
        {!noteHasText(note.content) && !outside.length && (
          <p className="ai-note-preview-text">（无文字内容）</p>
        )}
        {!!outside.length && (
          <div className="note-assets">
            {outside.map((a) => (
              <div
                key={a.id}
                className={a.mime.startsWith("image/") ? "note-image" : "note-file"}
              >
                {a.mime.startsWith("image/") ? (
                  <a
                    href={assetUrl(a.id)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`查看图片 ${a.filename}`}
                  >
                    <img loading="lazy" src={assetUrl(a.id)} alt={a.filename} />
                  </a>
                ) : (
                  <a href={assetUrl(a.id) + "?download=1"}>
                    <Paperclip size={16} />
                    <span>
                      {a.filename}
                      <small>
                        {a.size < 1024 * 1024
                          ? `${Math.ceil(a.size / 1024)} KB`
                          : `${(a.size / 1024 / 1024).toFixed(1)} MB`}
                      </small>
                    </span>
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
function FetchedNotePreview({ id, label }: { id: string; label: string }) {
  const [note, setNote] = useState<QuickNoteReference | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    api<{ content: NoteContent; assets: QuickNoteReference["attachments"]; created_at: string }>(
      `/quick-notes/${id}`,
    )
      .then(
        (n) =>
          !gone &&
          setNote({
            id,
            label,
            content: n.content,
            attachments: n.assets,
            createdAt: n.created_at,
          }),
      )
      .catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
    };
  }, [id, label]);
  if (error) return <p className="ai-note-preview-text">加载失败：{error}</p>;
  if (!note) return <p className="ai-note-preview-text">加载中…</p>;
  return <NoteCardPreview note={note} />;
}
export function QuickNoteTag({
  label,
  note,
  noteId,
}: {
  label: string;
  note?: QuickNoteReference;
  noteId?: string;
}) {
  const button = (
    <Button
      type="text"
      size="small"
      className="ai-inline-reference ai-inline-reference-document ai-inline-note"
      title={note || noteId ? `预览${label}` : label}
      aria-label={note || noteId ? `预览${label}` : label}
      onMouseDown={(e) => e.preventDefault()}
    >
      <FileText size={12} />@{label}
    </Button>
  );
  // 标记里带 id 时可按 id 拉取笔记内容；内存中还有引用数据时直接渲染。
  return note || noteId ? (
    <Popover
      trigger="click"
      placement="top"
      destroyOnHidden
      styles={{ container: { borderRadius: 12, padding: 0 } }}
      content={
        note ? (
          <NoteCardPreview note={note} />
        ) : (
          <FetchedNotePreview id={noteId!} label={label} />
        )
      }
    >
      {button}
    </Popover>
  ) : (
    button
  );
}
