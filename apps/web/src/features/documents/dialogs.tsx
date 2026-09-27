import { createPortal } from "react-dom";
import { Feedback } from "@web/shared/components/feedback.js";
import { Select } from "@web/shared/components/select.js";
import { PersonPicker } from "@web/features/documents/person-picker.js";
export { PersonPicker } from "@web/features/documents/person-picker.js";
export { PermissionDialog } from "@web/features/documents/permissions-panel.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
import React, { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { api, type Resource } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";

export function Dialog({
  title,
  close,
  children,
  className = "",
  shadeClassName = "",
  shadeStyle,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  className?: string;
  shadeClassName?: string;
  shadeStyle?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!panel.current?.contains(document.activeElement))
      panel.current
        ?.querySelector<HTMLElement>("input,button,select,textarea,[href]")
        ?.focus();
    return () => previous?.focus();
  }, []);
  const body: React.ReactNode[] = [],
    footers: React.ReactNode[] = [];
  for (const child of React.Children.toArray(children))
    (React.isValidElement(child) && child.type === "footer"
      ? footers
      : body
    ).push(child);
  return createPortal(
    <div
      className={`modal-shade ${shadeClassName}`}
      style={shadeStyle}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "Tab") {
          const list = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
            ) ?? [],
          ).filter((x) => x.offsetParent !== null);
          const first = list[0],
            last = list[list.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        className={`modal ${className}`}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label={t("dialog.close")} onClick={close}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{body}</div>
        {footers}
      </section>
    </div>,
    document.body,
  );
}
export function TransferDialog({
  resource,
  close,
  saved,
}: {
  resource: Resource;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState<{
      id: string;
      display_name: string;
    } | null>(null),
    [collaborators, setCollaborators] = useState<
      { id: string; display_name: string }[]
    >([]),
    [loadingCollaborators, setLoadingCollaborators] = useState(false),
    [retain, setRetain] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const personal = !resource.library_id;
  useEffect(() => {
    if (!personal) return;
    setLoadingCollaborators(true);
    void api<{
      members: { id: string; display_name: string }[];
    }>(`/resources/${resource.id}/permission-overview`)
      .then((overview) => {
        setCollaborators(
          overview.members.filter((member) => member.id !== resource.owner_id),
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : t("dialog.collaboratorsFailed")))
      .finally(() => setLoadingCollaborators(false));
  }, [personal, resource.id, resource.owner_id, t]);
  return (
    <Dialog title={t("dialog.transfer")} close={close}>
      <p>{t("dialog.transferLead")}</p>
      {personal ? (
        <label>
          {t("dialog.chooseCollaborator")}
          <Select
            value={target?.id ?? ""}
            disabled={loadingCollaborators}
            onChange={(e) =>
              setTarget(
                collaborators.find((member) => member.id === e.target.value) ??
                  null,
              )
            }
          >
            <option value="">
              {loadingCollaborators ? t("dialog.loadingCollaborators") : t("dialog.pleaseChoose")}
            </option>
            {collaborators.map((member) => (
              <option key={member.id} value={member.id}>
                {member.display_name}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <PersonPicker select={setTarget} />
      )}
      {target && (
        <p>
          {t("dialog.newOwner", { name: "" })}
          <UserBadge id={target.id} name={target.display_name} />
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={retain}
          onChange={(e) => setRetain(e.target.checked)}
        />
        {t("dialog.keepAdmin")}
      </label>
      {error && <Feedback message={error} tone="error" />}
      <footer>
        <button onClick={close}>{t("common.cancel")}</button>
        <button
          className="primary"
          disabled={busy || !target || target.id === resource.owner_id}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/resources/${resource.id}/transfer`, "POST", {
                version: resource.version,
                userId: target!.id,
                retainAccess: retain,
              });
              await saved();
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : t("dialog.transferFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("dialog.confirmTransfer")}
        </button>
      </footer>
    </Dialog>
  );
}
export function MoveDialog({
  resource,
  targets,
  close,
  saved,
}: {
  resource: Resource;
  targets: Resource[];
  close: () => void;
  saved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"subtree" | "current">("subtree"),
    [destination, setDestination] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("dialog.move")} close={close}>
      <fieldset>
        <legend>{t("dialog.moveMode")}</legend>
        <label>
          <input
            type="radio"
            name="document-move-mode"
            checked={mode === "subtree"}
            onChange={() => setMode("subtree")}
          />
          {t("dialog.moveTree")}
        </label>
        <label>
          <input
            type="radio"
            name="document-move-mode"
            checked={mode === "current"}
            onChange={() => setMode("current")}
          />
          {t("dialog.copyOne")}
        </label>
      </fieldset>
      <p className="warning">
        {mode === "subtree" ? t("dialog.moveTreeHint") : t("dialog.copyOneHint")}
      </p>
      <label>
        {t("dialog.destination")}
        <Select
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="">{t("dialog.chooseDestination")}</option>
          {(mode === "current" || resource.library_id) && (
            <option value="__personal__">{t("search.locationPersonal")}</option>
          )}
          {targets
            .filter((r) => r.id !== resource.id && !r.deleted_at)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.kind === "library" ? t("shell.kind.library") : t("shell.type.rich")} · {r.title}
              </option>
            ))}
        </Select>
      </label>
      <p className="subtle">{t("discovery.moveHelp")}</p>
      {error && <Feedback message={error} tone="error" />}
      <footer>
        <button onClick={close}>{t("common.cancel")}</button>
        <button
          className="primary"
          disabled={busy || !destination}
          onClick={async () => {
            setBusy(true);
            const target = targets.find((r) => r.id === destination);
            try {
              const parentId =
                  target?.kind === "document" ? target.id : null,
                libraryId =
                  destination === "__personal__"
                    ? null
                    : target?.kind === "library"
                    ? target.id
                    : (target?.library_id ?? null);
              if (mode === "subtree") {
                await api(`/resources/${resource.id}/move`, "POST", {
                  version: resource.version,
                  parentId,
                  libraryId,
                });
                await saved();
              } else {
                const copied = await api<{ id: string }>(
                  `/resources/${resource.id}/copy`,
                  "POST",
                  { parentId, libraryId, includeChildren: false },
                );
                await saved();
                close();
                location.hash = `/r/${copied.id}`;
                return;
              }
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : t("dialog.failed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("dialog.confirmMove")}
        </button>
      </footer>
    </Dialog>
  );
}
