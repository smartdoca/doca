import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { Button, Text } from "react-native-paper";
import { WebView } from "react-native-webview";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { useI18n } from "../../src/locale";
import { useMobileNavigation } from "../../src/plugins/navigation";
export default function PluginPage() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    { session } = useAuth(),
    { locale, t } = useI18n(),
    nav = useMobileNavigation();
  const entry = nav.data.entries.find(
    (e) => e.id === id && e.pluginId && e.mobile,
  );
  const ticket = useQuery({
    queryKey: ["plugin-ticket", session?.origin, session?.token, id],
    enabled: !!session && !!entry && nav.isSuccess,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () =>
      api<{ ticket: string }>("/plugins-mobile/ticket", {
        body: { entryId: id },
      }),
  });
  if (nav.isLoading || ticket.isLoading)
    return <Text>{t("plugins.loading")}</Text>;
  if (!session || !entry?.webPath)
    return <Text>{t("navigation.unavailable")}</Text>;
  if (!ticket.data)
    return (
      <View>
        <Text>{t("navigation.openFailed")}</Text>
        <Button onPress={() => void ticket.refetch()}>
          {t("plugins.refresh")}
        </Button>
      </View>
    );
  const to = `/m${entry.webPath}`,
    url = `${session.origin}/#/m/auth?${new URLSearchParams({ ticket: ticket.data.ticket, to })}`;
  return (
    <>
      <Stack.Screen options={{ title: entry.title[locale] }} />
      <WebView
        key={`${session.origin}:${id}:${ticket.data.ticket}`}
        source={{ uri: url }}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        originWhitelist={[session.origin]}
        onShouldStartLoadWithRequest={(request) => {
          try {
            const next = new URL(request.url);
            return (
              next.origin === session.origin &&
              next.pathname === "/" &&
              (next.hash.startsWith("#/m/auth?") ||
                next.hash.startsWith(`#/m/plugins/${entry.pluginId}/`))
            );
          } catch {
            return false;
          }
        }}
      />
    </>
  );
}
