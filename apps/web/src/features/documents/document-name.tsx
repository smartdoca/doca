import { useEffect, useRef, useState } from "react";
import { api, type Resource } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
export function DocumentName({
  resource,
  changed,
}: {
  resource: Resource;
  changed(): void;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(resource.title),
    [width, setWidth] = useState<number>(),
    [error, setError] = useState("");
  const saving = useRef(false),
    cancel = useRef(false);
  useEffect(() => {
    if (!editing) setValue(resource.title);
  }, [resource.title, editing]);
  async function save() {
    if (saving.current || cancel.current) return;
    const title = value.trim() || "未命名";
    if (title === resource.title) {
      setEditing(false);
      return;
    }
    saving.current = true;
    try {
      await api(`/resources/${resource.id}`, "PATCH", {
        title,
        version: resource.version,
      });
      setEditing(false);
      changed();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
    }
  }
  return (
    <>
      {editing ? (
        <input
          className="document-name-editor"
          style={{ width }}
          autoFocus
          maxLength={160}
          value={value}
          aria-label="修改文档标题"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              cancel.current = true;
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className="document-title-edit"
          title={resource.title + " · 点击修改标题"}
          onClick={(e) => {
            setWidth(e.currentTarget.getBoundingClientRect().width);
            cancel.current = false;
            setEditing(true);
          }}
        >
          {resource.title}
        </button>
      )}
      <Feedback message={error} tone="error" />
    </>
  );
}
