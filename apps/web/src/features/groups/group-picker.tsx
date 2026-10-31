import { useEffect, useRef, useState } from "react";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { GroupAvatar } from "./group-avatar.js";

export type SelectableGroup = {
  id: string;
  name: string;
  avatar: string | null;
  ownerName: string;
};
type Directory = {
  items: SelectableGroup[];
  mode: "member" | "related" | "all";
  nextCursor: string | null;
};
export function GroupPicker({
  selected,
  select,
  clear,
}: {
  selected: SelectableGroup | null;
  select: (group: SelectableGroup) => void;
  clear: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(""),
    [directory, setDirectory] = useState<Directory>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  async function search(cursor?: string) {
    if (!query.trim() || selected) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await api<Directory>(
        `/groups/lookup?q=${encodeURIComponent(query.trim())}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        "GET",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setDirectory((current) => ({
          ...next,
          items: cursor
            ? [...(current?.items ?? []), ...next.items]
            : next.items,
        }));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    request.current?.abort();
    setDirectory(undefined);
    setError("");
    setLoading(false);
    const timer = setTimeout(() => void search(), 300);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [query, selected?.id]);
  return (
    <div className="person-picker group-picker">
      <div className="inline">
        {selected ? (
          <span className="person-picked">
            <GroupAvatar name={selected.name} avatar={selected.avatar} />
            <span className="group-picked-name">{selected.name}</span>
            <button
              type="button"
              aria-label={t("personPicker.reselect")}
              onClick={clear}
            >
              ×
            </button>
          </span>
        ) : (
          <input
            autoFocus
            aria-label={t("groups.search")}
            placeholder={t("groups.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button
          type="button"
          disabled={!query.trim() || loading || !!selected}
          onClick={() => void search()}
        >
          {t("personPicker.find")}
        </button>
      </div>
      {error && <Feedback tone="error" message={error} />}
      {loading && (
        <p className="permissions-empty" role="status">
          {t("groups.loading")}
        </p>
      )}
      {!selected && !!directory?.items.length && (
        <div className="person-picker-results">
          {directory.items.map((group) => (
            <button
              type="button"
              className="person-result group-result"
              key={group.id}
              onClick={() => {
                request.current?.abort();
                select(group);
                setQuery("");
                setDirectory(undefined);
              }}
            >
              <span className="group-picker-identity">
                <GroupAvatar name={group.name} avatar={group.avatar} />
                <span>{group.name}</span>
              </span>
              <small>
                {t("groups.owner")} · {group.ownerName}
              </small>
              <span className="person-select-hint">
                {t("fileManager.select")}
              </span>
            </button>
          ))}
          {directory.nextCursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void search(directory.nextCursor!)}
            >
              {t("common.more")}
            </button>
          )}
        </div>
      )}
      {!selected && !loading && directory && !directory.items.length && (
        <p className="permissions-empty">{t("groups.noSearchResults")}</p>
      )}
      {directory && (
        <p className="group-search-scope">
          {t("groups.searchScope", {
            scope: t(`groups.scope.${directory.mode}`),
          })}
        </p>
      )}
    </div>
  );
}
