/** Bound identical failures without blocking a corrected call or a successful retry. */
export function createToolFailureGuard(limit = 3) {
  const failures = new Map<string, number>();
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "undefined";
  };
  return (tool: string, args: unknown, failed: boolean) => {
    const key = `${tool}:${stable(args)}`;
    if (!failed) {
      failures.delete(key);
      return false;
    }
    const count = (failures.get(key) ?? 0) + 1;
    failures.set(key, count);
    return count >= limit;
  };
}
