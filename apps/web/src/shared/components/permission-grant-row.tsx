import { useRef, useState, type ReactNode } from "react";
import { Popover } from "antd";
import { Select } from "@web/shared/components/select.js";
import "./permission-grant-row.css";
import { Info, Trash2 } from "lucide-react";
import { useI18n } from "@web/shared/i18n.js";

export function PermissionRemoveButton({
  name,
  disabled = false,
  reason,
  confirm,
  description,
  label,
}: {
  name: string;
  disabled?: boolean;
  reason?: string;
  confirm: () => Promise<boolean>;
  description?: string;
  label?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  function dismiss() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <Popover
      open={open}
      trigger="click"
      destroyOnHidden
      placement="topRight"
      autoAdjustOverflow
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
      afterOpenChange={(visible) => {
        if (visible) cancel.current?.focus();
      }}
      content={
        <div
          className="permission-remove-confirm"
          data-permissions-popup="true"
          role="alertdialog"
          aria-label={t("permissionsUi.removeAuthorization")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (!pending) dismiss();
            }
          }}
        >
          <p>
            {description ??
              t("permissionsUi.removeAuthorizationConfirm", { name })}
          </p>
          <div className="permission-remove-confirm-actions">
            <button
              ref={cancel}
              type="button"
              disabled={pending}
              onClick={dismiss}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="permission-remove-confirm-submit"
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  if (await confirm()) dismiss();
                } finally {
                  setPending(false);
                }
              }}
            >
              {t("permissionsUi.confirmRevoke")}
            </button>
          </div>
        </div>
      }
    >
      <button
        ref={trigger}
        className="icon permission-grant-remove"
        type="button"
        disabled={disabled || pending}
        aria-label={label ?? t("permissionsUi.removePerson", { name })}
        title={reason ?? t("permissionsUi.removeAuthorization")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Trash2 size={16} />
      </button>
    </Popover>
  );
}

export function permissionRoleChoices(
  owner = false,
  kind: "resource" | "folder" = "resource",
): string[] {
  return kind === "folder"
    ? ["reader", ...(owner ? ["admin"] : [])]
    : ["reader", "commenter", "editor", ...(owner ? ["manager"] : [])];
}

export type PermissionRoleOption = { value: string; label: string };
export type PermissionRemoveAction = Parameters<
  typeof PermissionRemoveButton
>[0];

export function PermissionEffectiveAccess({ role }: { role: string }) {
  const { t } = useI18n();
  const parts = t("permissionsUi.effectiveAccess", { role: "{role}" }).split(
    /(\{role\})/,
  );
  return (
    <small className="permission-effective-access">
      {parts.map((part, index) =>
        part === "{role}" ? <strong key={index}>{role}</strong> : part,
      )}
    </small>
  );
}

/** Resource adapters provide identities, role choices and mutations; this component owns the interaction. */
export function PermissionGrantRow({
  identity,
  subtitle,
  details,
  permission,
  sources,
  remove,
  scope,
  className = "",
}: {
  identity: ReactNode;
  subtitle?: ReactNode;
  details?: ReactNode;
  permission: {
    value: string;
    label: string;
    ariaLabel?: string;
    reason?: string;
    disabled?: boolean;
  } & (
    | {
        options: PermissionRoleOption[] | undefined;
        change: (role: string) => void;
      }
    | { options?: never; change?: never }
  );
  sources?: { name: string; open: () => void; disabled?: boolean };
  remove?: PermissionRemoveAction;
  scope?: {
    checked: boolean;
    disabled?: boolean;
    change: (checked: boolean) => void;
  };
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`permissions-member permission-grant-row ${className}`}>
      <div className="permission-grant-identity">{identity}</div>
      <div className="permission-grant-controls">
        {sources && (
          <button
            className="icon permission-grant-source"
            type="button"
            title={t("permissionsUi.viewSources")}
            disabled={sources.disabled}
            aria-label={t("permissionsUi.sourcesFor", { name: sources.name })}
            onClick={sources.open}
          >
            <Info size={15} />
          </button>
        )}
        <div className="permission-grant-role" title={permission.reason}>
          {permission.options ? (
            <Select
              value={permission.value}
              disabled={permission.disabled}
              aria-label={permission.ariaLabel}
              onChange={(event) => permission.change?.(event.target.value)}
            >
              {permission.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <span className="permission-grant-role-label">
              {permission.label}
            </span>
          )}
        </div>
        {remove ? (
          <PermissionRemoveButton {...remove} />
        ) : (
          <span
            className="permission-grant-action-placeholder"
            aria-hidden="true"
          />
        )}
      </div>
      {!!(subtitle || details || scope) && (
        <div className="permission-grant-secondary">
          <div className="permission-grant-metadata">
            {subtitle && (
              <span className="permission-grant-subtitle">{subtitle}</span>
            )}
            {details && (
              <div className="permission-grant-details">{details}</div>
            )}
          </div>
          {scope && (
            <div className="permission-grant-scope">
              <label className="permissions-check">
                <input
                  type="checkbox"
                  checked={scope.checked}
                  disabled={scope.disabled}
                  onChange={(event) => scope.change(event.target.checked)}
                />
                {t("role.scope.descendants")}
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
