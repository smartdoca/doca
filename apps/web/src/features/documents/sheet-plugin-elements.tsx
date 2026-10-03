import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  SpreadsheetCellRenderer,
  SpreadsheetEditorHandle,
  SpreadsheetCommentAnchor,
  SpreadsheetCellRange,
} from "@smartdoca/sheet";
import {
  isPluginElementPayload,
  type PluginElementPayload,
} from "@smartdoca/plugin-contracts";
import type {
  PluginElementContext,
  PluginElementContribution,
  PluginElementState,
} from "@smartdoca/web-plugin-registry";
import { webPluginRegistry } from "@web/plugins/registry.js";
import { useI18n } from "@web/shared/i18n.js";
import { notifyFeedback } from "@web/shared/components/feedback.js";
import {
  PluginElementDialog,
  pluginElementState,
  usePluginElements,
  type ElementDialogSession,
} from "./plugin-elements.js";
import { PackagePlus } from "lucide-react";
import { createElementViewRefresh } from "./plugin-element-refresh.js";

export const SHEET_ELEMENT_PROPERTY = "docaElement";
export function useSheetPluginElements(
  documentId: string,
  handle: SpreadsheetEditorHandle | null,
  editable: boolean,
) {
  const { locale, t } = useI18n();
  usePluginElements("spreadsheet");
  const registryRevision = webPluginRegistry.elements.snapshot();
  const [session, setSession] = useState<ElementDialogSession | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById("editor-toolbar-slot"));
  }, [documentId]);
  useEffect(() => {
    if (!editable) setSession(null);
  }, [editable]);
  const live = useRef({ handle, editable, locale, t });
  live.current = { handle, editable, locale, t };
  const abort = useMemo(
    () => new AbortController(),
    [documentId, registryRevision],
  );
  useEffect(() => () => abort.abort(), [abort]);
  useEffect(() => {
    setSession(null);
  }, [documentId, handle, abort]);
  const context = (): PluginElementContext => ({
    documentId,
    format: "spreadsheet",
    locale: live.current.locale,
    readOnly: !live.current.editable,
    signal: abort.signal,
  });
  const refresh = () =>
    live.current.handle
      ?.getRuntime()
      ?.univerAPI.getActiveWorkbook()
      ?.getActiveSheet()
      .refreshCanvas();
  const viewRefresh = useMemo(
    () =>
      createElementViewRefresh(
        refresh,
        () =>
          !abort.signal.aborted && !document.hidden && !!live.current.handle,
      ),
    [documentId, abort],
  );
  const renderers = useMemo<SpreadsheetCellRenderer[]>(() => {
    let revision = -1;
    let cache = new WeakMap<
      object,
      {
        provider: PluginElementContribution | undefined;
        state: PluginElementState;
      }
    >();
    const stateOf = (
      value: unknown,
      provider: PluginElementContribution | undefined,
    ) => {
      const nextRevision = webPluginRegistry.elements.snapshot();
      if (revision !== nextRevision) {
        revision = nextRevision;
        cache = new WeakMap();
      }
      if (!value || typeof value !== "object") return "unsupported";
      const cached = cache.get(value);
      if (cached && cached.provider === provider) return cached.state;
      const state = pluginElementState(value, provider, "spreadsheet");
      cache.set(value, { provider, state });
      return state;
    };
    return [
      {
        zIndex: 30,
        drawWith(canvas, info) {
          const custom = info.data?.custom;
          if (!custom || !Object.hasOwn(custom, SHEET_ELEMENT_PROPERTY)) return;
          const value = custom[SHEET_ELEMENT_PROPERTY];
          const type = typeof value?.type === "string" ? value.type : undefined;
          const provider = type
            ? webPluginRegistry.elements.get(type)
            : undefined;
          const state = stateOf(value, provider);
          const cell = info.primaryWithCoord;
          const rect = {
            x: cell.startX,
            y: cell.startY,
            width: cell.endX - cell.startX,
            height: cell.endY - cell.startY,
          };
          canvas.save();
          try {
            canvas.beginPath();
            canvas.rect(
              rect.x + 1,
              rect.y + 1,
              Math.max(0, rect.width - 2),
              Math.max(0, rect.height - 2),
            );
            canvas.clip();
            canvas.fillStyle = "#fff";
            canvas.fillRect(
              rect.x + 1,
              rect.y + 1,
              rect.width - 2,
              rect.height - 2,
            );
            let reason: "unsupported" | "invalid" | "failed" =
              state === "invalid" ? "invalid" : "unsupported";
            if (state === "ready") {
              try {
                provider!.renderCell!({
                  ...context(),
                  canvas,
                  rect,
                  payload: structuredClone(value) as PluginElementPayload,
                });
                if (provider!.refreshIntervalMs)
                  viewRefresh.schedule(provider!.refreshIntervalMs);
                return;
              } catch {
                reason = "failed";
              }
            }
            canvas.fillStyle = "#b42318";
            canvas.font = "12px sans-serif";
            canvas.textBaseline = "middle";
            canvas.fillText(
              live.current.t(`editor.element.${reason}`),
              rect.x + 6,
              rect.y + rect.height / 2,
              Math.max(1, rect.width - 12),
            );
          } finally {
            canvas.restore();
          }
        },
        isHit(_position, info) {
          return (
            !!info.data?.custom &&
            Object.hasOwn(info.data.custom, SHEET_ELEMENT_PROPERTY)
          );
        },
        onPointerDown(info) {
          const value = info.data?.custom?.[SHEET_ELEMENT_PROPERTY];
          const provider = isPluginElementPayload(value)
            ? webPluginRegistry.elements.get(value.type)
            : undefined;
          if (pluginElementState(value, provider, "spreadsheet") !== "ready")
            return;
          try {
            provider?.onCellClick?.(structuredClone(value), context());
          } catch {
            notifyFeedback(live.current.t("editor.element.failed"), "error");
          }
        },
      },
    ];
  }, [documentId, abort, viewRefresh]);
  useEffect(() => {
    refresh();
    const visible = () => {
      if (document.hidden) viewRefresh.cancel();
      else refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      viewRefresh.cancel();
    };
  }, [handle, locale, registryRevision, abort, viewRefresh]);
  const open = () => {
    if (!handle || !editable || handle.getFormatState().editing) return;
    const selection = handle.getSelection();
    if (
      !selection ||
      selection.startRow !== selection.endRow ||
      selection.startColumn !== selection.endColumn
    ) {
      notifyFeedback(t("editor.element.singleCell"), "error");
      return;
    }
    const anchor: SpreadsheetCommentAnchor | null =
      handle.captureCommentAnchor();
    if (!anchor) return;
    const read = (range: SpreadsheetCellRange) =>
      handle
        .getRuntime()
        ?.univerAPI.getActiveWorkbook()
        ?.getWorkbook?.()
        ?.getSheetBySheetId(range.sheetId)
        ?.getCell(range.startRow, range.startColumn);
    const original = read(selection);
    const fingerprint = (cell: ReturnType<typeof read>) =>
      JSON.stringify({
        v: cell?.v,
        f: cell?.f,
        p: cell?.p,
        custom: cell?.custom,
      });
    const expected = fingerprint(original);
    const payload = original?.custom?.[SHEET_ELEMENT_PROPERTY];
    const current = isPluginElementPayload(payload) ? payload : null;
    const target = () => {
      if (
        abort.signal.aborted ||
        !live.current.editable ||
        live.current.handle !== handle ||
        handle.getFormatState().editing
      )
        throw Error("Editor unavailable");
      const resolved = handle.resolveCommentAnchor(anchor);
      if (!resolved || fingerprint(read(resolved)) !== expected)
        throw Error("Cell changed or removed");
      const sheet = handle
        .getRuntime()
        ?.univerAPI.getActiveWorkbook()
        ?.getSheets()
        .find((sheet) => sheet.getSheetId() === resolved.sheetId);
      if (!sheet) throw Error("Worksheet removed");
      return sheet.getRange(resolved.startRow, resolved.startColumn, 1, 1);
    };
    setSession({
      type: payload
        ? typeof payload.type === "string"
          ? payload.type
          : "unsupported"
        : undefined,
      unsupported:
        payload !== undefined &&
        pluginElementState(
          payload,
          current ? webPluginRegistry.elements.get(current.type) : undefined,
          "spreadsheet",
        ) !== "ready",
      initialData: current?.data,
      commit(next) {
        if (
          current &&
          (next.type !== current.type ||
            next.dataVersion !== current.dataVersion)
        )
          throw Error("Unsupported element version");
        const range = target();
        range.setValue({
          v: next.text,
          f: null,
          p: null,
          t: 1,
          // Keep the native text projection inside this canvas-backed cell.
          s: { ...range.getCellStyleData(), tb: 2 },
          custom: { [SHEET_ELEMENT_PROPERTY]: next },
        });
      },
      remove:
        payload !== undefined
          ? () => {
              target().setValue({ v: null, f: null, p: null, custom: null });
            }
          : undefined,
    });
  };
  return {
    renderers,
    ui: (
      <>
        {slot &&
          handle &&
          editable &&
          createPortal(
            <button
              type="button"
              title={t("editor.element.insert")}
              aria-label={t("editor.element.insert")}
              onClick={open}
            >
              <PackagePlus size={17} />
              {t("editor.element.insert")}
            </button>,
            slot,
          )}
        {session && editable && (
          <PluginElementDialog
            documentId={documentId}
            format="spreadsheet"
            session={session}
            close={() => setSession(null)}
          />
        )}
      </>
    ),
  };
}
