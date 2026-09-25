import { useI18n } from "@web/shared/i18n.js";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { UserBadge } from "@web/shared/components/user-badge.js";
export function PersonPicker({
  select,
  selected,
  clear,
  actions,
  autoFocus = false,
}: {
  select: (u: { id: string; display_name: string }) => void;
  selected?: { id: string; display_name: string } | null;
  clear?: () => void;
  actions?: ReactNode;
  autoFocus?: boolean;
}) {
const { t } = useI18n();

  const [q, setQ] = useState(""),
    [items, setItems] = useState<
      { id: string; display_name: string; public_id?: string }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    setItems([]);
    setError("");
    if (q.trim().length < 2) return;
    const c = new AbortController();
    const timer = setTimeout(() => {
      void api<{ items: typeof items }>(
        `/users/lookup?q=${encodeURIComponent(q.trim())}`,
        "GET",
        undefined,
        c.signal,
      )
        .then((d) => {
          setItems(d.items);
          setError(d.items.length ? "" : "没有找到用户");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [q]);
  return (
    <div
      className={"person-picker" + (actions ? " person-picker-compact" : "")}
    >
      <div className="inline">
        {selected ? (
          <span className="person-picked">
            <UserBadge passive id={selected.id} name={selected.display_name} />
            <button type="button" aria-label="重新选择协作者" onClick={clear}>
              ×
            </button>
          </span>
        ) : (
          <input
            autoFocus={autoFocus}
            aria-label="查找用户"
            placeholder={
              actions ? "搜索用户名或昵称" : "输入至少2个字，或完整账号"
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        )}
        {actions ?? (
          <button
            type="button"
            disabled={q.trim().length < 2}
            onClick={() =>
              void api<{ items: typeof items }>(
                `/users/lookup?q=${encodeURIComponent(q.trim())}`,
              )
                .then((d) => {
                  setItems(d.items);
                  setError(d.items.length ? "" : "没有找到用户");
                })
                .catch((e) => setError(e.message))
            }
          >
            查找
          </button>
        )}
      </div>
      {error && <Feedback message={error} tone="error" />}
      {!!items.length && (
        <div className="person-picker-results">
          {items.map((u) => (
            <button
              className="person-result"
              type="button"
              key={u.id}
              onClick={() => {
                select(u);
                setItems([]);
                setQ("");
              }}
            >
              <UserBadge passive id={u.id} name={u.display_name} />
              <small>@{u.public_id ?? u.id}</small>
              <span className="person-select-hint">{t("fileManager.select")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
