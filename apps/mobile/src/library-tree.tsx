import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { List } from "react-native-paper";
import { api, formatLabel, type Resource } from "./api";
import { useAuth } from "./auth";
import { EmptyState, LoadingState, colors } from "./chrome";
import { relativeTime } from "./format";
import { usePull } from "./query-cache";

type Row = {
  item: Resource;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
};

export function LibraryTree({ libraryId }: { libraryId: string }) {
  const router = useRouter();
  const { session } = useAuth();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: ["library-tree", session?.origin, libraryId],
    enabled: !!session && !!libraryId,
    queryFn: () =>
      api<{ items: Resource[] }>(
        `/resources?${new URLSearchParams({ scope: "all", libraryId, tree: "true" })}`,
      ),
  });
  const pull = usePull(() => query.refetch());
  const rows = useMemo(() => flatten(query.data?.items ?? [], expanded), [expanded, query.data?.items]);

  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }

  return (
    <View style={styles.page}>
      <FlashList
        data={rows}
        keyExtractor={(item) => item.item.id}
        estimatedItemSize={56}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        ListEmptyComponent={<EmptyState title="这个知识库还没有文档" />}
        renderItem={({ item }) => (
          <View style={[styles.row, { paddingLeft: 8 + item.depth * 18 }]}>
            <List.Item
              style={styles.item}
              title={item.item.title || "未命名"}
              description={`${formatLabel[item.item.format]} · ${relativeTime(item.item.updated_at)}`}
              titleStyle={styles.title}
              descriptionStyle={styles.description}
              onPress={() =>
                router.push({
                  pathname: "/document/[id]",
                  params: { id: item.item.id, title: item.item.title },
                })
              }
            />
            {item.hasChildren ? (
              <Pressable
                style={styles.expand}
                hitSlop={8}
                onPress={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(item.item.id)) next.delete(item.item.id);
                    else next.add(item.item.id);
                    return next;
                  })
                }
              >
                {item.expanded ? (
                  <ChevronDown color={colors.secondary} size={18} />
                ) : (
                  <ChevronRight color={colors.secondary} size={18} />
                )}
              </Pressable>
            ) : (
              <View style={styles.expand} />
            )}
          </View>
        )}
      />
    </View>
  );
}

function flatten(items: Resource[], expanded: Set<string>) {
  const children = new Map<string | null, Resource[]>();
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    const parent = item.parent_id && ids.has(item.parent_id) ? item.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const item of children.get(parent) ?? []) {
      const nested = children.get(item.id) ?? [];
      const open = expanded.has(item.id);
      rows.push({ item, depth, hasChildren: nested.length > 0, expanded: open });
      if (open) walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.lineSoft,
    backgroundColor: "#fff",
  },
  item: { flex: 1, paddingRight: 0 },
  title: { color: colors.ink, fontSize: 16 },
  description: { color: colors.muted },
  expand: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
