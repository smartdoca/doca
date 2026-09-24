import { api } from "@web/shared/api.js";

export type PageStateItem<T> = {
  key: string;
  value: T;
  version: number;
  updatedAt: string;
};

export async function readPageState<T>(key: string) {
  const result = await api<{ item: PageStateItem<T> | null }>(
    `/me/page-state?key=${encodeURIComponent(key)}`,
  );
  return result.item;
}

export async function writePageState<T>(key: string, value: T, version = 0) {
  const first = await api<{ item: PageStateItem<T> | null; conflict: boolean }>(
    "/me/page-state",
    "PUT",
    { key, value, version },
  );
  if (!first.conflict) return first.item;
  return (await api<{ item: PageStateItem<T> | null; conflict: boolean }>(
    "/me/page-state",
    "PUT",
    { key, value, version: first.item?.version ?? 0 },
  )).item;
}

export async function clearPageState(key: string) {
  await api(`/me/page-state?key=${encodeURIComponent(key)}`, "DELETE");
}
