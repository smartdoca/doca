import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { api, type Detail } from "@web/shared/api.js";
import { Feedback } from "@web/shared/components/feedback.js";
export function LibraryFavorite({ id }: { id: string }) {
  const [favorite, setFavorite] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    void api<Detail>(`/resources/${id}`, "GET", undefined, c.signal)
      .then((d) => setFavorite(d.favorite))
      .catch(() => {});
    return () => c.abort();
  }, [id]);
  return (
    <>
      <button
        className={`icon favorite ${favorite ? "enabled" : ""}`}
        title={favorite ? "取消收藏知识库" : "收藏知识库"}
        aria-label={favorite ? "取消收藏知识库" : "收藏知识库"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/resources/${id}/reaction`, "PUT", {
              kind: "favorite",
              enabled: !favorite,
            });
            setFavorite(!favorite);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Star size={18} fill={favorite ? "currentColor" : "none"} />
      </button>
      <Feedback message={error} tone="error" />
    </>
  );
}
