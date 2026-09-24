import { useEffect, useId, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, Info, TriangleAlert, CircleAlert, X } from "lucide-react";
import "@web/shared/components/feedback.css";

export type FeedbackTone = "info" | "success" | "warning" | "error";
type Item = { id: string; message: string; tone: FeedbackTone };
let items: Item[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const remove = (id: string) => {
  items = items.filter((x) => x.id !== id);
  emit();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const snapshot = () => items;
export function notifyFeedback(message: string, tone: FeedbackTone = "info") {
  const id = crypto.randomUUID();
  items = [...items, { id, message, tone }];
  emit();
  if (tone === "info" || tone === "success") setTimeout(() => remove(id), 6000);
}

/** Transient operation feedback lives outside page layout. Critical recovery UI
 * and explanatory warnings should stay inline instead of being converted here. */
export function Feedback({
  message,
  tone = "info",
}: {
  message?: string | null;
  tone?: FeedbackTone;
}) {
  const id = useId();
  useEffect(() => {
    if (!message?.trim()) return;
    items = [...items.filter((x) => x.id !== id), { id, message, tone }];
    emit();
    const timer =
      tone === "info" || tone === "success"
        ? setTimeout(() => remove(id), 5000)
        : undefined;
    return () => {
      clearTimeout(timer);
      remove(id);
    };
  }, [id, message, tone]);
  return null;
}
export function FeedbackViewport() {
  const notices = useSyncExternalStore(subscribe, snapshot);
  return createPortal(
    <section className="feedback-stack" aria-label="操作反馈">
      {notices.map((item) => {
        const Icon = {
          info: Info,
          success: CircleCheck,
          warning: TriangleAlert,
          error: CircleAlert,
        }[item.tone];
        return (
          <div
            key={item.id}
            className={`feedback-toast feedback-${item.tone}`}
            role={
              item.tone === "error" || item.tone === "warning"
                ? "alert"
                : "status"
            }
          >
            <Icon size={18} aria-hidden="true" />
            <span>{item.message}</span>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => remove(item.id)}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </section>,
    document.body,
  );
}
