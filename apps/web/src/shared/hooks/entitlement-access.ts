import { useSyncExternalStore } from "react";
import { api } from "@web/shared/api.js";
const listeners = new Set<() => void>();
let state: Record<string, boolean> = {},
  pending: Promise<void> | undefined,
  timer: ReturnType<typeof setInterval> | undefined;
const notify = () => listeners.forEach((f) => f());
const refresh = () => {
  if (pending) return;
  pending = api<{ can: Record<string, boolean> }>("/me/entitlements")
    .then((r) => {
      state = r.can;
      notify();
    })
    .catch(() => {
      state = {};
      notify();
    })
    .finally(() => {
      pending = undefined;
    });
};
const reset = () => {
  state = {};
  notify();
  refresh();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    window.addEventListener("entitlements-updated", reset);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("entitlements-updated", reset);
    }
  };
}
/** Shared UI hints; every write is still checked against current server policy. */
export function useEntitlements() {
  const can = useSyncExternalStore(subscribe, () => state);
  return (key: string) => can[key] === true;
}
