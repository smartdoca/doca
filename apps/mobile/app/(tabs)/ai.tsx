import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { FAB, IconButton, List, Snackbar } from "react-native-paper";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { Card, EmptyState, LoadingState, colors } from "../../src/chrome";
import { relativeTime } from "../../src/format";
import { usePull } from "../../src/query-cache";

type SessionRow = {
  id: string;
  title: string;
  updated_at?: string;
  running?: boolean;
  awaitingApproval?: boolean;
};

type Options = {
  defaultModel: string;
  models: { id: string; name: string }[];
  preferences?: { default_model?: string | null };
};

export default function AI() {
  const router = useRouter();
  const navigation = useNavigation();
  const client = useQueryClient();
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const query = useQuery({
    queryKey: ["ai-sessions", session?.origin],
    enabled: !!session,
    queryFn: async () => {
      const data = await api<SessionRow[] | { items: SessionRow[] }>("/ai/sessions?archived=false");
      return Array.isArray(data) ? data : data.items;
    },
  });
  const pull = usePull(() => query.refetch());
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <IconButton icon="cog-outline" onPress={() => router.push("/ai/settings")} />,
    });
  }, [navigation, router]);

  async function create() {
    if (!session || busy) return;
    setBusy(true);
    try {
      const options = await api<Options>("/ai/options");
      const modelId = options.preferences?.default_model || options.defaultModel || options.models[0]?.id;
      if (!modelId) throw new Error("还没有可用的模型");
      const created = await api<{ id: string; title: string }>("/ai/sessions", {
        body: { title: "新对话", modelId },
      });
      await client.invalidateQueries({ queryKey: ["ai-sessions", session.origin] });
      router.push({ pathname: "/ai/[id]", params: { id: created.id, title: created.title || "新对话" } });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "无法新建对话");
    } finally {
      setBusy(false);
    }
  }

  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  return (
    <View style={styles.page}>
      <FlashList
        data={query.data ?? []}
        estimatedItemSize={84}
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListEmptyComponent={<EmptyState title="还没有对话" detail="点右下角开始新的对话" />}
        renderItem={({ item }) => (
          <Card>
            <List.Item
              title={item.title || "新的对话"}
              titleStyle={{ color: colors.ink }}
              descriptionStyle={{ color: colors.muted }}
              description={
                item.awaitingApproval
                  ? "等待确认"
                  : item.running
                    ? "正在回复"
                    : item.updated_at
                      ? relativeTime(item.updated_at)
                      : ""
              }
              left={(props) => <List.Icon {...props} color={colors.accent} icon="creation" />}
              onPress={() =>
                router.push({ pathname: "/ai/[id]", params: { id: item.id, title: item.title || "对话" } })
              }
            />
          </Card>
        )}
      />
      <FAB icon="plus" style={styles.fab} color="#fff" loading={busy} onPress={() => void create()} />
      <Snackbar visible={!!notice} onDismiss={() => setNotice("")} duration={2800}>
        {notice}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  fab: { position: "absolute", right: 16, bottom: 16, backgroundColor: colors.accent },
});
