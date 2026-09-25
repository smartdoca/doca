import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Eye, Pencil } from "lucide-react";
import { Select } from "@web/shared/components/select.js";
import { useI18n } from "@web/shared/i18n.js";
import "@web/features/documents/document-mode.css";

export type DocumentMode = "edit" | "read";
export const resolveDocumentMode = (
  canEdit: boolean,
  requested: DocumentMode,
): DocumentMode => (canEdit ? requested : "read");
type ModeState = {
  canEdit: boolean;
  readOnly: boolean;
  change: (mode: DocumentMode) => void;
  reportPermission: (allowed: boolean | undefined) => void;
};
export const DocumentModeContext = createContext<ModeState | null>(null);

/** Session-local display preference, independent of ACL and editor persistence. */
export function useDocumentModeState(
  key: string,
  permitted: boolean,
): ModeState {
  const [choice, setChoice] = useState({ key, mode: "edit" as DocumentMode });
  const [live, setLive] = useState<{
    key: string;
    allowed: boolean | undefined;
  }>({ key, allowed: undefined });
  const canEdit = permitted && (live.key !== key || live.allowed !== false);
  const readOnly =
    resolveDocumentMode(canEdit, choice.key === key ? choice.mode : "edit") ===
    "read";
  const change = useCallback(
    (mode: DocumentMode) => setChoice({ key, mode }),
    [key],
  );
  const reportPermission = useCallback(
    (allowed: boolean | undefined) => {
      setLive((old) =>
        old.key === key && old.allowed === allowed ? old : { key, allowed },
      );
    },
    [key],
  );
  return useMemo(
    () => ({ canEdit, readOnly, change, reportPermission }),
    [canEdit, readOnly, change, reportPermission],
  );
}

/** Editors report live server ACL without conflating it with readiness or mode. */
export function useDocumentReadOnly(permitted: boolean | undefined) {
  const mode = useContext(DocumentModeContext);
  const report = mode?.reportPermission;
  useEffect(() => {
    report?.(permitted);
  }, [report, permitted]);
  return mode?.readOnly ?? false;
}

export function DocumentModeSwitch() {
  const { t } = useI18n();
  const mode = useContext(DocumentModeContext);
  if (!mode) return null;
  if (!mode.canEdit)
    return (
      <span className="document-mode-readonly" title={t("doc.mode.readonly")}>
        <Eye size={15} />
        {t("doc.mode.read")}
      </span>
    );
  return (
    <span className="document-mode-switch">
      {mode.readOnly ? <Eye size={15} /> : <Pencil size={15} />}
      <Select
        aria-label={t("doc.mode")}
        value={mode.readOnly ? "read" : "edit"}
        onChange={(e) => mode.change(e.target.value as DocumentMode)}
      >
        <option value="edit">{t("doc.mode.edit")}</option>
        <option value="read">{t("doc.mode.read")}</option>
      </Select>
    </span>
  );
}
