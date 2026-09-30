import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MessageKey } from "@doca/i18n";
import { useI18n } from "@web/shared/i18n.js";

const options = [
  ["pending", "ticket.pending"],
  ["completed", "ticket.completed"],
  ["rejected", "ticket.rejected"],
  ["cancelled", "ticket.cancelled"],
  ["expired", "ticket.expired"],
] as const satisfies readonly (readonly [string, MessageKey])[];

export function TicketStatusFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const label =
    value.length === 0 || value.length === options.length
      ? t("ticket.statusAll")
      : value.length === 1
        ? t(options.find(([key]) => key === value[0])?.[1] ?? "ticket.statusAll")
        : t("ticket.statusCount", { count: value.length });
  return (
    <div
      className="ticket-status-filter"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        aria-label={t("ticket.statusLabel", { label })}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="ticket-status-menu"
          id={id}
          role="group"
          aria-label={t("ticket.statusMulti")}
        >
          <div className="ticket-status-menu-heading">
            <span>{t("ticket.statusHeading")}</span>
            <button type="button" onClick={() => onChange([])}>
              {t("common.clearSelection")}
            </button>
          </div>
          {options.map(([key, name]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={value.includes(key)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, key]
                      : value.filter((s) => s !== key),
                  )
                }
              />
              {t(name)}
            </label>
          ))}
          <small>{t("ticket.statusHint")}</small>
        </div>
      )}
    </div>
  );
}
