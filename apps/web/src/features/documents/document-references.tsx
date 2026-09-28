import { useEffect, useState } from "react";
import { FileText, Link2 } from "lucide-react";
import { api } from "@web/shared/api.js";
import { realtime } from "@web/features/documents/realtime.js";
type References = {
  incoming: { id: string; title: string }[];
  outgoing: { id: string; title: string }[];
};
export function DocumentReferences({ id }: { id: string }) {
  const [data, setData] = useState<References>({ incoming: [], outgoing: [] });
  const [tab, setTab] = useState<keyof References>("outgoing");
  useEffect(() => {
    setData({ incoming: [], outgoing: [] });
    setTab("outgoing");
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void api<References>(`/resources/${id}/references`)
          .then((d) => {
            if (!disposed) setData(d);
          })
          .catch(() => {});
      }, 500);
    };
    load();
    const stop = realtime.subscribe((m) => {
      if (
        m.room === id &&
        ["ack", "update", "document.changed"].includes(m.type)
      )
        load();
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      stop();
    };
  }, [id]);
  if (!data.incoming.length && !data.outgoing.length) return null;
  return (
    <section className="document-reference-lists">
      <div role="tablist" aria-label="文档引用关系">
        {(
          [
            ["outgoing", "本文引用"],
            ["incoming", "引用本文"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            id={`reference-${id}-${key}`}
            aria-controls={`reference-${id}-panel`}
            onClick={() => setTab(key)}
            onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                return;
              e.preventDefault();
              const next =
                e.key === "Home"
                  ? "outgoing"
                  : e.key === "End"
                    ? "incoming"
                    : key === "outgoing"
                      ? "incoming"
                      : "outgoing";
              setTab(next);
              document.getElementById(`reference-${id}-${next}`)?.focus();
            }}
          >
            <Link2 size={15} />
            {label} · {data[key].length}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`reference-${id}-panel`}
        aria-labelledby={`reference-${id}-${tab}`}
        aria-label={tab === "outgoing" ? "本文引用" : "引用本文"}
      >
        {data[tab].map((r) => (
          <a key={r.id} href={`#/r/${r.id}`}>
            <FileText size={15} />
            <span>{r.title}</span>
          </a>
        ))}
        {!data[tab].length && <p className="subtle small">暂无可查看的文档</p>}
      </div>
    </section>
  );
}
