import { mergeUpdates } from "@smartdoca/slate/yjs";
export type PendingUpdate = { id: string; update: Uint8Array };
export type Replica = {
  checkpoint: Uint8Array;
  pending: PendingUpdate[];
  epochId?: string;
  baseline?: unknown;
};
/** User + deployment(origin-owned IndexedDB) + resource + codec partition. Never stores credentials.
 * A single read-write transaction merges the checkpoint and outbox, including across browser tabs.
 * Only an exact durable server ACK removes a pending operation. */
export async function openReplica(
  userId: string,
  resourceId: string,
  codec = "slatetsx-yjs-v1",
) {
  const key = `${userId}:${resourceId}:${codec}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("doca-offline-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("replicas");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("本地缓存被其他页面占用"));
  });
  db.onversionchange = () => db.close();
  function transaction(change?: (value: Replica) => Replica) {
    return new Promise<Replica>((resolve, reject) => {
      const tx = db.transaction("replicas", change ? "readwrite" : "readonly"),
        store = tx.objectStore("replicas");
      const request = store.get(key);
      let value: Replica;
      request.onsuccess = () => {
        try {
          value = request.result ?? {
            checkpoint: new Uint8Array([0, 0]),
            pending: [],
          };
          if (change) {
            value = change(value);
            store.put(value, key);
          }
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value!);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("本地保存失败"));
    });
  }
  return {
    load: () => transaction(),
    store: (
      update: Uint8Array,
      pending?: PendingUpdate,
      epochId?: string,
      baseline?: unknown,
    ) =>
      transaction((value) => {
        if (epochId && value.epochId && epochId !== value.epochId)
          throw new Error("本地文档版本不匹配");
        return {
          ...value,
          ...(epochId ? { epochId } : {}),
          ...(baseline ? { baseline } : {}),
          checkpoint: mergeUpdates([value.checkpoint, update]),
          pending:
            pending && !value.pending.some((p) => p.id === pending.id)
              ? [...value.pending, pending]
              : value.pending,
        };
      }),
    acknowledge: (id: string) =>
      transaction((value) => ({
        ...value,
        pending: value.pending.filter((p) => p.id !== id),
      })),
    close: () => db.close(),
  };
}
