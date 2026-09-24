import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { RefreshControl, View } from "react-native";
import { List } from "react-native-paper";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { Card, EmptyState, LoadingState, colors } from "../../src/chrome";
import { usePull } from "../../src/query-cache";

type Mailbox = { id: string; address: string; displayName: string };

export default function Mailboxes() {
  const router = useRouter();
  const { session } = useAuth();
  const query = useQuery({
    queryKey: ["mailboxes", session?.origin],
    enabled: !!session,
    queryFn: () => api<{ mailboxes: Mailbox[] }>("/mail"),
  });
  const pull = usePull(() => query.refetch());
  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <FlashList
      data={query.data?.mailboxes ?? []}
      estimatedItemSize={84}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
      ListEmptyComponent={<EmptyState title="还没有邮箱" />}
      renderItem={({ item }) => (
        <Card>
          <List.Item
            title={item.displayName || item.address}
            description={item.address}
            titleStyle={{ color: colors.ink }}
            descriptionStyle={{ color: colors.muted }}
            left={(props) => <List.Icon {...props} color={colors.accent} icon="email-outline" />}
            onPress={() =>
              router.push({
                pathname: "/mailbox/[id]",
                params: { id: item.id, title: item.displayName || item.address },
              })
            }
          />
        </Card>
      )}
    />
    </View>
  );
}
