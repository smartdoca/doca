import { useEffect, useRef } from "react";
import { handlePluginNativeRequest } from "../../src/plugins/native";
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
  const webview = useRef<WebView>(null);
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    lifecycle.current = new AbortController();
    return () => lifecycle.current.abort();
  }, [session?.origin, session?.token, id]);
  const identity = useQuery({
    queryKey: ["plugin-native-identity", session?.origin, session?.token],
    enabled: !!session,
    retry: false,
    staleTime: 0,
    queryFn: () => api<{ user: { id: string } }>("/me", { session }),
  });
  const entry = nav.data.entries.find(
    (e) => e.id === id && e.pluginId && e.mobile,
  );
  const ticket = useQuery({
    queryKey: ["plugin-ticket", session?.origin, session?.token, id],
    enabled: !!session && !!entry && nav.isSuccess && identity.isSuccess,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () =>
      api<{ ticket: string }>("/plugins-mobile/ticket", {
        body: { entryId: id },
      }),
  });
  if (nav.isLoading || identity.isLoading || ticket.isLoading)
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
        ref={webview}
        onMessage={async (event) => {
          if (!identity.data || !entry.pluginId) return;
          try {
            const origin = new URL(event.nativeEvent.url);
            if (
              origin.origin !== session.origin ||
              !origin.hash.startsWith(`#/m/plugins/${entry.pluginId}/`)
            )
              return;
          } catch {
            return;
          }
          let request: any;
          try {
            request = JSON.parse(event.nativeEvent.data);
          } catch {
            return;
          }
          const signal = lifecycle.current.signal;
          let result: unknown, error: string | undefined;
          try {
            result = await handlePluginNativeRequest(
              request,
              session,
              identity.data.user.id,
              entry.pluginId,
              signal,
            );
          } catch (reason) {
            error =
              reason instanceof Error
                ? reason.message
                : "Native operation failed";
          }
          if (!signal.aborted) {
            const payload = JSON.stringify({
              version: 1,
              id: request?.id,
              pluginId: entry.pluginId,
              result,
              error,
            }).replace(/</g, "\\u003c");
            webview.current?.injectJavaScript(
              `window.dispatchEvent(new CustomEvent("doca-native-response", {detail:${payload}}));true;`,
            );
          }
        }}
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
