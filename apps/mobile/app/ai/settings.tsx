import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Switch, Text, TextInput } from "react-native-paper";
import { api, uuid } from "../../src/api";
import { useAuth } from "../../src/auth";
import { colors } from "../../src/chrome";
import { relativeTime } from "../../src/format";

type Tab = "usage" | "memory" | "skills" | "archived" | "note";
type Model = { id: string; name: string };
type Options = {
  defaultModel: string;
  memoryAvailable?: boolean;
  models: Model[];
  preferences?: { default_model?: string | null; memory_enabled?: number };
};
type Usage = {
  used: Record<string, number>;
  limits: Record<string, number | null>;
  periods: Record<string, string>;
  tokens?: Record<string, { input?: number; output?: number; cached?: number }>;
  bonus: number;
  calls: { id: string; model: string; input: number; output: number; cached?: number; points: number; state: string }[];
};
type Skill = {
  id: string;
  name: string;
  description: string;
  content: string;
  formats: string[] | string;
  enabled: boolean | number;
  revision: number;
};
type Secret = { key: string; value: string };

const tabs: { key: Tab; label: string }[] = [
  { key: "usage", label: "用量" },
  { key: "memory", label: "个人偏好" },
  { key: "skills", label: "Skill" },
  { key: "archived", label: "已归档" },
  { key: "note", label: "备忘" },
];
const states: Record<string, string> = {
  confirmed: "已结算",
  reserved: "预占中",
  pending: "待对账",
  site_test: "站点测试",
  failed: "失败",
  reconciled: "已对账",
};

function formatsOf(value: Skill["formats"]) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export default function AISettings() {
  const navigation = useNavigation();
  const router = useRouter();
  const client = useQueryClient();
  const { session } = useAuth();
  const [tab, setTab] = useState<Tab>("usage");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [draft, setDraft] = useState<Skill | null>(null);
  useLayoutEffect(() => {
    navigation.setOptions({ title: "AI 设置" });
  }, [navigation]);
  const options = useQuery({
    queryKey: ["ai-options", session?.origin],
    enabled: !!session,
    queryFn: () => api<Options>("/ai/options"),
  });
  const usage = useQuery({
    queryKey: ["ai-usage", session?.origin],
    enabled: !!session && tab === "usage",
    queryFn: () => api<Usage>("/ai/usage"),
  });
  const memoryQuery = useQuery({
    queryKey: ["ai-memory", session?.origin],
    enabled: !!session && tab === "memory",
    queryFn: () => api<{ text: string; revision: number }>("/ai/memory"),
  });
  const skills = useQuery({
    queryKey: ["ai-skills", session?.origin],
    enabled: !!session && tab === "skills",
    queryFn: () => api<{ official: Skill[]; personal: Skill[] }>("/ai/skills"),
  });
  const archived = useQuery({
    queryKey: ["ai-archived", session?.origin],
    enabled: !!session && tab === "archived",
    queryFn: async () => {
      const data = await api<{ id: string; title: string; updated_at?: string }[] | { items: { id: string; title: string; updated_at?: string }[] }>(
        "/ai/sessions?archived=true",
      );
      return Array.isArray(data) ? data : data.items;
    },
  });
  const noteQuery = useQuery({
    queryKey: ["ai-note", session?.origin],
    enabled: !!session && tab === "note",
    queryFn: () => api<{ content: string }>("/ai/note"),
  });
  const secrets = useQuery({
    queryKey: ["ai-secrets", session?.origin],
    enabled: !!session && tab === "note",
    queryFn: () => api<{ items: Secret[] }>("/ai/secrets"),
  });
  const memoryText = memory ?? memoryQuery.data?.text ?? "";
  const noteText = note ?? noteQuery.data?.content ?? "";
  const modelId = options.data?.preferences?.default_model || "";

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.body}>
      <View style={styles.tabs}>
        {tabs.map((item) => (
          <Pressable key={item.key} onPress={() => setTab(item.key)} style={[styles.chip, tab === item.key && styles.chipActive]}>
            <Text style={[styles.chipText, tab === item.key && styles.chipTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {tab === "usage" && usage.data ? (
        <>
          {(
            [
              ["day", "今日"],
              ["week", "本周"],
              ["month", "本月"],
            ] as const
          ).map(([key, label]) => (
            <View key={key} style={styles.card}>
              <Text style={styles.muted}>{label}基础积分</Text>
              <Text style={styles.strong}>
                {Math.round(usage.data.used[key] ?? 0).toLocaleString()} / {usage.data.limits[key] ?? "不限"}
              </Text>
              <Text style={styles.muted}>
                Token {(usage.data.tokens?.[key]?.input ?? 0) + (usage.data.tokens?.[key]?.output ?? 0)} · 缓存命中{" "}
                {usage.data.tokens?.[key]?.cached ?? 0}
              </Text>
            </View>
          ))}
          <View style={styles.card}>
            <Text style={styles.muted}>额外积分</Text>
            <Text style={styles.strong}>{Math.round(usage.data.bonus).toLocaleString()}</Text>
          </View>
          {usage.data.calls.slice(0, 20).map((call) => (
            <View key={call.id} style={styles.card}>
              <Text style={styles.rowTitle}>{call.model}</Text>
              <Text style={styles.muted}>
                {call.input + call.output} Token · {call.points} 积分 · {states[call.state] ?? call.state}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      {tab === "memory" ? (
        <>
          <Text style={styles.muted}>记录常用语言、写作风格和个人偏好。知识库内容仍以原文为准。</Text>
          <Text style={styles.rowTitle}>默认模型</Text>
          <View style={styles.tabs}>
            <Pressable
              onPress={() =>
                void run(async () => {
                  await api("/ai/preferences", {
                    method: "PUT",
                    body: { defaultModel: null, memoryEnabled: !!options.data?.preferences?.memory_enabled },
                  });
                  await client.invalidateQueries({ queryKey: ["ai-options", session?.origin] });
                })
              }
              style={[styles.chip, !modelId && styles.chipActive]}
            >
              <Text style={styles.chipText}>平台默认</Text>
            </Pressable>
            {options.data?.models.map((model) => (
              <Pressable
                key={model.id}
                onPress={() =>
                  void run(async () => {
                    await api("/ai/preferences", {
                      method: "PUT",
                      body: { defaultModel: model.id, memoryEnabled: !!options.data?.preferences?.memory_enabled },
                    });
                    await client.invalidateQueries({ queryKey: ["ai-options", session?.origin] });
                  })
                }
                style={[styles.chip, modelId === model.id && styles.chipActive]}
              >
                <Text style={styles.chipText}>{model.name}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.rowTitle}>在对话中使用个人偏好</Text>
            <Switch
              value={!!options.data?.preferences?.memory_enabled}
              disabled={!options.data?.memoryAvailable || busy}
              onValueChange={(enabled) =>
                void run(async () => {
                  await api("/ai/preferences", {
                    method: "PUT",
                    body: { defaultModel: options.data?.preferences?.default_model ?? null, memoryEnabled: enabled },
                  });
                  await client.invalidateQueries({ queryKey: ["ai-options", session?.origin] });
                })
              }
            />
          </View>
          {!options.data?.memoryAvailable ? <Text style={styles.muted}>管理员尚未启用长期记忆。</Text> : null}
          <TextInput mode="outlined" multiline value={memoryText} onChangeText={setMemory} placeholder="例如：用中文回答，先说明结论。" />
          <Button
            mode="contained"
            buttonColor={colors.accent}
            loading={busy}
            disabled={!options.data?.memoryAvailable || memoryQuery.data == null}
            onPress={() =>
              void run(async () => {
                const saved = await api<{ revision: number }>("/ai/memory", {
                  method: "PUT",
                  body: { text: memoryText, revision: memoryQuery.data?.revision ?? 0 },
                });
                setMemory(null);
                client.setQueryData(["ai-memory", session?.origin], { text: memoryText, revision: saved.revision });
                setNotice("已保存偏好");
              })
            }
          >
            保存偏好
          </Button>
        </>
      ) : null}
      {tab === "skills" && skills.data ? (
        <>
          <Text style={styles.heading}>官方场景</Text>
          {skills.data.official.map((skill) => (
            <View key={skill.id} style={styles.card}>
              <Text style={styles.rowTitle}>{skill.name}</Text>
              <Text style={styles.muted}>{skill.description}</Text>
            </View>
          ))}
          <Text style={styles.heading}>个人 Skill</Text>
          <Button
            mode="contained-tonal"
            onPress={() => setDraft({ id: uuid(), name: "", description: "", content: "", formats: [], enabled: true, revision: 0 })}
          >
            新建 Skill
          </Button>
          {skills.data.personal.map((skill) => (
            <View key={skill.id} style={styles.card}>
              <Text style={styles.rowTitle}>{skill.name}</Text>
              <Text style={styles.muted}>{skill.description}</Text>
              <View style={styles.switchRow}>
                <Text style={styles.muted}>{skill.enabled ? "已启用" : "已停用"}</Text>
                <Button
                  onPress={() =>
                    void run(async () => {
                      await api(`/ai/skills/${skill.id}`, { method: "DELETE" });
                      await skills.refetch();
                    })
                  }
                >
                  删除
                </Button>
              </View>
            </View>
          ))}
          {draft ? (
            <>
              <TextInput mode="outlined" label="名称" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
              <TextInput mode="outlined" label="适用场景" value={draft.description} onChangeText={(description) => setDraft({ ...draft, description })} />
              <TextInput mode="outlined" label="内容" multiline value={draft.content} onChangeText={(content) => setDraft({ ...draft, content })} />
              <Button
                mode="contained"
                buttonColor={colors.accent}
                loading={busy}
                onPress={() =>
                  void run(async () => {
                    const { id, ...body } = draft;
                    await api(`/ai/skills/${id}`, {
                      method: "PUT",
                      body: { ...body, formats: formatsOf(body.formats), enabled: !!body.enabled },
                    });
                    setDraft(null);
                    await skills.refetch();
                  })
                }
              >
                保存
              </Button>
            </>
          ) : null}
        </>
      ) : null}
      {tab === "archived" && archived.data ? (
        <>
          <Text style={styles.muted}>已归档的会话不会出现在列表里。恢复后可以继续对话。</Text>
          {archived.data.length === 0 ? <Text style={styles.muted}>暂无归档会话</Text> : null}
          {archived.data.map((item) => (
            <View key={item.id} style={styles.card}>
              <Text style={styles.rowTitle}>{item.title || "对话"}</Text>
              {item.updated_at ? <Text style={styles.muted}>{relativeTime(item.updated_at)}</Text> : null}
              <Button
                onPress={() =>
                  void run(async () => {
                    await api(`/ai/sessions/${item.id}`, { method: "PATCH", body: { archived: false } });
                    await client.invalidateQueries({ queryKey: ["ai-sessions", session?.origin] });
                    router.replace({ pathname: "/ai/[id]", params: { id: item.id, title: item.title || "对话" } });
                  })
                }
              >
                恢复并打开
              </Button>
            </View>
          ))}
        </>
      ) : null}
      {tab === "note" ? (
        <>
          <TextInput mode="outlined" label="备忘" multiline value={noteText} onChangeText={setNote} />
          <Button
            mode="contained"
            buttonColor={colors.accent}
            loading={busy}
            disabled={noteQuery.data == null}
            onPress={() =>
              void run(async () => {
                await api("/ai/note", { method: "PUT", body: { content: noteText } });
                setNote(null);
                client.setQueryData(["ai-note", session?.origin], { content: noteText });
                setNotice("已保存备忘");
              })
            }
          >
            保存备忘
          </Button>
          <Text style={styles.heading}>密码本</Text>
          <Text style={styles.muted}>key 以字母开头，只含字母、数字和下划线。已保存的值不会再次显示。</Text>
          {secrets.data?.items.map((item) => (
            <View key={item.key} style={styles.switchRow}>
              <Text style={styles.rowTitle}>{item.key}</Text>
              <Button
                onPress={() =>
                  void run(async () => {
                    await api(`/ai/secrets/${encodeURIComponent(item.key)}`, { method: "DELETE" });
                    await secrets.refetch();
                  })
                }
              >
                删除
              </Button>
            </View>
          ))}
          <TextInput mode="outlined" label="Key" value={secretKey} onChangeText={setSecretKey} autoCapitalize="none" />
          <TextInput mode="outlined" label="值" value={secretValue} onChangeText={setSecretValue} secureTextEntry />
          <Button
            mode="contained-tonal"
            loading={busy}
            onPress={() =>
              void run(async () => {
                await api("/ai/secrets", { method: "PUT", body: { key: secretKey.trim(), value: secretValue } });
                setSecretKey("");
                setSecretValue("");
                await secrets.refetch();
                setNotice("已保存到密码本");
              })
            }
          >
            保存密钥
          </Button>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.selected, borderColor: colors.selected },
  chipText: { color: colors.secondary, fontSize: 13 },
  chipTextActive: { color: colors.accent, fontWeight: "600" },
  card: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 12,
    gap: 4,
  },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  strong: { color: colors.ink, fontSize: 18, fontWeight: "600" },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  notice: { color: colors.danger, fontSize: 13 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
});
