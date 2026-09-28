import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  SpreadsheetEditorHandle,
  SpreadsheetTextTarget,
  SpreadsheetInlineNodeEvent,
} from "@smartdoca/sheet";
import { lookupUsers, mentionHandle, mentionLabel, type MentionUser } from "@web/features/comments/rich-comments.js";
import { setUserCardsSuppressed, UserBadge } from "@web/shared/components/user-badge.js";

/** Host-owned directory UI; insertion uses the SDK's retained native draft token. */
export function SheetNativeMentions({
  handle,
  enabled,
  onError,
}: {
  handle: SpreadsheetEditorHandle;
  enabled: boolean;
  onError(message: string): void;
}) {
const { t } = useI18n();

  const [query, setQuery] = useState<string | null>(null);
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [node, setNode] = useState<SpreadsheetInlineNodeEvent | null>(null);
  const target = useRef<SpreadsheetTextTarget | null>(null);
  const openKey = useRef("");
  const suppressed = useRef("");
  const queryRef = useRef<string | null>(null);
  const suppressedNodeKey = useRef<string | null>(null);
  const api = handle.getNativeText();
  queryRef.current = query;
  const nodeKey = (event: SpreadsheetInlineNodeEvent) =>
    `${event.cell.sheetId}:${event.cell.row}:${event.cell.column}:${event.node.type}:${event.node.refId}`;
  const close = () => {
    suppressed.current = openKey.current;
    openKey.current = "";
    if (target.current) api?.release(target.current);
    target.current = null;
    setQuery(null);
  };
  const choose = (user: MentionUser) => {
    const t = target.current;
    if (!enabled || !api || !t) return;
    const state = api.getState();
    const selectedNodeKey = state
      ? `${state.cell.sheetId}:${state.cell.row}:${state.cell.column}:user:${user.id}`
      : null;
    try {
      // The canvas may emit a hover event as the picker disappears. Suppress
      // that one event for the node we have just inserted; cards can still
      // open normally after the pointer leaves and re-enters the cell.
      suppressedNodeKey.current = selectedNodeKey;
      if (
        !api.insert(t, {
          kind: "atomic",
          node: {
            type: "user",
            refId: user.id,
            label: "@" + mentionLabel(user),
          },
        })
      )
        throw Error("用户插入未成功，请重新输入 @");
    } catch (e) {
      suppressedNodeKey.current = null;
      onError((e as Error).message);
    }
    setNode(null);
    close();
  };
  useEffect(() => {
    if (!api) return;
    const stop = api.subscribe((state) => {
      if (target.current) api.release(target.current);
      target.current = null;
      const match =
        enabled &&
        state &&
        !state.composing &&
        !state.formula &&
        state.startOffset === state.endOffset
          ? state.text.slice(0, state.startOffset).match(/@([^@\s]*)$/)
          : null;
      if (!match) suppressed.current = "";
      if (
        match &&
        state &&
        !state.nodes.some(
          (n) =>
            n.startOffset <= state.startOffset - match[0].length &&
            n.endOffset >= state.startOffset,
        )
      ) {
        const key = `${state.cell.sheetId}:${state.cell.row}:${state.cell.column}:${state.startOffset}:${match[0]}`;
        if (key !== suppressed.current)
          try {
            target.current = api.capture({
              startOffset: state.startOffset - match[0].length,
              endOffset: state.startOffset,
            });
            openKey.current = key;
            setRect(
              handle.getRangeRect({
                sheetId: state.cell.sheetId,
                startRow: state.cell.row,
                endRow: state.cell.row,
                startColumn: state.cell.column,
                endColumn: state.cell.column,
              }),
            );
          } catch {
            /* Composing, changed cell, or stale draft: do not insert elsewhere. */
          }
      }
      setQuery(target.current && match ? match[1]! : null);
    });
    const nodes = api.onNodeEvent((event) => {
      // The SDK emits null when the pointer leaves its canvas to enter our
      // portal. Keep the card mounted until its own outside/leave dismissal.
      if (!event) {
        suppressedNodeKey.current = null;
        return;
      }
      // While choosing a user, the picker owns the interaction. Do not let a
      // canvas hover from underneath it open a profile card.
      if (queryRef.current !== null) {
        setNode(null);
        return;
      }
      const key = nodeKey(event);
      if (suppressedNodeKey.current === key) return;
      suppressedNodeKey.current = null;
      if (event.node.type !== "user") return;
      setNode(event);
      setRect(
        handle.getRangeRect({
          sheetId: event.cell.sheetId,
          startRow: event.cell.row,
          endRow: event.cell.row,
          startColumn: event.cell.column,
          endColumn: event.cell.column,
        }),
      );
    });
    return () => {
      stop();
      nodes();
      if (target.current) api.release(target.current);
      target.current = null;
    };
  }, [api, enabled, handle]);
  useEffect(() => {
    if (query !== null) setNode(null);
  }, [query]);
  useLayoutEffect(() => {
    const suppressed = query !== null;
    setUserCardsSuppressed(suppressed);
    return () => setUserCardsSuppressed(false);
  }, [query]);
  useEffect(() => {
    setUsers([]);
    setIndex(0);
    if (query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void lookupUsers(query, controller.signal)
        .then(setUsers)
        .catch((e) => {
          if (!controller.signal.aborted) onError(e.message);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, onError]);
  useEffect(() => {
    if (query === null) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.isComposing ||
        !(e.target instanceof Element) ||
        !e.target.closest(".sheet-document")
      )
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (
        users.length &&
        ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Enter") choose(users[index]!);
        else
          setIndex(
            (i) =>
              (i + (e.key === "ArrowDown" ? 1 : -1) + users.length) %
              users.length,
          );
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [query, users, index, enabled, api]);
  if (!rect || (query === null && !node)) return null;
  if (query === null && node)
    return createPortal(
      <UserBadge
        key={`${node.node.refId}:${node.cell.sheetId}:${node.cell.row}:${node.cell.column}`}
        id={node.node.refId}
        name={node.node.label.replace(/^@/, "")}
        initialOpen
        hideTrigger
        anchorRect={rect}
        onDismiss={() => setNode(null)}
      />,
      document.body,
    );
  return createPortal(
    <aside
      className="sheet-native-candidates"
      style={{
        left: Math.max(8, Math.min(rect.left, innerWidth - 280)),
        top: Math.max(140, Math.min(rect.bottom + 6, innerHeight - 260)),
      }}
    >
      {query !== null ? (
        <div role="listbox" aria-label="选择提及用户">
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
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(u)}
            >
              <UserBadge id={u.id} name={label} avatarOnly passive />
              <span className="mention-option-name">{label}</span>
              {handleId && (
                <span className="mention-option-id">({handleId})</span>
              )}
            </button>
            );
          })}
          {!users.length && <p className="mention-empty">继续输入姓名查找用户</p>}
          <button
            className="mention-cancel"
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
          >{t("common.cancel")}</button>
        </div>
      ) : null}
    </aside>,
    document.body,
  );
}
