import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { colors } from "../../src/chrome";
import { noteDraft, noteText, type QuickNote } from "../../src/notes";

export default function NoteEditor() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const navigation = useNavigation();
  const client = useQueryClient();
  const { session } = useAuth();
  const [text, setText] = useState("");
  const [ready, setReady] = useState(fresh === "1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["note", session?.origin, id],
    enabled: !!session && !!id && fresh !== "1",
    queryFn: () => api<QuickNote>(`/quick-notes/${id}`),
  });

  useLayoutEffect(() => {
    navigation.setOptions({ title: fresh === "1" ? "新随手记" : "随手记" });
  }, [fresh, navigation]);

  useLayoutEffect(() => {
    if (fresh === "1" || !query.data || ready) return;
    setText(noteText(query.data.content));
    setReady(true);
  }, [fresh, query.data, ready]);

  async function save() {
    if (!session || !id || saving) return;
    const previous = query.data?.content ?? [];
    const body = noteDraft(text, previous);
    if (!text.trim() && !body.assetIds.length) {
      setError("先写点内容");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (fresh === "1" || !query.data) {
        await api(`/quick-notes/${id}`, { method: "PUT", body });
      } else {
        await api(`/quick-notes/${id}`, {
          method: "PATCH",
          body: { ...body, version: query.data.version },
        });
      }
      await client.invalidateQueries({ queryKey: ["notes", session.origin] });
      await client.invalidateQueries({ queryKey: ["note", session.origin, id] });
      navigation.goBack();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (query.isLoading && fresh !== "1") {
    return <Text style={styles.status}>正在打开…</Text>;
  }
  if (query.isError && fresh !== "1") {
    return <Text style={styles.status}>{query.error instanceof Error ? query.error.message : "加载失败"}</Text>;
  }

  return (
    <View style={styles.page}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        placeholder="记下来…"
        placeholderTextColor={colors.muted}
        style={styles.input}
        textAlignVertical="top"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button mode="contained" buttonColor={colors.accent} loading={saving} disabled={saving} onPress={() => void save()}>
        保存
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff", padding: 16, gap: 12 },
  input: { flex: 1, color: colors.ink, fontSize: 17, lineHeight: 26 },
  status: { margin: 24, color: colors.secondary },
  error: { color: colors.danger },
});
