import { useId, useRef } from "react";

export function SettingsTabs({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: [string, string][];
}) {
  const root = useRef<HTMLElement>(null),
    id = useId();
  return (
    <div className="settings-tabs-column">
      <nav
        ref={root}
        className="platform-settings-tabs admin-settings-tabs"
        role="tablist"
        aria-label={label}
      >
        {items.map(([key, text], index) => (
          <button
            type="button"
            key={key}
            role="tab"
            id={`${id}-${key}`}
            aria-selected={key === value}
            tabIndex={key === value ? 0 : -1}
            className={key === value ? "active" : ""}
            onClick={() => onChange(key)}
            onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                return;
              e.preventDefault();
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? items.length - 1
                    : (index + (e.key === "ArrowRight" ? 1 : -1) + items.length) %
                      items.length;
              onChange(items[next]![0]);
              root.current
                ?.querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus();
            }}
          >
            {text}
          </button>
        ))}
      </nav>
    </div>
  );
}
