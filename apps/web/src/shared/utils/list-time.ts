export function listTime(value?: string | null, now = Date.now()) {
  if (!value) return "—";
  const date = new Date(value),
    ms = date.getTime();
  if (!Number.isFinite(ms)) return "—";
  const delta = Math.max(0, now - ms),
    today = new Date(now),
    yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (d: Date) => date.toDateString() === d.toDateString();
  const clock = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (sameDay(today)) {
    if (delta < 60000) return "刚刚";
    if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
    if (delta < 6 * 3600000) return `${Math.floor(delta / 3600000)} 小时前`;
    return `今天 ${clock}`;
  }
  if (sameDay(yesterday)) return `昨天 ${clock}`;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
