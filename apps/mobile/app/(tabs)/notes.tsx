import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { RefreshControl, StyleSheet, View } from "react-native";
import { FAB, List } from "react-native-paper";
import { api, uuid } from "../../src/api";
import { useAuth } from "../../src/auth";
import { EmptyState, LoadingState, colors } from "../../src/chrome";
import { relativeTime } from "../../src/format";
import { notePreview, type QuickNote } from "../../src/notes";
import { usePull } from "../../src/query-cache";

export default function Notes() {
  const router = useRouter();
  const { session } = useAuth();
  const query = useQuery({
    queryKey: ["notes", session?.origin],
    enabled: !!session,
    queryFn: () => api<{ items: QuickNote[] }>("/quick-notes"),
  });
  const pull = usePull(() => query.refetch());
  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  return (
    <View style={styles.page}>
      <FlashList
        data={query.data?.items ?? []}
        estimatedItemSize={72}
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
        ListEmptyComponent={<EmptyState title="还没有随手记" detail="点右下角记一条" />}
        renderItem={({ item }) => (
          <List.Item
            title={notePreview(item) || "空白记录"}
            titleNumberOfLines={2}
            description={relativeTime(item.updated_at)}
            titleStyle={styles.title}
            descriptionStyle={styles.description}
            style={styles.row}
            onPress={() => router.push({ pathname: "/note/[id]", params: { id: item.id } })}
          />
        )}
      />
      <FAB
        icon="plus"
        style={styles.fab}
        color="#fff"
        onPress={() => router.push({ pathname: "/note/[id]", params: { id: uuid(), fresh: "1" } })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.lineSoft },
  title: { color: colors.ink, fontSize: 16, lineHeight: 22 },
  description: { color: colors.muted },
  fab: { position: "absolute", right: 16, bottom: 16, backgroundColor: colors.accent },
});
