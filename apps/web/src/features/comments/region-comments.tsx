import { useAIBridge } from "@web/features/ai/ai-context.js";
import {
  createContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { MessageSquare, PanelRightClose } from "lucide-react";
import { api, type Detail, type User } from "@web/shared/api.js";
import {
  CommentComposer,
  CommentMessage,
  parsedComment,
  CommentPublicationStatus,
  type CommentPublication,
} from "@web/features/comments/rich-comments.js";
import type { CommentBody } from "@core/modules/interactions/community.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { placeCommentCards, commentRailHeight } from "@web/features/comments/comment-position.js";
import { CommentNavigation } from "@web/features/comments/comment-navigation.js";
import { scrollCommentIntoView } from "@web/features/comments/comment-scroll.js";
import { isRegionCommentInteraction } from "@web/features/comments/region-comment-interaction.js";
import { useI18n } from "@web/shared/i18n.js";
import { useCommentPages } from "./use-comment-pages.js";
import { CommentSidebar } from "./comment-sidebar.js";
import { ResolvedComments } from "./resolved-comments.js";
export type RegionController = {
  flush?(): void | Promise<void>;
  capture(): unknown | null;
  valid(anchor: any): boolean;
  reveal(anchor: any, source: "comment" | "ai"): void;
  label(anchor: any): string;
  /** Source offset and viewport top, without moving selection or scrolling. */
  position?(anchor: any, id: string): { order: number; top: number } | null;
  scrollOffset?(): number;
  /** Maximum scroll offset of the source, including otherwise uncommented content. */
  scrollExtent?(): number;
};
export const RegionCommentActionContext = createContext<{
  add(): void;
  enabled: boolean;
}>({ add() {}, enabled: false });
/** Host-owned comments; packages only supply stable region anchors and native selection. */
export function RegionComments({
  detail,
  user,
  rank,
  connected,
  dirty,
  controller,
  changed,
  revision,
  active,
  setActive,
  targetComment,
  loadMoreComments,
  createAction,
  candidateIds,
  onOpenChange,
  onHighlightChange,
}: {
  detail: Detail;
  user: User | null;
  rank: number;
  connected: boolean;
  dirty: boolean;
  controller: RegionController | null;
  changed(): void;
  revision: number;
  active: string | null;
  setActive(id: string | null): void;
  targetComment?: string | null;
  loadMoreComments?: () => Promise<void>;
  createAction: MutableRefObject<() => void>;
  candidateIds?: string[];
  onOpenChange?(open: boolean): void;
  onHighlightChange(id: string | null): void;
}) {
  const { t } = useI18n();
  useAIBridge(detail.resource.id, { capture: () => controller?.capture(), describe: a => controller?.label(a) ?? t("comment.quote"), reveal: a => { if (!controller?.valid(a)) throw Error(t("comment.quoteStale")); controller.reveal(a, "ai"); }, ready: () => !!controller && connected && !dirty, flush: () => controller?.flush?.() });
  const [open, setOpen] = useState(false),
    [sidebarReady, setSidebarReady] = useState(false),
    [revealComment, setRevealComment] = useState<string | null>(null),
    [draft, setDraft] = useState<any>(null),
    [reply, setReply] = useState<Detail["comments"][number] | null>(null),
    [editing, setEditing] = useState<Detail["comments"][number] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [publication, setPublication] = useState<CommentPublication | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  useEffect(() => { if (!open) onHighlightChange(null); }, [open, onHighlightChange]);
  useEffect(() => () => onHighlightChange(null), [onHighlightChange]);
  // Native markers must include every page even while the drawer is closed.
  useCommentPages(detail.resource.id, true, detail.commentsNextCursor, loadMoreComments, open);
  const rail = useRef<HTMLDivElement>(null);
  const lastSourceOffset = useRef<number | undefined>(undefined);
  useEffect(() => { lastSourceOffset.current = undefined; }, [open, detail.resource.id]);
  const roots = detail.comments.filter((c) => {
    if (!c.anchor || c.parent_id || c.deleted_at || c.resolved || !controller)
      return false;
    try {
      return controller.valid(JSON.parse(c.anchor));
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!open || !controller?.position) return;
    let frame = 0;
    const targets = new Map<string, { order: number; target: number }>();
    const layout = () => {
      const host = rail.current;
      if (!host) return;
      const top = host.getBoundingClientRect().top;
      const sourceOffset = controller.scrollOffset?.() ?? 0;
      const cards = Array.from(
        host.querySelectorAll<HTMLElement>(":scope > [data-thread-id]"),
      );
      const positions = placeCommentCards(
        cards.map((card, index) => {
          let location = null;
          try {
            location = controller.position!(
              JSON.parse(card.dataset.anchor!),
              card.dataset.threadId!,
            );
          } catch {}
          const target = location
            ? {
                order: location.order,
                target:
                  location.top -
                  top -
                  (panel.current?.scrollTop ?? 0) +
                  sourceOffset,
              }
            : (targets.get(card.dataset.threadId!) ?? {
                order: index,
                target: 0,
              });
          if (location) targets.set(card.dataset.threadId!, target);
          return {
            id: card.dataset.threadId!,
            ...target,
            height: card.offsetHeight,
          };
        }),
      );
      let bottom = 0;
      for (const { id, top: y } of positions) {
        const card = cards.find((c) => c.dataset.threadId === id)!;
        card.style.position = "absolute";
        card.style.top = `${y}px`;
        card.style.width = "100%";
        bottom = Math.max(bottom, y + card.offsetHeight + 16);
      }
      const scroller = panel.current;
      const railOffset = scroller
        ? top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : 0;
      host.style.height = `${commentRailHeight(bottom, controller.scrollExtent?.() ?? 0, scroller?.clientHeight ?? 0, railOffset)}px`;
      // Set the extent BEFORE scrollTop. Otherwise a short/sparse comment rail
      // clamps the requested offset and leaves cards stuck while the source moves.
      if (
        scroller &&
        controller.scrollOffset &&
        sourceOffset !== lastSourceOffset.current
      ) {
        scroller.scrollTop = sourceOffset;
        lastSourceOffset.current = sourceOffset;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    };
    const observer = new ResizeObserver(schedule);
    if (rail.current)
      Array.from(rail.current.children).forEach((c) => observer.observe(c));
    const scroll = () => schedule();
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", schedule);
    // Preview annotations are painted asynchronously by the SDK.
    const timer = window.setInterval(schedule, 250);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [
    open,
    sidebarReady,
    controller,
    revision,
    detail.comments,
    reply,
    editing,
    draft,
  ]);
  useEffect(() => {
    if (active) {
      setOpen(true);
    }
  }, [active]);
  useEffect(() => {
    if (candidateIds?.length) {
      setOpen(true);
    }
  }, [candidateIds]);
  useEffect(() => {
    if (!revealComment || !detail.comments.some(comment => comment.id === revealComment)) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        scrollCommentIntoView(panel.current?.querySelector(`[data-comment-id="${revealComment}"]`), "center", "instant");
        setRevealComment(null);
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [detail.comments, revealComment]);
  useEffect(() => {
    // Repeated clicks in the same region leave both the drawer and its scroll
    // position untouched. A new target only reveals its message vertically.
    if (!open || !active || controller?.position) return;
    const frame = requestAnimationFrame(() =>
      scrollCommentIntoView(panel.current?.querySelector(`[data-thread-id="${active}"]`)),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, active, controller?.position]);
  useEffect(() => {
    if (!targetComment || !controller) return;
    const c = detail.comments.find((c) => c.id === targetComment);
    const root = roots.find((r) => r.id === (c?.parent_id ?? c?.id));
    if (root) {
      setActive(root.id);
      controller.reveal(JSON.parse(root.anchor!), "comment");
    }
  }, [targetComment, controller]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!isRegionCommentInteraction(panel.current, target)) {
        // This is a document sidebar, not a dismissible popover. Interacting
        // with AI, upload errors or other host controls must keep its draft.
        setActive(null);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const overlayTarget = target?.closest('.ant-modal-root,.ant-popconfirm');
      const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"],.ant-popconfirm'))
        .some(overlay => overlay.getClientRects().length > 0);
      if (!overlayTarget && !overlayOpen) {
        setOpen(false);
        setActive(null);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open, controller]);
  const add = () => {
    if (rank < 2 || !connected || !controller) return;
    const anchor = controller?.capture();
    if (!anchor) {
      setError(t("comment.needSelection"));
      setOpen(true);
      return;
    }
    setError("");
    setDraft(anchor);
    setReply(null);
    setEditing(null);
    setOpen(true);
  };
  useEffect(() => {
    createAction.current = add;
    return () => {
      createAction.current = () => {};
    };
  });
  const save = async (richBody: CommentBody) => {
    setBusy(true);
    try {
      if (editing) {
        await api(
          `/resources/${detail.resource.id}/comments/${editing.id}`,
          "PATCH",
          { version: editing.version, richBody },
        );
        setPublication({ id: editing.id, previousVersion: editing.version });
      } else {
        const created = await api<{ id: string }>(`/resources/${detail.resource.id}/comments`, "POST", {
          richBody,
          parentId: reply ? (reply.parent_id ?? reply.id) : null,
          ...(!reply && draft ? { anchor: JSON.stringify(draft) } : {}),
        });
        setRevealComment(created.id);
        setPublication({ id: created.id });
      }
      setDraft(null);
      setReply(null);
      setEditing(null);
      changed();
    } finally {
      setBusy(false);
    }
  };
  const composer = (
    <CommentComposer
      key={editing?.id ?? reply?.id ?? JSON.stringify(draft)}
      resourceId={detail.resource.id}
      autoFocus
      replyTo={reply ?? undefined}
      initial={editing ? parsedComment(editing) : undefined}
      disabled={busy || !connected || dirty || rank < 2}
      submit={save}
      close={() => {
        setDraft(null);
        setReply(null);
        setEditing(null);
      }}
    />
  );
  return (
    <>
      <div className="region-comment-controls">
        <button
          className="icon comment-control region-comment-toggle"
          title={t("comment.region")}
          aria-label={t("comment.openRegion")}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (open) setActive(null);
          }}
        >
          <MessageSquare size={18} />
          {roots.length > 0 && <small className="comment-control-count">{roots.length}</small>}
        </button>
      </div>
      <CommentSidebar open={open} readyChanged={setSidebarReady}>
      {open && (
        <aside
          ref={panel}
          className="content-comments region-comments-drawer"
          aria-label={t("comment.drawer")}
        >
          <header>
            <h3>
              {t("comment.region")} <small>{roots.length}</small>
            </h3>
            <div className="region-comment-header-actions comment-sidebar-actions">
              <ResolvedComments detail={detail} user={user} rank={rank} changed={changed} loadMore={loadMoreComments}
                quote={comment => {
                  try { return controller?.label(JSON.parse(comment.anchor!)) ?? t("comment.quoteDeleted"); }
                  catch { return t("comment.quoteDeleted"); }
                }} />
              <CommentNavigation
                ids={[...roots]
                  .sort((a, b) => {
                    if (!controller?.position) return 0;
                    try {
                      return (
                        (controller.position(JSON.parse(a.anchor!), a.id)
                          ?.order ?? 0) -
                        (controller.position(JSON.parse(b.anchor!), b.id)
                          ?.order ?? 0)
                      );
                    } catch {
                      return 0;
                    }
                  })
                  .map((c) => c.id)}
                active={active}
                select={(id) => {
                  const comment = roots.find((c) => c.id === id)!;
                  setActive(id);
                  onHighlightChange(id);
                  controller?.reveal(JSON.parse(comment.anchor!), "comment");
                  // Ordered rails follow the source scroll; do not race it with
                  // a second scroll towards a card's pre-layout position.
                  if (!controller?.position) requestAnimationFrame(() =>
                    scrollCommentIntoView(panel.current?.querySelector(`[data-thread-id="${id}"]`)),
                  );
                }}
              />
              <button
                className="icon comment-control"
                title={t("comment.closeRegion")}
                aria-label={t("comment.closeRegion")}
                onClick={() => {
                  setOpen(false);
                  setActive(null);
                }}
              >
                <PanelRightClose size={18} />
              </button>
            </div>
            <CommentPublicationStatus publication={publication} comments={detail.comments} />
          </header>
          {candidateIds && candidateIds.length > 1 && (
            <div className="comment-candidates" aria-label={t("comment.regionList")}>
              <small>{t("comment.regionCount", { count: candidateIds.length })}</small>
              {roots
                .filter((root) => candidateIds.includes(root.id))
                .map((root, index) => (
                  <button
                    key={root.id}
                    onClick={() => {
                      setActive(root.id);
                      onHighlightChange(root.id);
                      controller?.reveal(JSON.parse(root.anchor!), "comment");
                    }}
                  >
                    {t("comment.regionIndex", { index: index + 1 })} ·{" "}
                    {controller?.label(JSON.parse(root.anchor!))}
                  </button>
                ))}
            </div>
          )}
          <Feedback message={error} tone="error" />
          {!roots.length && !draft && (
            <p className="subtle">{t("comment.regionEmpty")}</p>
          )}
          {draft && controller?.position && (
            <article className="selection-thread draft linked-comment-draft">
              <div className="comment-quote">{controller.label(draft)}</div>
              {composer}
            </article>
          )}
          <div ref={rail} className="comment-cards">
            {[...roots]
              .sort((a, b) => {
                if (!controller?.position) return 0;
                try {
                  return (
                    (controller.position(JSON.parse(a.anchor!), a.id)?.order ??
                      0) -
                    (controller.position(JSON.parse(b.anchor!), b.id)?.order ??
                      0)
                  );
                } catch {
                  return 0;
                }
              })
              .map((root) => (
                <article
                  key={root.id}
                  data-thread-id={root.id}
                  data-anchor={root.anchor}
                  className={`selection-thread ${active === root.id ? "active" : ""}`}
                  onClick={(e) => {
                    if (
                      (e.target as HTMLElement).closest(
                        "button,a,input,textarea,select,[contenteditable]",
                      )
                    )
                      return;
                    setActive(root.id);
                    onHighlightChange(root.id);
                    controller?.reveal(JSON.parse(root.anchor!), "comment");
                  }}
                >
                  <div className="comment-quote">
                    {controller?.label(JSON.parse(root.anchor!))}
                  </div>
                  {[
                    root,
                    ...detail.comments.filter((c) => c.parent_id === root.id),
                  ]
                    .map((c) => (
                      <CommentMessage
                        key={c.id}
                        comment={c}
                        user={user}
                        rank={rank}
                        reply={() => {
                          setReply(c);
                          setDraft(null);
                          setEditing(null);
                        }}
                        edit={() => {
                          setEditing(c);
                          setDraft(null);
                          setReply(null);
                        }}
                        act={(patch) => {
                          void api(
                            `/resources/${detail.resource.id}/comments/${c.id}`,
                            "PATCH",
                            { version: c.version, ...patch },
                          )
                            .then(changed)
                            .catch((e) => setError(e.message));
                        }}
                      />
                    ))}
                  {((reply && (reply.parent_id ?? reply.id) === root.id) ||
                    (editing &&
                      (editing.parent_id ?? editing.id) === root.id)) &&
                    composer}
                </article>
              ))}
          </div>
          {draft && !controller?.position && (
            <article className="selection-thread draft">
              <div className="comment-quote">{controller?.label(draft)}</div>
              {composer}
            </article>
          )}
        </aside>
      )}
      </CommentSidebar>
    </>
  );
}
