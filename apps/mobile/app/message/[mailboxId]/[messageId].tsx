import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import RenderHTML from "react-native-render-html";
import { Text } from "react-native-paper";
import { api } from "../../../src/api";
import { useAuth } from "../../../src/auth";
import { colors } from "../../../src/chrome";

type Detail = {
  subject: string;
  from: { name?: string; email: string };
  text: string;
  html: string;
};

export default function Message() {
  const { mailboxId, messageId, title } = useLocalSearchParams<{
    mailboxId: string;
    messageId: string;
    title?: string;
  }>();
  const navigation = useNavigation();
  const { session } = useAuth();
  const { width } = useWindowDimensions();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "邮件" });
  }, [navigation, title]);
  const query = useQuery({
    queryKey: ["mail-message", session?.origin, mailboxId, messageId],
    enabled: !!session && !!mailboxId && !!messageId,
    queryFn: () => api<Detail>(`/mail/mailboxes/${mailboxId}/messages/${encodeURIComponent(messageId)}`),
  });
  if (query.isLoading) return <Text style={{ margin: 24 }}>正在加载…</Text>;
  if (query.isError) {
    return <Text style={{ margin: 24 }}>{query.error instanceof Error ? query.error.message : "加载失败"}</Text>;
  }
  const message = query.data;
  if (!message) return null;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text variant="titleLarge">{message.subject || "（无主题）"}</Text>
      <Text variant="bodyMedium" style={{ marginVertical: 8, color: colors.secondary }}>
        {message.from.name || message.from.email}
      </Text>
      {message.html ? (
        <RenderHTML contentWidth={width - 32} source={{ html: message.html }} />
      ) : (
        <Text>{message.text}</Text>
      )}
    </ScrollView>
  );
}
