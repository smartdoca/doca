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
          <button className="icon" aria-label="关闭" onClick={close}>
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
      .catch((e) => setError(e instanceof Error ? e.message : "无法读取协作者"))
      .finally(() => setLoadingCollaborators(false));
  }, [personal, resource.id, resource.owner_id]);
  return (
    <Dialog title="转移所有权" close={close}>
      <p>
        转移后，对方将成为所有者。个人文档只能转给当前文档的协作者。
      </p>
      {personal ? (
        <label>
          选择协作者
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
              {loadingCollaborators ? "正在加载协作者…" : "请选择"}
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
          新的所有者：
          <UserBadge id={target.id} name={target.display_name} />
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={retain}
          onChange={(e) => setRetain(e.target.checked)}
        />
        为我保留直接管理权限
      </label>
      {error && <Feedback message={error} tone="error" />}
      <footer>
        <button onClick={close}>取消</button>
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
              setError(e instanceof Error ? e.message : "转移失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          确认转移
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
  const [mode, setMode] = useState<"subtree" | "current">("subtree"),
    [destination, setDestination] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title="迁移文档" close={close}>
      <fieldset>
        <legend>迁移方式</legend>
        <label>
          <input
            type="radio"
            name="document-move-mode"
            checked={mode === "subtree"}
            onChange={() => setMode("subtree")}
          />
          迁移当前文档及全部子文档
        </label>
        <label>
          <input
            type="radio"
            name="document-move-mode"
            checked={mode === "current"}
            onChange={() => setMode("current")}
          />
          只复制当前文档
        </label>
      </fieldset>
      <p className="warning">
        {mode === "subtree"
          ? "带子文档迁出需要你拥有当前文档及全部子文档，并拥有它们的管理权限。"
          : "只复制当前文档只需要当前文档的管理权限，子文档不会被复制。"}
      </p>
      <label>
        目标目录
        <Select
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="">请选择目标位置</option>
          {(mode === "current" || resource.library_id) && (
            <option value="__personal__">个人文档</option>
          )}
          {targets
            .filter((r) => r.id !== resource.id && !r.deleted_at)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.kind === "library" ? "知识库" : "文档"} · {r.title}
              </option>
            ))}
        </Select>
      </label>
      {error && <Feedback message={error} tone="error" />}
      <footer>
        <button onClick={close}>取消</button>
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
              setError(e instanceof Error ? e.message : "操作失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          确认移动并重置权限
        </button>
      </footer>
    </Dialog>
  );
}
