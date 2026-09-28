import type { Actor } from "../identity/passwords.js";
/** Bounded best-effort telemetry. Explicit entry intent never goes through this buffer. */
export function createVisitBuffer(
  persist: (actor: Actor, resourceId: string, stamp: Date) => Promise<unknown>,
  interval = 2000,
) {
  const pending = new Map<
    string,
    { actor: Actor; resourceId: string; stamp: Date }
  >();
  let flushing = Promise.resolve(),
    closed = false;
  function record(actor: Actor, resourceId: string, stamp = new Date()) {
    if (closed) return;
    const key = actor.id + ":" + resourceId,
      previous = pending.get(key);
    if (previous && previous.stamp >= stamp) return;
    if (!previous && pending.size >= 10000)
      pending.delete(pending.keys().next().value!);
    pending.set(key, { actor, resourceId, stamp });
  }
  function flush(userId?: string) {
    flushing = flushing.then(async () => {
      const batch = [...pending.entries()].filter(
        ([, item]) => !userId || item.actor.id === userId,
      );
      for (const [key, item] of batch) {
        if (pending.get(key) === item) pending.delete(key);
        try {
          await persist(item.actor, item.resourceId, item.stamp);
        } catch {
          /* Revoked/deleted resources and transient telemetry failures can be dropped. */
        }
      }
    });
    return flushing;
  }
  const timer = setInterval(() => {
    if (pending.size) void flush();
  }, interval);
  timer.unref();
  return {
    record,
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      await flush();
    },
  };
}
