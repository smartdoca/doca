import { useCallback, useEffect, useRef } from "react";
import type {
  SpreadsheetCellRange,
  SpreadsheetEditorHandle,
  SpreadsheetNativeText,
  SpreadsheetTextTarget,
} from "@smartdoca/sheet";
import { api, type Detail } from "@web/shared/api.js";
import { internalDocumentId } from "@web/features/documents/internal-document-id.js";

/** The retained SDK token rejects changed drafts instead of inserting in another cell. */
export async function insertSheetDocumentLink(
  native: SpreadsheetNativeText,
  target: SpreadsheetTextTarget,
  id: string,
  original: string,
  lookup: () => Promise<Pick<Detail, "resource">>,
  alive: () => boolean,
) {
  try {
    let detail: Pick<Detail, "resource">;
    try {
      detail = await lookup();
      if (detail.resource.kind !== "document")
        throw Error("请选择本站文档链接");
    } catch (error) {
      // A failed title lookup must not silently consume the pasted URL.
      if (alive())
        native.insert(target, {
          kind: "link",
          text: original,
          href: original.startsWith("#") ? "/" + original : original,
        });
      throw error;
    }
    if (!alive()) return;
    if (
      !native.insert(target, {
        kind: "atomic",
        node: {
          type: "document",
          refId: id,
          label: detail.resource.title.slice(0, 512) || "未命名文档",
        },
      })
    )
      throw Error("文档链接插入失败，请重新粘贴");
  } finally {
    native.release(target);
  }
}

export function useSheetDocumentLinks(
  handle: SpreadsheetEditorHandle | null,
  enabled: boolean,
  onError: (message: string) => void,
) {
  const current = useRef({ handle, enabled });
  current.current = { handle, enabled };
  const pending = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const c of pending.current) c.abort();
      pending.current.clear();
    },
    [handle, enabled],
  );
  const paste = useCallback(
    (content: { files: File[]; text: string; range: SpreadsheetCellRange }) => {
      const id = internalDocumentId(content.text.trim(), location.origin);
      if (!enabled || !handle || !id || content.files.length) return false;
      const native = handle.getNativeText();
      if (!native || native.getState()?.formula || native.getState()?.composing)
        return false;
      const r = content.range;
      if (r.startRow !== r.endRow || r.startColumn !== r.endColumn)
        return false;
      const controller = new AbortController();
      pending.current.add(controller);
      const alive = () =>
        !controller.signal.aborted &&
        current.current.enabled &&
        current.current.handle === handle;
      const matches = () => {
        const s = handle.getSelection();
        return (
          s &&
          s.sheetId === r.sheetId &&
          s.startRow === r.startRow &&
          s.endRow === r.endRow &&
          s.startColumn === r.startColumn &&
          s.endColumn === r.endColumn
        );
      };
      // Capture immediately during native editing, before an async lookup can move the caret.
      let target: SpreadsheetTextTarget | null;
      try {
        target = native.getState() ? native.capture() : null;
      } catch {
        pending.current.delete(controller);
        return false;
      }
      void (async () => {
        try {
          if (!target) {
            if (!matches()) throw Error("选区已变化，请重新粘贴文档链接");
            await native.begin();
            for (
              let n = 0;
              n < 10 && alive() && matches() && !native.getState();
              n++
            )
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
            const state = native.getState();
            if (!alive()) return;
            if (
              !matches() ||
              !state ||
              state.cell.sheetId !== r.sheetId ||
              state.cell.row !== r.startRow ||
              state.cell.column !== r.startColumn
            )
              throw Error("无法定位插入位置，请双击单元格后粘贴");
            target = native.capture();
          }
          if (!target) throw Error("当前单元格不能插入文档链接");
          await insertSheetDocumentLink(
            native,
            target,
            id,
            content.text.trim(),
            () =>
              api<Detail>(
                `/resources/${id}`,
                "GET",
                undefined,
                controller.signal,
              ),
            alive,
          );
        } catch (error) {
          if (alive()) onError((error as Error).message);
        } finally {
          if (target) native.release(target);
          pending.current.delete(controller);
        }
      })();
      return true;
    },
    [handle, enabled, onError],
  );
  useEffect(() => {
    if (!handle) return;
    const native = handle.getNativeText();
    let focused = false;
    const focus = (e: Event) => {
      focused =
        e.target instanceof Element &&
        !!e.target.closest(".uos-editor, [data-u-comp='editor']");
    };
    const listener = (e: ClipboardEvent) => {
      const state = native?.getState();
      if (
        !enabled ||
        !e.clipboardData ||
        !(e.target instanceof Element) ||
        (!e.target.closest(".uos-editor, [data-u-comp='editor']") &&
          !focused) ||
        (!state && e.target.matches("input, textarea"))
      )
        return;
      const range = state
        ? {
            sheetId: state.cell.sheetId,
            startRow: state.cell.row,
            endRow: state.cell.row,
            startColumn: state.cell.column,
            endColumn: state.cell.column,
          }
        : handle.getSelection();
      if (!range) return;
      if (
        paste({
          text: e.clipboardData.getData("text/plain"),
          files: Array.from(e.clipboardData.files),
          range,
        })
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener("paste", listener, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("pointerdown", focus, true);
    const stop = native?.onNodeEvent((e) => {
      if (
        e?.phase === "click" &&
        e.node.type === "document" &&
        /^[a-f0-9-]{36}$/i.test(e.node.refId)
      )
        window.open(`#/r/${e.node.refId}`, "_blank", "noopener,noreferrer");
    });
    return () => {
      document.removeEventListener("paste", listener, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("pointerdown", focus, true);
      stop?.();
    };
  }, [handle, enabled, paste]);
  return paste;
}
