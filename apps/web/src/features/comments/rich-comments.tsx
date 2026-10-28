import { Feedback } from "@web/shared/components/feedback.js";
import { composeComment } from "@web/features/comments/comment-body.js";
import { useEffect, useRef, useState } from "react";
import { Popconfirm } from "antd";
import {
  ImagePlus,
  Send,
  X,
  Pencil,
  Reply,
  Check,
  Trash2,
  RotateCcw,
  LoaderCircle,
} from "lucide-react";
import {
  api,
  assetUrl,
  uploadFile,
  type Comment,
  type FileItem,
  type User,
} from "@web/shared/api.js";
import {
  FileSourceDialog,
  FolderFilePicker,
} from "@web/features/files/files.js";
import type {
  CommentBody,
  CommentInline,
} from "@core/modules/interactions/community.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import { UserMention } from "@web/shared/components/user-mention.js";
import { relativeTime } from "@web/features/documents/document-experience.js";
import "@web/features/comments/rich-comments.css";
import { EmojiPicker } from "@web/shared/components/emoji-picker.js";
import { useI18n } from "@web/shared/i18n.js";
import { scrollCommentIntoView } from "./comment-scroll.js";
import { useAttachmentPreview } from "@web/features/documents/attachment-preview.js";
import { guessMime } from "@web/features/documents/document-file-preview.js";
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
  const body = JSON.parse(c.body_json ?? "null");
  if (body?.version !== 1 || !Array.isArray(body.blocks))
    throw new Error("评论结构无效");
  return body;
}
export function CommentContent({ comment }: { comment: Comment }) {
  const { t } = useI18n();
  const preview = useAttachmentPreview();
  if (comment.deleted_at)
    return <p className="subtle">{t("comment.deleted")}</p>;
  const blocks = parsedComment(comment).blocks;
  const images = blocks.filter(b => b.type === "image");
  return (
    <div className="rich-comment-body" onPointerDown={event => event.stopPropagation()}>
      {blocks.map((b, i) =>
        b.type === "image" ? (
          <button
            type="button"
            className="comment-image-preview"
            key={i}
            aria-label={b.alt || t("comment.image")}
            onClick={() => preview.openImagePreview(images.map(image => ({
              id: image.assetId,
              name: image.alt || t("comment.image"),
              mime: guessMime(image.alt || "", "image/*"),
              url: assetUrl(image.assetId),
              downloadUrl: assetUrl(image.assetId) + "?download=1",
            })), images.indexOf(b))}
          >
            <img
              src={assetUrl(b.assetId)}
              alt={b.alt || t("comment.image")}
              loading="lazy"
            />
          </button>
        ) : (
          <p key={i}>
            {b.children.map((n, j) =>
              n.type === "text" ? (
                <span key={j}>{n.text}</span>
              ) : (
                <UserMention
                  key={j}
                  id={n.userId}
                  name={n.label}
                  className="comment-mention"
                />
              ),
            )}
          </p>
        ),
      )}
      {preview.dialog}
    </div>
  );
}
export type CommentPublication = { id: string; previousVersion?: number };

/** Keep feedback after the write succeeds, until the refreshed list contains it. */
export function CommentPublicationStatus({ publication, comments }: {
  publication: CommentPublication | null;
  comments: Comment[];
}) {
  const { t } = useI18n();
  if (!publication || comments.some(c => c.id === publication.id &&
    (publication.previousVersion === undefined || c.version > publication.previousVersion))) return null;
  return <p className="comment-pending-status comment-publication-status" role="status">
    <LoaderCircle size={17} className="comment-pending-spinner" />{t("chat.sending")}
  </p>;
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
  const { t } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null),
    file = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; upload.current?.abort(); };
  }, []);
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const max = 320;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  };
  useEffect(() => {
    if (!autoFocus) return;
    input.current?.focus({ preventScroll: true });
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const drawer = input.current?.closest(".content-comments");
        // A Markdown document has an outer page scrollport as well as its
        // comment scrollport. Reveal the drawer first if that page moved away.
        if (drawer && /^(auto|scroll)$/.test(getComputedStyle(drawer).overflowY))
          scrollCommentIntoView(drawer, "nearest", "instant");
        scrollCommentIntoView(input.current, "center", "instant");
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
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
    [folderPicker, setFolderPicker] = useState<boolean | "materials">(false),
    [sourcePicker, setSourcePicker] = useState(false),
    [pending, setPending] = useState<"send" | "upload" | null>(null),
    [error, setError] = useState("");
  const busy = pending !== null;
  async function attach(source: File | ((signal: AbortSignal) => Promise<File>)) {
    if (upload.current || !mounted.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setPending("upload");
    setError("");
    try {
      const file = typeof source === "function" ? await source(controller.signal) : source;
      controller.signal.throwIfAborted();
      const asset = await uploadFile(file, "comment_image", resourceId, controller.signal);
      controller.signal.throwIfAborted();
      setImages(value => [...value, { type: "image", assetId: asset.id, alt: asset.filename }]);
    } finally {
      if (upload.current === controller) {
        upload.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }
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
      aria-busy={busy}
      // Editors own document shortcuts; an adjacent comment owns its keyboard,
      // clipboard and portalled file pickers, including the native textarea undo.
      onKeyDown={event => event.stopPropagation()}
      onKeyUp={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onCopy={event => event.stopPropagation()}
      onCut={event => event.stopPropagation()}
      onPaste={event => event.stopPropagation()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled || (!text.trim() && !images.length)) return;
        setPending("send");
        setError("");
        try {
          await submit(composeComment(text, mentions, images));
          setText("");
          setImages([]);
          setMentions({});
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setPending(null);
        }
      }}
    >
      <textarea
        ref={input}
        aria-label={t("comment.body")}
        placeholder={t("comment.placeholder")}
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
          aria-label={t("comment.mention")}
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
            <p className="subtle">{t("comment.noUsers")}</p>
          )}
        </div>
      )}
      <div className="comment-image-drafts">
        {images.map((im, i) => (
          <div key={im.assetId}>
            <img src={assetUrl(im.assetId)} alt={im.alt} />
            <button
              type="button"
              title={t("comment.removeImage")}
              aria-label={t("comment.removeImage")}
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
          title={t("comment.addImage")}
          aria-label={t("comment.addImage")}
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
            try {
              await attach(f);
            } catch (e) {
              if ((e as Error).name !== "AbortError") setError((e as Error).message);
            }
          }}
        />
        {folderPicker && (
          <FolderFilePicker
            initialSource={folderPicker === "materials" ? "materials" : "folders"}
            accept={(item) => item.mime.startsWith("image/")}
            close={() => {
              upload.current?.abort();
              setFolderPicker(false);
            }}
            select={async (item: FileItem) => {
              await attach(async signal => {
                const response = await fetch(`/api/v1/files/items/${item.id}/content`, { signal });
                if (!response.ok) throw new Error(t("comment.imageFailed"));
                return new File([await response.blob()], item.name, {
                  type: item.mime,
                });
              });
            }}
          />
        )}
        {sourcePicker && (
          <FileSourceDialog
            title={t("comment.addImage")}
            close={() => setSourcePicker(false)}
            chooseDoca={source => setFolderPicker(source ?? true)}
            chooseLocal={() => file.current?.click()}
          />
        )}
        <span className="grow" />
        {close && (
          <button
            type="button"
            title={t("comment.close")}
            aria-label={t("comment.close")}
            disabled={busy}
            onClick={close}
          >
            <X size={17} />
          </button>
        )}
        <button
          type="submit"
          className="send-comment"
          title={t("comment.send")}
          aria-label={t("comment.send")}
          disabled={busy || disabled || (!text.trim() && !images.length)}
        >
          {pending === "send" ? <LoaderCircle size={17} className="comment-pending-spinner" /> : <Send size={17} />}
        </button>
      </div>
      {pending && <p className="comment-pending-status" role="status">{t(pending === "upload" ? "common.uploading" : "chat.sending")}</p>}
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
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className={`comment-message${confirmDelete ? " is-confirming" : ""}`} data-comment-id={c.id}
      onKeyDown={event => {
        if (event.key === "Escape" && confirmDelete) {
          event.stopPropagation();
          setConfirmDelete(false);
        }
      }}>
      <UserBadge id={c.author_id} name={c.display_name} avatarOnly />
      <div className="grow">
        <div className="comment-byline">
          <strong>{c.display_name}</strong>
          <time title={c.created_at}>
            {relativeTime(c.created_at, Date.now(), t)}
          </time>
          <span className="comment-icon-actions">
            {user && !c.deleted_at && rank >= 2 && (
              <>
                {reply && !c.resolved && (
                  <button
                    title={t("comment.reply")}
                    aria-label={t("comment.reply")}
                    onClick={reply}
                  >
                    <Reply size={15} />
                  </button>
                )}
                {c.author_id === user.id && (
                  <button
                    title={t("comment.edit")}
                    aria-label={t("comment.edit")}
                    onClick={edit}
                  >
                    <Pencil size={14} />
                  </button>
                )}
                {(c.author_id === user.id || rank >= 4) && (
                  <>
                    <Popconfirm
                      open={confirmDelete}
                      onOpenChange={setConfirmDelete}
                      title={t("comment.deleteConfirm")}
                      okText={t("common.delete")}
                      cancelText={t("common.cancel")}
                      okButtonProps={{ danger: true }}
                      onConfirm={() => act({ deleted: true })}
                    >
                      <button
                        title={t("comment.delete")}
                        aria-label={t("comment.delete")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </Popconfirm>
                    {!c.parent_id && (
                      <button
                        title={
                          c.resolved
                            ? t("comment.reopen")
                            : t("comment.resolve")
                        }
                        aria-label={
                          c.resolved
                            ? t("comment.reopen")
                            : t("comment.resolve")
                        }
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
