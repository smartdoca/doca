// Fixed document-count bands keep the sidebar and every month comparable.
export const activityHeatLevels = [
  { className: "idle", label: "无操作" },
  { className: "read", label: "仅阅读" },
  { className: "edited-1", label: "1 篇" },
  { className: "edited-2", label: "2–3 篇" },
  { className: "edited-3", label: "4–6 篇" },
  { className: "edited-4", label: "7 篇及以上" },
] as const;

export function activityHeatLevel(read: number, edited: number): string {
  if (edited >= 7) return "edited-4";
  if (edited >= 4) return "edited-3";
  if (edited >= 2) return "edited-2";
  if (edited >= 1) return "edited-1";
  return read > 0 ? "read" : "idle";
}
