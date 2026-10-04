// Leave room under the server's four concurrent asset uploads for other tabs.
const MAX_CONCURRENT_UPLOADS = 2;
const waiting: { start: () => void }[] = [];
let active = 0;

export function runAssetUpload<T>(
  upload: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abortReason = () =>
      signal?.reason ?? new DOMException("Upload cancelled", "AbortError");
    if (signal?.aborted) {
      reject(abortReason());
      return;
    }
    const abort = () => {
      const index = waiting.indexOf(entry);
      if (index < 0) return;
      waiting.splice(index, 1);
      reject(abortReason());
    };
    const entry = {
      start: () => {
        signal?.removeEventListener("abort", abort);
        active++;
        void Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return upload();
          })
          .then(resolve, reject)
          .finally(() => {
            active--;
            waiting.shift()?.start();
          });
      },
    };
    if (active < MAX_CONCURRENT_UPLOADS) entry.start();
    else {
      waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}
