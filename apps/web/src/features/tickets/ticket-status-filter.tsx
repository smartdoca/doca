import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

const options = [
  ["pending", "处理中"],
  ["completed", "已完成"],
  ["rejected", "已拒绝"],
  ["cancelled", "已撤销"],
  ["expired", "已过期"],
] as const;

export function TicketStatusFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
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
      ? "全部状态"
      : value.length === 1
        ? options.find(([key]) => key === value[0])?.[1]
        : `已选 ${value.length} 种状态`;
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
        aria-label={`工单状态：${label}`}
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
          aria-label="工单状态（可多选）"
        >
          <div className="ticket-status-menu-heading">
            <span>状态 · 可多选</span>
            <button type="button" onClick={() => onChange([])}>
              清空
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
              {name}
            </label>
          ))}
          <small>不选择时显示全部状态</small>
        </div>
      )}
    </div>
  );
}
