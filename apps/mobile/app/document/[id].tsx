import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { IconButton, Text } from "react-native-paper";
import { WebView } from "react-native-webview";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { DocumentPanel } from "../../src/document-panel";
import { mobileEditorScript } from "../../src/mobile-editor-css";

export default function Document() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const navigation = useNavigation();
  const { session } = useAuth();
  const [heading, setHeading] = useState(title || "文档");
  const [panel, setPanel] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({
      title: heading,
      headerRight: () => <IconButton icon="dots-horizontal" onPress={() => setPanel(true)} />,
    });
  }, [heading, navigation]);
  const ticket = useQuery({
    queryKey: ["webview-ticket", session?.origin, id],
    enabled: !!session && !!id,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => api<{ ticket: string }>("/auth/webview-ticket", { method: "POST" }),
  });
  if (!session) return null;
  if (ticket.isLoading) return <Text style={styles.status}>正在打开文档…</Text>;
  if (ticket.isError || !ticket.data) {
    return (
      <Text style={styles.status}>
        {ticket.error instanceof Error ? ticket.error.message : "无法打开文档"}
      </Text>
    );
  }
  const url = `${session.origin}/#/m/auth?${new URLSearchParams({
    ticket: ticket.data.ticket,
    to: `/m/r/${id}`,
  })}`;
  return (
    <View style={styles.page}>
      <WebView
        style={styles.page}
        source={{ uri: url }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        setSupportMultipleWindows={false}
        injectedJavaScriptBeforeContentLoaded={mobileEditorScript}
        injectedJavaScript={mobileEditorScript}
        onMessage={(event) => {
          try {
            const message = JSON.parse(event.nativeEvent.data) as { type?: string; title?: string };
            if (message.type === "document" && message.title) setHeading(message.title);
          } catch {
            // Editor pages can post unrelated messages.
          }
        }}
      />
      <DocumentPanel id={id} visible={panel} close={() => setPanel(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  status: { margin: 24 },
});
