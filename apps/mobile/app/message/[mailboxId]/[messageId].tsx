import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { WebView } from "react-native-webview";
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
  const router = useRouter();
  const { session } = useAuth();
  useLayoutEffect(() => {
    navigation.setOptions({ title: title || "邮件" });
  }, [navigation, title]);
  const query = useQuery({
    queryKey: ["mail-message", session?.origin, mailboxId, messageId],
    enabled: !!session && !!mailboxId && !!messageId,
    queryFn: () => api<Detail>(`/mail/mailboxes/${mailboxId}/messages/${encodeURIComponent(messageId)}`),
  });
  if (query.isLoading) return <Text style={styles.status}>正在加载…</Text>;
  if (query.isError) {
    return <Text style={styles.status}>{query.error instanceof Error ? query.error.message : "加载失败"}</Text>;
  }
  const message = query.data;
  if (!message || !session) return null;
  return (
    <View style={styles.page}>
      <View style={styles.head}>
        <Text variant="titleLarge">{message.subject || "（无主题）"}</Text>
        <Text variant="bodyMedium" style={styles.from}>
          {message.from.name || message.from.email}
        </Text>
        <Button
          mode="text"
          textColor={colors.accent}
          style={styles.reply}
          onPress={() =>
            router.push({
              pathname: "/compose",
              params: {
                mailboxId,
                to: message.from.email,
                subject: message.subject?.startsWith("回复：") ? message.subject : `回复：${message.subject || ""}`,
              },
            })
          }
        >
          回复
        </Button>
      </View>
      <WebView
        style={styles.body}
        originWhitelist={["*"]}
        source={{ html: mailDocument(message.html, message.text), baseUrl: session.origin }}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

function mailDocument(html: string, text: string) {
  const raw = html && /<[a-z][\s\S]*>/i.test(html) ? html : escapeText(text).replace(/\n/g, "<br>");
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const style = `<meta name="viewport" content="width=device-width, initial-scale=1"><style>
    html,body{margin:0;padding:12px;color:#202124;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
    img,video{max-width:100%;height:auto} table{max-width:100%} pre{white-space:pre-wrap} a{color:#1a73e8}
  </style>`;
  if (/<head[\s>]/i.test(cleaned)) return cleaned.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  if (/<html[\s>]/i.test(cleaned)) return cleaned.replace(/<html([^>]*)>/i, `<html$1><head>${style}</head>`);
  return `<!doctype html><html><head>${style}</head><body>${cleaned}</body></html>`;
}

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  head: { paddingHorizontal: 16, paddingTop: 12 },
  from: { marginTop: 8, color: colors.secondary },
  reply: { alignSelf: "flex-start", marginTop: 4 },
  body: { flex: 1, backgroundColor: "#fff" },
  status: { margin: 24, color: colors.secondary },
});
