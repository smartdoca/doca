import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { api } from "../src/api";
import { takeMailDraft } from "../src/ai-answer";
import { colors } from "../src/chrome";

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function Compose() {
  const params = useLocalSearchParams<{
    mailboxId: string;
    to?: string;
    subject?: string;
    quoted?: string;
  }>();
  const mailboxId = one(params.mailboxId) ?? "";
  const navigation = useNavigation();
  const router = useRouter();
  const seeded = useState(() => takeMailDraft(mailboxId))[0];
  const [to, setTo] = useState(seeded?.to || one(params.to) || "");
  const [cc, setCc] = useState(seeded?.cc || "");
  const [subject, setSubject] = useState(seeded?.subject || one(params.subject) || "");
  const [text, setText] = useState(seeded?.text || one(params.quoted) || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    navigation.setOptions({ title: "写邮件" });
  }, [navigation]);

  async function send() {
    if (!mailboxId || sending) return;
    if (!to.trim()) {
      setError("请填写收件人");
      return;
    }
    setSending(true);
    setError("");
    try {
      await api(`/mail/mailboxes/${mailboxId}/messages`, {
        body: { to: to.trim(), cc: cc.trim(), subject: subject.trim(), text },
      });
      router.back();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Field label="收件人" value={to} onChangeText={setTo} placeholder="name@example.com" />
        <Field label="抄送" value={cc} onChangeText={setCc} placeholder="可选" />
        <Field label="主题" value={subject} onChangeText={setSubject} placeholder="主题" />
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder="正文"
          placeholderTextColor={colors.muted}
          style={styles.body}
          textAlignVertical="top"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button mode="contained" buttonColor={colors.accent} loading={sending} disabled={sending} onPress={() => void send()}>
          发送
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  form: { padding: 16, gap: 12 },
  field: { gap: 6 },
  label: { color: colors.muted, fontSize: 12 },
  input: {
    height: 40,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    color: colors.ink,
    fontSize: 16,
  },
  body: { minHeight: 220, color: colors.ink, fontSize: 16, lineHeight: 24 },
  error: { color: colors.danger },
});
