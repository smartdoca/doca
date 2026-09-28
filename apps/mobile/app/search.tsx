import { useQuery } from "@tanstack/react-query";
import { useNavigation, useRouter } from "expo-router";
import { Search } from "lucide-react-native";
import { useEffect, useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "react-native-paper";
import { api, formatLabel, type Resource } from "../src/api";
import { colors } from "../src/chrome";

type Mode = "keyword" | "ai";
type SearchDocument = Resource & { summary?: string };
type FileLocation = {
  id: string;
  name: string;
  parentType: string;
  parentId: string;
  navigation?: { type?: string; id?: string; name?: string }[];
};
type FileHit = {
  id: string;
  name: string;
  mime: string;
  description?: string | null;
  locations: FileLocation[];
};
type SearchPage = { items: SearchDocument[]; notice?: string };

function openFile(router: ReturnType<typeof useRouter>, file: FileHit) {
  const location = file.locations[0];
  if (!location) return;
  if (location.parentType === "document") {
    router.push({ pathname: "/document/[id]", params: { id: location.parentId, title: location.name || file.name } });
    return;
  }
  const last = [...(location.navigation ?? [])].reverse().find((item) => item.id && item.id !== "root");
  if (last?.id) {
    const parentType = last.type === "system" || last.type === "document" ? last.type : "folder";
    router.push({ pathname: "/folder/[id]", params: { id: last.id, title: last.name || "文件夹", parentType } });
    return;
  }
  router.push({ pathname: "/folder/[id]", params: { id: location.parentId, title: "文件夹", parentType: location.parentType === "system" ? "system" : "folder" } });
}

export default function SearchScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("keyword");
  const [keyword, setKeyword] = useState("");
  const [aiQuery, setAiQuery] = useState("");
  useLayoutEffect(() => {
    navigation.setOptions({ title: "搜索" });
  }, [navigation]);
  useEffect(() => {
    if (mode !== "keyword") return;
    const timer = setTimeout(() => setKeyword(draft.trim()), 280);
    return () => clearTimeout(timer);
  }, [draft, mode]);
  const active = mode === "keyword" ? keyword : aiQuery;
  const results = useQuery({
    queryKey: ["search", mode, active],
    enabled: mode === "keyword" || !!aiQuery,
    queryFn: async () => {
      const documents = await api<SearchPage>(
        `/search/documents?${new URLSearchParams({
          q: active,
          mode,
          scope: active ? "all" : "recent",
        })}`,
      );
      if (!active) return { documents: documents.items, files: [] as FileHit[], notice: documents.notice };
      const [files] = await Promise.all([
        api<{ items: FileHit[] }>(`/files/search?${new URLSearchParams({ q: active, limit: "30", mode })}`).catch(() => ({ items: [] as FileHit[] })),
      ]);
      return { documents: documents.items, files: files.items, notice: documents.notice };
    },
  });
  const data = results.data;
  const empty = !results.isLoading && !results.isError && !!active && !data?.documents.length && !data?.files.length;

  function submit() {
    const text = draft.trim();
    if (!text) return;
    if (mode === "ai") setAiQuery(text);
    else setKeyword(text);
  }

  function selectMode(next: Mode) {
    setMode(next);
    if (next === "ai") setAiQuery("");
  }

  return (
    <View style={styles.page}>
      <View style={styles.box}>
        <Search color={colors.muted} size={16} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          placeholder={mode === "ai" ? "用一句话描述，例如：猫猫的图片" : "输入关键字"}
          placeholderTextColor={colors.muted}
          style={styles.input}
          returnKeyType="search"
          autoFocus
          maxLength={500}
        />
        <Pressable onPress={submit} style={styles.submit}>
          <Text style={styles.submitText}>搜索</Text>
        </Pressable>
      </View>
      <View style={styles.modes}>
        {(
          [
            ["keyword", "关键词"],
            ["ai", "AI"],
          ] as const
        ).map(([key, label]) => (
          <Pressable key={key} onPress={() => selectMode(key)} style={[styles.mode, mode === key && styles.modeActive]}>
            <Text style={[styles.modeText, mode === key && styles.modeTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {mode === "ai" ? <Text style={styles.hint}>描述场景或内容即可，不必精确匹配标题。</Text> : null}
      <ScrollView contentContainerStyle={styles.results} keyboardShouldPersistTaps="handled">
        {results.isLoading ? <Text style={styles.hint}>正在搜索…</Text> : null}
        {results.isError ? <Text style={styles.error}>{results.error instanceof Error ? results.error.message : "搜索失败"}</Text> : null}
        {data?.notice ? <Text style={styles.hint}>{data.notice}</Text> : null}
        {empty ? <Text style={styles.hint}>没有找到相关内容</Text> : null}
        {data?.documents.length ? (
          <Text style={styles.section}>{!active && mode === "keyword" ? "最近浏览" : "文档"}</Text>
        ) : null}
        {data?.documents.map((item) => (
          <Pressable
            key={item.id}
            style={styles.card}
            onPress={() =>
              item.kind === "library"
                ? router.push({ pathname: "/library/[id]", params: { id: item.id, title: item.title } })
                : router.push({ pathname: "/document/[id]", params: { id: item.id, title: item.title } })
            }
          >
            <Text style={styles.cardTitle}>{item.title || "未命名"}</Text>
            <Text style={styles.cardMeta} numberOfLines={2}>
              {item.kind === "library" ? "知识库" : formatLabel[item.format]}
              {item.summary ? ` · ${item.summary}` : ""}
            </Text>
          </Pressable>
        ))}
        {data?.files.length ? <Text style={styles.section}>文件</Text> : null}
        {data?.files.map((item) => (
          <Pressable key={item.id} style={styles.card} onPress={() => openFile(router, item)}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text style={styles.cardMeta} numberOfLines={2}>
              {item.description || item.mime}
            </Text>
          </Pressable>
        ))}


      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  box: {
    flexDirection: "row",
    alignItems: "center",
    height: 40,
    marginHorizontal: 16,
    marginTop: 12,
    paddingLeft: 12,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  input: { flex: 1, height: 40, marginLeft: 8, color: colors.ink, fontSize: 15, paddingVertical: 0 },
  submit: { height: 40, justifyContent: "center", paddingHorizontal: 12 },
  submitText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  modes: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 10 },
  mode: {
    height: 28,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  modeActive: { backgroundColor: colors.selected, borderColor: colors.selected },
  modeText: { color: colors.secondary, fontSize: 13 },
  modeTextActive: { color: colors.accent, fontWeight: "600" },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingTop: 8 },
  error: { color: colors.danger, fontSize: 13, paddingHorizontal: 16, paddingTop: 8 },
  results: { paddingBottom: 32 },
  section: { color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  card: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineSoft,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  cardMeta: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
