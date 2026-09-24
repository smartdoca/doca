import { useState } from "react";
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import * as FileSystem from "expo-file-system";

const file = () => (FileSystem.documentDirectory ? FileSystem.documentDirectory + "doca-query-cache.json" : null);
const maxAge = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      gcTime: maxAge,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export async function restoreQueryCache() {
  const path = file();
  if (!path) return;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return;
    const saved = JSON.parse(await FileSystem.readAsStringAsync(path)) as {
      timestamp?: number;
      clientState?: unknown;
    };
    if (!saved.timestamp || Date.now() - saved.timestamp > maxAge || !saved.clientState) return;
    hydrate(queryClient, saved.clientState as never);
  } catch {
    // A damaged cache should not block the next launch.
  }
}

export function persistQueryCache() {
  const path = file();
  if (!path) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    const clientState = dehydrate(queryClient, {
      shouldDehydrateQuery: (query) => query.state.status === "success",
    });
    void FileSystem.writeAsStringAsync(path, JSON.stringify({ timestamp: Date.now(), clientState })).catch(() => undefined);
  };
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

export async function clearQueryCache() {
  queryClient.clear();
  const path = file();
  if (!path) return;
  await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
}

export function usePull(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  return {
    refreshing,
    onRefresh: () => {
      setRefreshing(true);
      void refetch().finally(() => setRefreshing(false));
    },
  };
}
