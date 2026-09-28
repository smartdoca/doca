export function relativeTime(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const delta = Date.now() - time;
  const minute = 60_000;
  if (delta < minute) return "刚刚";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`;
  return new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
