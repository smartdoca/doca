import { useEffect, useState } from "react";
import { Select } from "antd";
import { api } from "@web/shared/api.js";
export type SearchOwner = { id: string; display_name: string };
export function SearchOwnerFilter({
  value,
  onChange,
}: {
  value: SearchOwner[];
  onChange: (value: SearchOwner[]) => void;
}) {
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
      aria-label="文档所有者"
      placeholder="搜索姓名或账号"
      value={value.map((u) => u.id)}
      filterOption={false}
      loading={loading}
      onSearch={setQ}
      maxCount={10}
      maxTagCount="responsive"
      getPopupContainer={(trigger) => trigger.parentElement!}
      notFoundContent={
        loading
          ? "正在查找…"
          : error ||
            (q.trim().length < 2 ? "输入至少 2 个字查找用户" : "没有找到用户")
      }
      options={options.map((u) => ({ value: u.id, label: u.display_name }))}
      onChange={(ids: string[]) =>
        onChange(options.filter((u) => ids.includes(u.id)))
      }
    />
  );
}
