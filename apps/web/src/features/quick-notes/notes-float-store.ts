import { useEffect, useSyncExternalStore } from "react";
import {
  normalizeNotesFloat,
  notesFloatDefaults,
  type NotesFloatState,
} from "@core/modules/page-state.js";
import { readPageState, writePageState } from "@web/features/page-state/client.js";

export const notesFloatKey = "ui.notesFloat";

let ownerId = "";
let state: NotesFloatState = { ...notesFloatDefaults };
let version = 0;
let ready = false;
let loadGeneration = 0;
let localWrites = 0;
const listeners = new Set<() => void>();
let pageListener: ((event: Event) => void) | null = null;
let subscribers = 0;
let writeQueue = Promise.resolve();

function emit() {
  for (const listener of listeners) listener();
}

function apply(next: NotesFloatState, nextVersion = version) {
  state = next;
  version = nextVersion;
  emit();
}

function onPageState(event: Event) {
  const detail = (event as CustomEvent<{ key?: string; value?: unknown; version?: number }>).detail;
  if (detail?.key !== notesFloatKey) return;
  apply(normalizeNotesFloat(detail.value), typeof detail.version === "number" ? detail.version : version);
}

function ensure(owner: string) {
  if (!pageListener) {
    pageListener = onPageState;
    window.addEventListener("doca-page-state", pageListener);
  }
  if (ownerId === owner && (ready || loadGeneration > 0)) return;
  ownerId = owner;
  ready = false;
  localWrites = 0;
  state = { ...notesFloatDefaults };
  version = 0;
  emit();
  const generation = ++loadGeneration;
  void readPageState<unknown>(notesFloatKey)
    .then((item) => {
      if (generation !== loadGeneration || ownerId !== owner || localWrites > 0) {
        ready = true;
        return;
      }
      ready = true;
      if (item) apply(normalizeNotesFloat(item.value), item.version);
      else emit();
    })
    .catch(() => {
      if (generation === loadGeneration && ownerId === owner) ready = true;
    });
}

export function useNotesFloat(owner: string) {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  useEffect(() => {
    subscribers += 1;
    ensure(owner);
    return () => {
      subscribers -= 1;
      if (subscribers > 0) return;
      if (pageListener) window.removeEventListener("doca-page-state", pageListener);
      pageListener = null;
      ownerId = "";
      ready = false;
      loadGeneration += 1;
    };
  }, [owner]);
  const patch = (partial: Partial<NotesFloatState>) => {
    const next = normalizeNotesFloat({ ...state, ...partial });
    localWrites += 1;
    apply(next, version);
    const snapshot = next;
    writeQueue = writeQueue
      .then(async () => {
        const item = await writePageState(notesFloatKey, snapshot, version);
        if (item && ownerId === owner) version = item.version;
      })
      .catch(() => undefined);
  };
  return { state: snapshot, patch };
}

export function placeNotesFloat(
  value: NotesFloatState,
  viewport: { width: number; height: number },
  collapsed = value.collapsed,
) {
  const width = Math.min(Math.max(280, value.width), Math.min(960, Math.max(280, viewport.width - 16)));
  const height = Math.min(Math.max(320, value.height), Math.min(960, Math.max(320, viewport.height - 16)));
  const reserve = collapsed ? 160 : Math.min(width, 120);
  return {
    ...value,
    width,
    height,
    x: Math.min(Math.max(8, value.x), Math.max(8, viewport.width - reserve)),
    y: Math.min(Math.max(8, value.y), Math.max(8, viewport.height - 48)),
  };
}
