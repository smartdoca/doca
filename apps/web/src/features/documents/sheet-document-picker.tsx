import { useEffect, useMemo, useRef, useState } from "react";
import type { SpreadsheetInlineActions } from "@smartdoca/sheet";
import { GlobalSearch } from "@web/features/search/search.js";

type Choice = { documentId: string; title: string } | null;
export function useSheetDocumentPicker(id: string, enabled: boolean) {
  const [open, setOpen] = useState(false);
  const pending = useRef<((choice: Choice) => void) | null>(null);
  useEffect(() => () => pending.current?.(null), [id, enabled]);
  const actions = useMemo<SpreadsheetInlineActions>(() => ({
    requestDocument: ({ signal }) => new Promise<Choice>(resolve => {
      pending.current?.(null);
      if (!enabled || signal.aborted) { resolve(null); return; }
      const abort = () => finish(null);
      const finish = (choice: Choice) => {
        signal.removeEventListener("abort", abort);
        if (pending.current === finish) pending.current = null;
        setOpen(false);
        resolve(choice);
      };
      pending.current = finish;
      signal.addEventListener("abort", abort, { once: true });
      setOpen(true);
    }),
  }), [id, enabled]);
  return {
    actions,
    picker: open ? <GlobalSearch close={() => pending.current?.(null)} select={r => pending.current?.({ documentId: r.id, title: r.title })} /> : null,
  };
}
