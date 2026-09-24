import { Feedback } from "@web/shared/components/feedback.js";
import { composeComment } from "@web/features/comments/comment-body.js";
import { useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  FolderOpen,
  Send,
  X,
  Pencil,
  Reply,
  Check,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { api, assetUrl, uploadFile, type Comment, type FileItem, type User } from "@web/shared/api.js";
import { FileSourceDialog, FolderFilePicker } from "@web/features/files/files.js";
import type {
  CommentBody,
  CommentInline,
} from "@core/modules/interactions/community.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { Avatar } from "@web/features/account/profile.js";
import { relativeTime } from "@web/features/documents/document-experience.js";
import "@web/features/comments/rich-comments.css";
import { EmojiPicker } from "@web/shared/components/emoji-picker.js";
export type MentionUser = {
  id: string;
  display_name: string;
  public_id?: string;
  avatar?: string;
  avatar_asset_id?: string | null;
};
export const lookupUsers = async (q: string, signal?: AbortSignal) =>
  (
    await api<{ items: MentionUser[] }>(
      `/users/lookup?q=${encodeURIComponent(q)}`,
      "GET",
      undefined,
      signal,
    )
  ).items;
export const mentionLabel = (u: MentionUser) =>
  u.display_name?.trim() || u.public_id?.trim() || u.id;
export const mentionHandle = (u: MentionUser) => {
  const name = u.display_name?.trim(),
    id = u.public_id?.trim();
  return name && id && name !== id ? id : "";
};
export function parsedComment(
  c: Pick<Comment, "body" | "body_json">,
): CommentBody {
  try {
    const b = JSON.parse(c.body_json ?? "null");
    if (b?.version === 1 && Array.isArray(b.blocks)) return b;
  } catch {}
  return {
    version: 1,
    blocks: [{ type: "paragraph", children: [{ type: "text", text: c.body }] }],
  };
}
export function CommentContent({ comment }: { comment: Comment }) {
  if (comment.deleted_at) return <p className="subtle">评论已删除</p>;
  return (
    <div className="rich-comment-body">
      {parsedComment(comment).blocks.map((b, i) =>
        b.type === "image" ? (
          <a
            key={i}
            href={assetUrl(b.assetId)}
            target="_blank"
            rel="noreferrer"
          >
            <img
              src={assetUrl(b.assetId)}
              alt={b.alt || "评论图片"}
              loading="lazy"
            />
          </a>
        ) : (
          <p key={i}>
            {b.children.map((n, j) =>
              n.type === "text" ? (
                <span key={j}>{n.text}</span>
              ) : (
                <span
                  key={j}
                  className="comment-mention"
                  title={`@${n.publicId ?? n.userId}`}
                >
                  <UserBadge id={n.userId} name={n.label} noAvatar>
                    @{n.label}
                  </UserBadge>
                </span>
              ),
            )}
          </p>
        ),
      )}
    </div>
  );
}
export function CommentComposer({
  resourceId,
  initial,
  submit,
  close,
  disabled = false,
  autoFocus = false,
  replyTo,
}: {
  resourceId: string;
  initial?: CommentBody;
  submit: (body: CommentBody) => Promise<void>;
  close?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  replyTo?: Pick<Comment, "author_id" | "display_name">;
}) {
  const input = useRef<HTMLTextAreaElement>(null),
    file = useRef<HTMLInputElement>(null);
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const max = 320;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useEffect(() => {
    if (autoFocus) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const [text, setText] = useState(
    () =>
      initial?.blocks
        .filter((b) => b.type === "paragraph")
        .map((b) =>
          b.type === "paragraph"
            ? b.children
                .map((n) =>
                  n.type === "text" ? n.text : `@${n.publicId ?? n.userId}`,
                )
                .join("")
            : "",
        )
        .join("\n") ?? "",
  );
  useEffect(() => {
    grow(input.current);
  }, [text]);
  const [mentions, setMentions] = useState<
    Record<string, Extract<CommentInline, { type: "mention" }>>
  >(() =>
    Object.fromEntries(
      initial?.blocks.flatMap((b) =>
        b.type === "paragraph"
          ? b.children
              .filter((n) => n.type === "mention")
              .map((n) => [`@${n.publicId ?? n.userId}`, n])
          : [],
      ) ?? [],
    ),
  );
  const [images, setImages] = useState<
    Extract<CommentBody["blocks"][number], { type: "image" }>[]
  >(() => initial?.blocks.filter((b) => b.type === "image") ?? []);
  const [query, setQuery] = useState<{
      start: number;
      end: number;
      q: string;
    } | null>(null),
    [users, setUsers] = useState<MentionUser[]>([]),
    [index, setIndex] = useState(0),
    [folderPicker, setFolderPicker] = useState(false),
    [sourcePicker, setSourcePicker] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!replyTo || initial) return;
    let active = true;
    // Respect the same discovery policy as manual @ selection.
    void lookupUsers(replyTo.display_name)
      .then((items) => {
        const u = items.find((u) => u.id === replyTo.author_id);
        if (!active || !u) return;
        const token = `@${u.public_id ?? u.id}`;
        setText((current) => current || token + " ");
        setMentions({
          [token]: {
            type: "mention",
            userId: u.id,
            label: u.display_name,
            publicId: u.public_id ?? u.id,
          },
        });
        requestAnimationFrame(() =>
          input.current?.setSelectionRange(token.length + 1, token.length + 1),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [replyTo?.author_id]);
  useEffect(() => {
    setUsers([]);
    setIndex(0);
    if (!query) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      void lookupUsers(query.q, c.signal)
        .then(setUsers)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [query?.q]);
  function track(value: string, caret: number) {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setQuery(
      m ? { start: caret - m[1]!.length - 1, end: caret, q: m[1]! } : null,
    );
  }
  function choose(u: MentionUser) {
    if (!query) return;
    const token = `@${u.public_id ?? u.id}`;
    const next =
      text.slice(0, query.start) + token + " " + text.slice(query.end);
    setMentions((m) => ({
      ...m,
      [token]: {
        type: "mention",
        userId: u.id,
        label: u.display_name,
        publicId: u.public_id ?? u.id,
      },
    }));
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(
        query.start + token.length + 1,
        query.start + token.length + 1,
      );
    });
  }
  return (
    <form
      className="rich-comment-composer"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled || (!text.trim() && !images.length)) return;
        setBusy(true);
        setError("");
        try {
          await submit(composeComment(text, mentions, images));
          setText("");
          setImages([]);
          setMentions({});
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <textarea
        ref={input}
        aria-label="评论内容"
        placeholder="输入评论，@ 提及用户。Enter 换行，⌘ / Ctrl + Enter 发送"
        value={text}
        rows={3}
        maxLength={5000}
        disabled={busy || disabled}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
          track(
            e.target.value,
            e.target.selectionStart ?? e.target.value.length,
          );
        }}
        onClick={(e) =>
          track(text, e.currentTarget.selectionStart ?? text.length)
        }
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            if (e.key === "Enter") e.preventDefault();
            return;
          }
          if (e.key === "Escape") {
            setQuery(null);
            e.stopPropagation();
          }
          if (query && users.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex(
                (index + (e.key === "ArrowDown" ? 1 : users.length - 1)) %
                  users.length,
              );
            }
            if (e.key === "Enter") {
              e.preventDefault();
              choose(users[index]!);
              return;
            }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {query && (
        <div
          className="comment-candidates"
          role="listbox"
          aria-label="提及用户"
        >
          {users.length ? (
            users.map((u, i) => (
              <button
                type="button"
                role="option"
                aria-selected={index === i}
                key={u.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(u)}
              >
                <UserBadge id={u.id} name={u.display_name} avatarOnly />
                <span>
                  {u.display_name}
                  <small>@{u.public_id ?? u.id}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="subtle">没有可选择的用户</p>
          )}
        </div>
      )}
      <div className="comment-image-drafts">
        {images.map((im, i) => (
          <div key={im.assetId}>
            <img src={assetUrl(im.assetId)} alt={im.alt} />
            <button
              type="button"
              title="移除图片"
              aria-label="移除图片"
              onClick={() => setImages(images.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="composer-tools">
        <EmojiPicker
          disabled={busy || disabled}
          insert={(emoji) => {
            const at = input.current?.selectionStart ?? text.length;
            const end = input.current?.selectionEnd ?? at;
            setText(text.slice(0, at) + emoji + text.slice(end));
            setQuery(null);
            requestAnimationFrame(() => {
              input.current?.focus({ preventScroll: true });
              input.current?.setSelectionRange(
                at + emoji.length,
                at + emoji.length,
              );
            });
          }}
        />
        <button
          type="button"
          title="添加图片"
          aria-label="添加图片"
          disabled={busy || disabled || images.length >= 9}
          onClick={() => setSourcePicker(true)}
        >
          <ImagePlus size={17} />
        </button>
        <input
          ref={file}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBusy(true);
            setError("");
            try {
              const a = await uploadFile(f, "comment_image", resourceId);
              setImages((v) => [
                ...v,
                { type: "image", assetId: a.id, alt: a.filename },
              ]);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {folderPicker && <FolderFilePicker accept={(item) => item.mime.startsWith("image/")} close={() => setFolderPicker(false)} select={async (item: FileItem) => { const response = await fetch(`/api/v1/files/items/${item.id}/content`); if (!response.ok) throw new Error("图片读取失败"); const uploaded = await uploadFile(new File([await response.blob()], item.name, { type: item.mime }), "comment_image", resourceId); setImages((value) => [...value, { type: "image", assetId: uploaded.id, alt: uploaded.filename }]); }} />}
        {sourcePicker && <FileSourceDialog title="添加图片" close={() => setSourcePicker(false)} chooseDoca={() => setFolderPicker(true)} chooseLocal={() => file.current?.click()} />}
        <span className="grow" />
        {close && (
          <button
            type="button"
            title="关闭输入"
            aria-label="关闭输入"
            onClick={close}
          >
            <X size={17} />
          </button>
        )}
        <button
          className="send-comment"
          title="发送评论"
          aria-label="发送评论"
          disabled={busy || disabled || (!text.trim() && !images.length)}
        >
          <Send size={17} />
        </button>
      </div>
      {error && <Feedback message={error} tone="error" />}
    </form>
  );
}
export function CommentMessage({
  comment: c,
  user,
  rank,
  reply,
  edit,
  act,
}: {
  comment: Comment;
  user: User | null;
  rank: number;
  reply?: () => void;
  edit: () => void;
  act: (patch: object) => void;
}) {
  return (
    <div className="comment-message">
      <UserBadge id={c.author_id} name={c.display_name} avatarOnly />
      <div className="grow">
        <div className="comment-byline">
          <strong>{c.display_name}</strong>
          <time title={c.created_at}>{relativeTime(c.created_at)}</time>
          <span className="comment-icon-actions">
            {user && !c.deleted_at && rank >= 2 && (
              <>
                {reply && !c.resolved && (
                  <button title="回复" aria-label="回复" onClick={reply}>
                    <Reply size={15} />
                  </button>
                )}
                {c.author_id === user.id && (
                  <button title="编辑评论" aria-label="编辑评论" onClick={edit}>
                    <Pencil size={14} />
                  </button>
                )}
                {(c.author_id === user.id || rank >= 4) && (
                  <>
                    <button
                      title="删除评论"
                      aria-label="删除评论"
                      onClick={() => act({ deleted: true })}
                    >
                      <Trash2 size={14} />
                    </button>
                    {!c.parent_id && (
                      <button
                        title={c.resolved ? "重新打开" : "解决评论"}
                        aria-label={c.resolved ? "重新打开" : "解决评论"}
                        onClick={() => act({ resolved: !c.resolved })}
                      >
                        {c.resolved ? (
                          <RotateCcw size={14} />
                        ) : (
                          <Check size={15} />
                        )}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </span>
        </div>
        <CommentContent comment={c} />
      </div>
    </div>
  );
}
