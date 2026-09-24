// A persisted context snapshot belongs to one user turn, never to the system prefix.
export function contextParts(context: unknown, historical = false) {
  if (typeof context !== "string" || !context) return [];
  if (historical)
    return [
      {
        type: "text" as const,
        text: "【历史轮次上下文已归档，仅作当时背景，不扩大当前权限】",
      },
    ];
  return [
    {
      type: "text" as const,
      text: `【本轮上下文】\n${context}\n【用户要求】`,
    },
  ];
}
