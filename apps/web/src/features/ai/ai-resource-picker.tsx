import { Alert, Empty, Input } from "antd";
import { useEffect, useState } from "react";
import { api, type Resource } from "@web/shared/api.js";

export function AIResourcePicker({
  selected,
  change,
}: {
  selected: { resourceId: string; label?: string }[];
  change: (items: { resourceId: string; label: string }[]) => void;
}) {
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<Resource[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ items: Resource[] }>(
        `/resources?scope=all&q=${encodeURIComponent(query)}`,
        "GET",
        undefined,
        controller.signal,
      )
        .then((r) => {
          setItems(r.items);
          setError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <div className="ai-resource-picker">
      <Input
        aria-label="查找知识库或文档"
        placeholder="搜索知识库或文档名称"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <Alert type="error" title={error} />}
      <div>
        {!items.length && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无匹配的文档"
          />
        )}
        {items.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={selected.some((s) => s.resourceId === r.id)}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [
                        ...selected.map((s) => ({
                          ...s,
                          label: s.label ?? "文档",
                        })),
                        { resourceId: r.id, label: r.title },
                      ]
                    : selected
                        .filter((s) => s.resourceId !== r.id)
                        .map((s) => ({ ...s, label: s.label ?? "文档" })),
                )
              }
            />
            {r.kind === "library" ? "知识库" : "文档"} · {r.title}
          </label>
        ))}
      </div>
      <small>已选择 {selected.length} 项 。仅能使用你当前有权限的内容。</small>
    </div>
  );
}
