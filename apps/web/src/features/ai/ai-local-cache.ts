const DB_NAME = "doca-ai-cache-v1";
const CONVERSATIONS = "conversations";
const LISTS = "lists";

type StoreName = typeof CONVERSATIONS | typeof LISTS;

function openCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS))
        db.createObjectStore(CONVERSATIONS);
      if (!db.objectStoreNames.contains(LISTS)) db.createObjectStore(LISTS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  work: (objectStore: IDBObjectStore) => IDBRequest<T>,
) {
  return openCache().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("本地缓存失败"));
        };
      }),
  );
}

export function conversationCacheKey(userId: string, sessionId: string) {
  return `${userId}:${sessionId}`;
}

export function sessionListCacheKey(userId: string, resourceId?: string | null) {
  return `${userId}:sessions:${resourceId ?? "all"}`;
}

export function readCached<T>(store: StoreName, key: string) {
  return run<T | undefined>(store, "readonly", (objectStore) =>
    objectStore.get(key),
  ).catch(() => undefined);
}

export function writeCached(store: StoreName, key: string, value: unknown) {
  return run(store, "readwrite", (objectStore) =>
    objectStore.put(value, key),
  ).catch(() => undefined);
}

export function readConversationCache<T>(userId: string, sessionId: string) {
  return readCached<T>(CONVERSATIONS, conversationCacheKey(userId, sessionId));
}

export function writeConversationCache(
  userId: string,
  sessionId: string,
  value: unknown,
) {
  return writeCached(
    CONVERSATIONS,
    conversationCacheKey(userId, sessionId),
    value,
  );
}

export function readSessionListCache<T>(
  userId: string,
  resourceId?: string | null,
) {
  return readCached<T>(LISTS, sessionListCacheKey(userId, resourceId));
}

export function writeSessionListCache(
  userId: string,
  resourceId: string | null | undefined,
  value: unknown,
) {
  return writeCached(LISTS, sessionListCacheKey(userId, resourceId), value);
}
