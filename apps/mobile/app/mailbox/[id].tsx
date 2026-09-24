import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useLayoutEffect } from "react";
import { RefreshControl, View } from "react-native";
import { List } from "react-native-paper";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { Card, EmptyState, LoadingState, colors } from "../../src/chrome";
import { relativeTime } from "../../src/format";
import { usePull } from "../../src/query-cache";

type Message = {
  id: string;
  subject: string;
  from: { name?: string; email: string };
  snippet: string;
  receivedAt: string;
  unread: boolean;
};

export default function Mailbox() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const { session } = useAuth();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "邮箱" });
  }, [navigation, title]);
  const query = useQuery({
    queryKey: ["mail-messages", session?.origin, id],
    enabled: !!session && !!id,
    queryFn: () => api<{ items: Message[] }>(`/mail/mailboxes/${id}/messages`),
  });
  const pull = usePull(() => query.refetch());
  if (query.isLoading) return <LoadingState />;
  if (query.isError) {
    return <EmptyState title={query.error instanceof Error ? query.error.message : "加载失败"} />;
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
    <FlashList
      data={query.data?.items ?? []}
      estimatedItemSize={92}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={
        <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
      }
      ListEmptyComponent={<EmptyState title="这个邮箱没有邮件" />}
      renderItem={({ item }) => (
        <Card>
          <List.Item
            title={item.subject || "（无主题）"}
            description={`${item.from.name || item.from.email} · ${relativeTime(item.receivedAt)}`}
            titleStyle={item.unread ? { fontWeight: "700", color: colors.ink } : { color: colors.ink }}
            descriptionStyle={{ color: colors.muted }}
            left={(props) => <List.Icon {...props} color={colors.accent} icon={item.unread ? "email" : "email-open-outline"} />}
            onPress={() =>
              router.push({
                pathname: "/message/[mailboxId]/[messageId]",
                params: { mailboxId: id, messageId: item.id, title: item.subject || "邮件" },
              })
            }
          />
        </Card>
      )}
    />
    </View>
  );
}
