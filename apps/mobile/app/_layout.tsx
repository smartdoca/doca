import "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { MD3LightTheme, PaperProvider } from "react-native-paper";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth";
import { colors } from "../src/chrome";
import { LocaleProvider, useI18n } from "../src/locale";
import { persistQueryCache, queryClient, restoreQueryCache } from "../src/query-cache";

const theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: colors.accent,
    onPrimary: "#ffffff",
    background: colors.bg,
    surface: colors.card,
    onSurface: colors.ink,
    outline: colors.line,
  },
};

function AppStack() {
  const { t } = useI18n();
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: colors.ink,
          headerStyle: { backgroundColor: "#fff" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="document/[id]" options={{ title: t("mobile.screen.document") }} />
        <Stack.Screen name="library/[id]" options={{ title: t("mobile.screen.library") }} />
        <Stack.Screen name="folder/[id]" options={{ title: t("mobile.screen.folder") }} />
        <Stack.Screen name="ai/[id]" options={{ title: t("mobile.screen.conversation") }} />
        <Stack.Screen name="note/[id]" options={{ title: t("mobile.screen.note") }} />
        <Stack.Screen name="account" options={{ title: t("mobile.screen.account") }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop: () => void = () => undefined;
    void restoreQueryCache().finally(() => {
      stop = persistQueryCache();
      setReady(true);
    });
    return () => stop();
  }, []);
  if (!ready) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <BottomSheetModalProvider>
      <SafeAreaProvider>
          <PaperProvider
              theme={theme}
              settings={{
                icon: (props) => <MaterialCommunityIcons {...props} />,
              }}
            >
            <QueryClientProvider client={queryClient}>
              <AuthProvider>
                <LocaleProvider>
                  <AppStack />
                </LocaleProvider>
              </AuthProvider>
            </QueryClientProvider>
          </PaperProvider>
      </SafeAreaProvider>
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
