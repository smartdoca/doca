import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Columns2 } from "lucide-react";
import { DocumentSubmenu } from "@web/features/documents/document-submenu.js";
import {
  parseDocumentPageWidth,
  type DocumentPageWidth,
} from "@web/features/documents/document-page-layout.js";
import { api, roleRank, type Resource } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import type { MessageKey } from "@doca/i18n";

const widthKeys: Record<DocumentPageWidth, MessageKey> = {
  a4: "doc.width.a4",
  a3: "doc.width.a3",
  fluid: "doc.width.fluid",
};

export function pageWidthLabel(
  value: string | null | undefined,
  t: (key: MessageKey) => string,
) {
  return t(widthKeys[parseDocumentPageWidth(value ?? null)]);
}

export function useDocumentPageWidth(
  resource: Resource,
  canEdit: boolean,
  saved?: () => void,
) {
  const [mode, setMode] = useState<DocumentPageWidth>(() =>
    parseDocumentPageWidth(resource.page_width ?? null),
  );
  const version = useRef(resource.version);
  const migrated = useRef(false);
  useEffect(() => {
    setMode(parseDocumentPageWidth(resource.page_width ?? null));
    version.current = resource.version;
  }, [resource.id, resource.page_width, resource.version]);
  useEffect(() => {
    migrated.current = false;
  }, [resource.id]);
  const change = (value: DocumentPageWidth) => {
    if (!canEdit || value === mode) return;
    const previous = mode;
    setMode(value);
    void api<{ version: number; pageWidth: DocumentPageWidth }>(
      `/resources/${resource.id}/page-width`,
      "PATCH",
      { pageWidth: value, version: version.current },
    )
      .then((latest) => {
        version.current = latest.version;
        setMode(latest.pageWidth);
        saved?.();
      })
      .catch(() => setMode(previous));
  };
  useEffect(() => {
    if (migrated.current || !canEdit) return;
    migrated.current = true;
    let stored: DocumentPageWidth | null = null;
    try {
      for (const key of Object.keys(localStorage)) {
        if (
          !key.startsWith("doca:page-width:") ||
          !key.endsWith(`:${resource.id}`)
        )
          continue;
        stored = parseDocumentPageWidth(localStorage.getItem(key));
        localStorage.removeItem(key);
      }
    } catch {
      return;
    }
    if (
      stored &&
      stored !== "a4" &&
      parseDocumentPageWidth(resource.page_width ?? null) === "a4"
    )
      change(stored);
  }, [canEdit, resource.id]);
  return [mode, change] as const;
}

export function DocumentPageWidthMenu({
  mode,
  change,
  disabled,
}: {
  mode: DocumentPageWidth;
  change: (mode: DocumentPageWidth) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(
    () => setSlot(document.getElementById("document-page-width-slot")),
    [],
  );
  if (!slot) return null;
  return createPortal(
    <DocumentSubmenu
      label={t("doc.width")}
      panelLabel={t("doc.contentWidth")}
      icon={<Columns2 size={16} />}
    >
      {(
        (["a4", "a3", "fluid"] as const)
      ).map((value) => (
        <button
          key={value}
          aria-pressed={mode === value}
          disabled={disabled}
          onClick={() => change(value)}
        >
          <span>{t(widthKeys[value])}</span>
          <Check
            size={14}
            style={{ visibility: mode === value ? "visible" : "hidden" }}
          />
        </button>
      ))}
    </DocumentSubmenu>,
    slot,
  );
}

export function canEditPageWidth(resource: Resource) {
  return (
    resource.format === "rich_text" && roleRank(resource.role) >= 3
  );
}
