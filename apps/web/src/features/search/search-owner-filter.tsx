import { useEffect, useState } from "react";
import { Select } from "antd";
import { api } from "@web/shared/api.js";
import { useI18n } from "@web/shared/i18n.js";
export type SearchOwner = { id: string; display_name: string };
export function SearchOwnerFilter({
  value,
  onChange,
}: {
  value: SearchOwner[];
  onChange: (value: SearchOwner[]) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchOwner[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setItems([]);
    setError("");
    setLoading(false);
    if (q.trim().length < 2) return () => c.abort();
    setLoading(true);
    const timer = setTimeout(() => {
      void api<{ items: SearchOwner[] }>(
        "/users/lookup?q=" + encodeURIComponent(q.trim()),
        "GET",
        undefined,
        c.signal,
      )
        .then((r) => {
          if (!c.signal.aborted) setItems(r.items);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [q]);
  const options = [
    ...new Map([...value, ...items].map((u) => [u.id, u])).values(),
  ];
  return (
    <Select
      mode="multiple"
      showSearch
      allowClear
      aria-label={t("search.owner")}
      placeholder={t("search.ownerPlaceholder")}
      value={value.map((u) => u.id)}
      filterOption={false}
      loading={loading}
      onSearch={setQ}
      maxCount={10}
      maxTagCount="responsive"
      getPopupContainer={(trigger) => trigger.parentElement!}
      notFoundContent={
        loading
          ? t("search.ownerLooking")
          : error ||
            (q.trim().length < 2 ? t("search.ownerMin") : t("search.ownerNone"))
      }
      options={options.map((u) => ({ value: u.id, label: u.display_name }))}
      onChange={(ids: string[]) =>
        onChange(options.filter((u) => ids.includes(u.id)))
      }
    />
  );
}
