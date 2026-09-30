import * as FS from "expo-file-system";
const queues = new Map<string, Promise<unknown>>();
export const component = (value: string) =>
  Array.from(value)
    .map((c) => c.codePointAt(0)!.toString(16).padStart(6, "0"))
    .join("")
    .match(/.{1,120}/g)!
    .join("/");
export function root(origin: string) {
  if (!FS.documentDirectory) throw new Error("Persistent storage unavailable");
  return `${FS.documentDirectory}plugin-content/${component(origin)}/`;
}
export async function exclusive<T>(
  origin: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(origin) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  queues.set(origin, next);
  try {
    return await next;
  } finally {
    if (queues.get(origin) === next) queues.delete(origin);
  }
}
export function clearPluginCache(origin: string) {
  return exclusive(origin, () =>
    FS.deleteAsync(root(origin), { idempotent: true }),
  );
}
