import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Text, TextInput } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "./api";
import { colors } from "./chrome";
import { relativeTime } from "./format";

type Tab = "info" | "history" | "access";
type InfoTab = "stats" | "visits" | "audit";
type Stats = {
  title: string;
  createdAt: string;
  updatedAt: string;
  pageWidth?: string;
  visits: number;
  likes: number;
  favorites: number;
  comments: number;
};
type RecordRow = { id: string; name?: string; display_name?: string; title?: string; action?: string; created_at: string; is_ai?: boolean };
type RecordPage = { items: RecordRow[]; nextCursor: string | null };
type VersionPreview = {
  id: string;
  title?: string;
  createdAt: string;
  text?: string;
  markdown?: string;
  currentSeq?: number;
  canRestore?: boolean;
  surface?: unknown;
};
type Member = {
  id: string;
  display_name: string;
  role: string;
  directRole: string | null;
  canAdjust: boolean;
  includeDescendants: boolean;
};
type Overview = {
  rank: number;
  role: string;
  authzRevision: number;
  accessMode: string;
  visibility: string;
  canManage: boolean;
  isOwner: boolean;
  members: Member[];
};
type Person = { id: string; display_name: string; public_id?: string };

const roles = ["reader", "commenter", "editor", "manager"] as const;
const roleLabel: Record<string, string> = {
  none: "无权限",
  reader: "可阅读",
  commenter: "可评论",
  editor: "可编辑",
  manager: "可管理",
  owner: "所有者",
};
const visibilityLabel: Record<string, string> = {
  invited: "仅协作者",
  requestable: "可申请访问",
  authenticated: "登录用户可见",
  public: "公开",
};
const widthLabel: Record<string, string> = { a4: "A4", a3: "A3", fluid: "全宽" };

function eventLabel(action: string) {
  const labels: Record<string, string> = {
    "resource.created": "创建文档",
    "document.created": "创建文档",
    "library.created": "创建知识库",
    "document.updated": "更新正文并生成自动快照",
    "favorite.added": "收藏",
    "favorite.removed": "取消收藏",
    "resource.renamed": "修改标题",
    "resource.permissions_changed": "调整权限",
    "resource.moved": "移动位置",
    "resource.trashed": "移入回收站",
    "resource.restored": "恢复文档",
    "resource.link_enabled": "开启或更新链接分享",
    "resource.link_disabled": "关闭链接分享",
    "document.snapshot_created": "保存快照",
    "document.ai_edited": "AI 编辑了文档",
    "document.version_restored": "回滚历史版本",
    "resource.transferred": "转移所有权",
    "comment.created": "发表评论",
    "comment.updated": "更新评论",
    "like.added": "点赞",
    "like.removed": "取消点赞",
  };
  return labels[action] ?? action;
}

export function DocumentPanel({ id, visible, close }: { id: string; visible: boolean; close: () => void }) {
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>("info");
  const [infoTab, setInfoTab] = useState<InfoTab>("stats");
  const [preview, setPreview] = useState<VersionPreview | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [inviteRole, setInviteRole] = useState<(typeof roles)[number]>("reader");
  const access = useQuery({
    queryKey: ["permission-overview", id],
    enabled: visible && !!id,
    queryFn: () => api<Overview>(`/resources/${id}/permission-overview`),
  });
  const rank = access.data?.rank ?? 0;
  const info = useQuery({
    queryKey: ["document-info", id, infoTab],
    enabled: visible && tab === "info" && (infoTab === "stats" || rank >= 4),
    queryFn: () => api<Stats | RecordPage>(`/resources/${id}/info?tab=${infoTab}`),
  });
  const history = useQuery({
    queryKey: ["document-versions", id],
    enabled: visible && tab === "history",
    queryFn: () => api<RecordPage>(`/resources/${id}/versions`),
  });

  async function reloadAccess() {
    await client.invalidateQueries({ queryKey: ["permission-overview", id] });
  }

  async function saveSnapshot() {
    setBusy(true);
    setNotice("");
    try {
      await api(`/resources/${id}/versions`, { method: "POST" });
      await history.refetch();
      setNotice("已保存当前快照");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "无法保存快照");
    } finally {
      setBusy(false);
    }
  }

  async function openVersion(versionId: string) {
    setBusy(true);
    setNotice("");
    try {
      setPreview(await api<VersionPreview>(`/resources/${id}/versions/${versionId}`));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "无法打开快照");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!preview || preview.currentSeq == null) return;
    setBusy(true);
    setNotice("");
    try {
      await api(`/resources/${id}/versions/${preview.id}/restore`, {
        method: "POST",
        body: { expectedSeq: preview.currentSeq },
      });
      close();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "无法回滚");
    } finally {
      setBusy(false);
    }
  }

  async function setRole(userId: string, role: string | null, includeDescendants: boolean) {
    if (!access.data) return;
    setBusy(true);
    setNotice("");
    try {
      await api(`/resources/${id}/members/${userId}`, {
        method: "PUT",
        body: { revision: access.data.authzRevision, role, includeDescendants },
      });
      await reloadAccess();
      setNotice(role ? "权限已更新" : "已移除协作者");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "无法更新权限");
    } finally {
      setBusy(false);
    }
  }

  async function lookup() {
    const text = query.trim();
    if (text.length < 2) {
      setPeople([]);
      return;
    }
    try {
      const result = await api<{ items: Person[] }>(`/users/lookup?q=${encodeURIComponent(text)}`);
      setPeople(result.items);
      setNotice(result.items.length ? "" : "没有找到用户");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "查找失败");
    }
  }

  const stats = infoTab === "stats" ? (info.data as Stats | undefined) : undefined;
  const records = infoTab === "stats" ? undefined : (info.data as RecordPage | undefined);
  const previewText = preview?.markdown || preview?.text || "";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>文档</Text>
          <Button onPress={close}>关闭</Button>
        </View>
        <View style={styles.tabs}>
          {(
            [
              ["info", "信息"],
              ["history", "历史记录"],
              ["access", "权限"],
            ] as const
          ).map(([key, label]) => (
            <Pressable key={key} onPress={() => setTab(key)} style={[styles.chip, tab === key && styles.chipActive]}>
              <Text style={[styles.chipText, tab === key && styles.chipTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <ScrollView contentContainerStyle={styles.body}>
          {tab === "info" ? (
            <>
              <View style={styles.tabs}>
                <Pressable onPress={() => setInfoTab("stats")} style={[styles.chip, infoTab === "stats" && styles.chipActive]}>
                  <Text style={[styles.chipText, infoTab === "stats" && styles.chipTextActive]}>作品数据</Text>
                </Pressable>
                {rank >= 4 ? (
                  <>
                    <Pressable onPress={() => setInfoTab("visits")} style={[styles.chip, infoTab === "visits" && styles.chipActive]}>
                      <Text style={[styles.chipText, infoTab === "visits" && styles.chipTextActive]}>访问记录</Text>
                    </Pressable>
                    <Pressable onPress={() => setInfoTab("audit")} style={[styles.chip, infoTab === "audit" && styles.chipActive]}>
                      <Text style={[styles.chipText, infoTab === "audit" && styles.chipTextActive]}>操作记录</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
              {info.isLoading ? <Text style={styles.muted}>正在加载…</Text> : null}
              {info.isError ? <Text style={styles.notice}>{info.error instanceof Error ? info.error.message : "加载失败"}</Text> : null}
              {stats ? (
                <>
                  <Text style={styles.heading}>{stats.title}</Text>
                  <View style={styles.grid}>
                    {[
                      ["访问", stats.visits],
                      ["点赞", stats.likes],
                      ["收藏", stats.favorites],
                      ["评论", stats.comments],
                    ].map(([label, value]) => (
                      <View key={String(label)} style={styles.stat}>
                        <Text style={styles.statValue}>{value}</Text>
                        <Text style={styles.muted}>{label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.line}>创建于 {new Date(stats.createdAt).toLocaleString("zh-CN")}</Text>
                  <Text style={styles.line}>更新于 {new Date(stats.updatedAt).toLocaleString("zh-CN")}</Text>
                  {stats.pageWidth ? <Text style={styles.line}>内容宽度 {widthLabel[stats.pageWidth] ?? stats.pageWidth}</Text> : null}
                </>
              ) : null}
              {records?.items.map((row) => (
                <View key={row.id} style={styles.row}>
                  <Text style={styles.rowTitle}>{row.name || row.display_name || "用户"}</Text>
                  <Text style={styles.muted}>{infoTab === "visits" ? "访问了文档" : eventLabel(row.action || "")}</Text>
                  <Text style={styles.muted}>{relativeTime(row.created_at)}</Text>
                </View>
              ))}
              {records && records.items.length === 0 ? <Text style={styles.muted}>暂无记录</Text> : null}
            </>
          ) : null}
          {tab === "history" ? (
            preview ? (
              <>
                <Button onPress={() => setPreview(null)}>返回列表</Button>
                <Text style={styles.heading}>{preview.title || "历史快照"}</Text>
                <Text style={styles.muted}>{new Date(preview.createdAt).toLocaleString("zh-CN")} · 只读快照</Text>
                {preview.surface ? <Text style={styles.line}>表格、画布和演示的快照可以回看时间，正文请在网页编辑器中查看。</Text> : null}
                {previewText ? <Text style={styles.snapshot}>{previewText}</Text> : null}
                {rank >= 4 && preview.canRestore !== false && preview.currentSeq != null ? (
                  <Button mode="contained" buttonColor={colors.accent} loading={busy} onPress={() => void restore()}>
                    回滚到此版本
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.muted}>每 50 次有效更新或持续编辑超过 5 分钟会自动留存。</Text>
                {rank >= 3 ? (
                  <Button mode="contained-tonal" loading={busy} onPress={() => void saveSnapshot()}>
                    保存当前快照
                  </Button>
                ) : null}
                {history.isLoading ? <Text style={styles.muted}>正在加载…</Text> : null}
                {history.isError ? (
                  <Text style={styles.notice}>{history.error instanceof Error ? history.error.message : "加载失败"}</Text>
                ) : null}
                {history.data?.items.map((row) => (
                  <Pressable key={row.id} style={styles.row} onPress={() => void openVersion(row.id)}>
                    <Text style={styles.rowTitle}>{row.title || "快照"}</Text>
                    <Text style={styles.muted}>
                      {row.display_name || "用户"}
                      {row.is_ai ? " · AI" : ""} · {relativeTime(row.created_at)}
                    </Text>
                  </Pressable>
                ))}
                {history.data && history.data.items.length === 0 ? <Text style={styles.muted}>暂无历史快照</Text> : null}
              </>
            )
          ) : null}
          {tab === "access" ? (
            <>
              {access.isLoading ? <Text style={styles.muted}>正在加载…</Text> : null}
              {access.isError ? (
                <Text style={styles.notice}>{access.error instanceof Error ? access.error.message : "加载失败"}</Text>
              ) : null}
              {access.data ? (
                <>
                  <Text style={styles.line}>我的权限 {roleLabel[access.data.role] ?? access.data.role}</Text>
                  <Text style={styles.line}>
                    可见范围 {visibilityLabel[access.data.visibility] ?? access.data.visibility}
                    {access.data.accessMode === "inherit" ? " · 继承上级" : ""}
                  </Text>
                  {access.data.members.map((member) => (
                    <View key={member.id} style={styles.row}>
                      <Text style={styles.rowTitle}>{member.display_name}</Text>
                      <Text style={styles.muted}>{roleLabel[member.role] ?? member.role}</Text>
                      {member.canAdjust ? (
                        <View style={styles.tabs}>
                          {roles
                            .filter((role) => role !== "manager" || access.data?.isOwner)
                            .map((role) => (
                              <Pressable
                                key={role}
                                disabled={busy}
                                onPress={() => void setRole(member.id, role, member.includeDescendants)}
                                style={[styles.chip, member.directRole === role && styles.chipActive]}
                              >
                                <Text style={styles.chipText}>{roleLabel[role]}</Text>
                              </Pressable>
                            ))}
                          <Pressable disabled={busy} onPress={() => void setRole(member.id, null, member.includeDescendants)}>
                            <Text style={styles.remove}>移除</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </View>
                  ))}
                  {access.data.canManage ? (
                    <>
                      <Text style={styles.heading}>邀请协作者</Text>
                      <TextInput mode="outlined" label="姓名或账号" value={query} onChangeText={setQuery} onSubmitEditing={() => void lookup()} />
                      <View style={styles.tabs}>
                        {roles
                          .filter((role) => role !== "manager" || access.data.isOwner)
                          .map((role) => (
                            <Pressable key={role} onPress={() => setInviteRole(role)} style={[styles.chip, inviteRole === role && styles.chipActive]}>
                              <Text style={styles.chipText}>{roleLabel[role]}</Text>
                            </Pressable>
                          ))}
                      </View>
                      <Button mode="contained-tonal" onPress={() => void lookup()}>
                        查找
                      </Button>
                      {people.map((person) => (
                        <Pressable key={person.id} style={styles.row} disabled={busy} onPress={() => void setRole(person.id, inviteRole, true)}>
                          <Text style={styles.rowTitle}>{person.display_name}</Text>
                          <Text style={styles.muted}>{person.public_id || "邀请"}</Text>
                        </Pressable>
                      ))}
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: colors.ink, fontSize: 20, fontWeight: "600" },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
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
  body: { gap: 10, paddingBottom: 24 },
  heading: { color: colors.ink, fontSize: 18, fontWeight: "600" },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  notice: { color: colors.danger, fontSize: 13 },
  line: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    width: "47%",
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 12,
  },
  statValue: { color: colors.ink, fontSize: 22, fontWeight: "600" },
  row: {
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 12,
    gap: 4,
  },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  snapshot: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  remove: { color: colors.danger, fontSize: 13, paddingVertical: 6 },
});
