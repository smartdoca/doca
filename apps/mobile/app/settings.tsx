import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "react-native-paper";
import { localeLabel, locales } from "@doca/i18n";
import { useAuth } from "../src/auth";
import { colors } from "../src/chrome";
import { useI18n } from "../src/locale";
import { normalizeOrigin } from "../src/session";

export default function Settings() {
  const navigation = useNavigation();
  const router = useRouter();
  const { session, accounts, switchServer, signOut } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    navigation.setOptions({ title: t("mobile.settings.title") });
  }, [navigation, t]);

  async function addServer() {
    setError("");
    try {
      const origin = normalizeOrigin(draft);
      if (accounts.some((account) => account.origin === origin)) {
        await switchServer(origin);
        return;
      }
      router.push({ pathname: "/login", params: { add: "1", origin } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("mobile.settings.invalidServer"));
    }
  }

  function logout() {
    Alert.alert(t("mobile.settings.signOutTitle"), t("mobile.settings.signOutBody"), [
      { text: t("mobile.settings.cancel"), style: "cancel" },
      { text: t("mobile.settings.signOut"), style: "destructive", onPress: () => void signOut() },
    ]);
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.section}>{t("settings.language")}</Text>
      <View style={styles.card}>
        {locales.map((code) => (
          <Pressable key={code} style={styles.row} onPress={() => void setLocale(code)}>
            <Text style={styles.name}>{t(localeLabel[code])}</Text>
            <Text style={styles.mark}>{locale === code ? t("mobile.settings.current") : ""}</Text>
          </Pressable>
        ))}
        <Text style={styles.note}>{t("settings.language.hint")}</Text>
      </View>
      <Text style={styles.section}>{t("mobile.settings.currentServer")}</Text>
      <View style={styles.card}>
        <Text style={styles.name}>{session?.name || t("mobile.settings.signedOut")}</Text>
        <Text style={styles.origin}>{session?.origin}</Text>
      </View>
      <Text style={styles.section}>{t("mobile.settings.savedServers")}</Text>
      <View style={styles.card}>
        {accounts.map((account) => {
          const current = account.origin === session?.origin;
          return (
            <Pressable
              key={account.origin}
              style={styles.row}
              onPress={() => void switchServer(account.origin)}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.name}>{account.name}</Text>
                <Text style={styles.origin} numberOfLines={1}>{account.origin}</Text>
              </View>
              <Text style={styles.mark}>{current ? t("mobile.settings.current") : t("mobile.settings.switch")}</Text>
            </Pressable>
          );
        })}
        {!accounts.length ? <Text style={styles.origin}>{t("mobile.settings.noneSaved")}</Text> : null}
      </View>
      <Text style={styles.section}>{t("mobile.settings.addServer")}</Text>
      <View style={styles.card}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://example.com"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.button} onPress={() => void addServer()}>
          <Text style={styles.buttonText}>{t("mobile.settings.add")}</Text>
        </Pressable>
        <Text style={styles.note}>{t("mobile.settings.addNote")}</Text>
      </View>
      <Pressable style={styles.action} onPress={() => router.push("/account")}>
        <Text style={styles.actionText}>{t("account.profile")}</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={() => router.push("/scan")}>
        <Text style={styles.actionText}>{t("mobile.settings.scan")}</Text>
      </Pressable>
      <Pressable style={styles.action} onPress={logout}>
        <Text style={styles.danger}>{t("mobile.settings.signOutServer")}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  section: { color: colors.muted, fontSize: 12, marginTop: 16, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: colors.card, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12 },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12 },
  rowCopy: { flex: 1 },
  name: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  origin: { color: colors.secondary, fontSize: 13, marginTop: 2 },
  mark: { color: colors.accent, fontSize: 13 },
  input: {
    height: 40,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  button: {
    height: 40,
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  note: { color: colors.muted, fontSize: 12, marginTop: 10, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 13, marginTop: 8 },
  action: {
    height: 48,
    marginTop: 12,
    borderRadius: 8,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  danger: { color: colors.danger, fontSize: 16, fontWeight: "600" },
});
