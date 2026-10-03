/** A view refresh is rearmed only by drawing another visible timed element. */
export function createElementViewRefresh(
  refresh: () => void,
  visible: () => boolean,
) {
  let timer: { id: ReturnType<typeof setTimeout>; due: number } | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer.id);
    timer = null;
  };
  return {
    cancel,
    schedule(interval: number) {
      if (!visible()) return;
      const delay = Math.max(1000, interval),
        due = Date.now() + delay;
      if (timer && timer.due <= due) return;
      cancel();
      timer = {
        due,
        id: setTimeout(() => {
          timer = null;
          if (visible()) refresh();
        }, delay),
      };
    },
  };
}
