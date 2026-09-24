type Listener = (id: string | null) => void;

let current: string | null = null;
const listeners = new Set<Listener>();

export function getAiSession() {
  return current;
}

export function setAiSession(id: string | null) {
  if (current === id) return;
  current = id;
  for (const listener of listeners) listener(id);
}

export function subscribeAiSession(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
