import { useQuery } from "@tanstack/react-query";
import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { FAB, IconButton, Text } from "react-native-paper";
import { api } from "../../src/api";
import { useAuth } from "../../src/auth";
import { EmptyState, LoadingState, colors } from "../../src/chrome";

type Mailbox = { id: string; address: string; displayName: string };
type Folder = { id: string; name: string; role: string; total: number; unread: number };
type Detail = Mailbox & { folders: Folder[] };

const roleName: Record<string, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿箱",
  junk: "垃圾邮件",
  trash: "已删除",
  archive: "归档",
};

export default function MailHome() {
  const router = useRouter();
  const navigation = useNavigation();
  const { session } = useAuth();
  const [selected, setSelected] = useState("");
  const [switching, setSwitching] = useState(false);
  const [keyword, setKeyword] = useState("");
  const mailboxes = useQuery({
    queryKey: ["mailboxes", session?.origin],
    enabled: !!session,
    queryFn: () => api<{ mailboxes: Mailbox[] }>("/mail"),
  });
  const current = mailboxes.data?.mailboxes.find((item) => item.id === selected) ?? mailboxes.data?.mailboxes[0];
  const detail = useQuery({
    queryKey: ["mailbox", session?.origin, current?.id],
    enabled: !!session && !!current,
    queryFn: () => api<Detail>(`/mail/mailboxes/${current!.id}`),
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "邮箱",
      headerRight: () => <IconButton icon="cog-outline" onPress={() => setSwitching(true)} />,
    });
  }, [navigation]);

  if (mailboxes.isLoading) return <LoadingState />;
  if (mailboxes.isError) {
    return <EmptyState title={mailboxes.error instanceof Error ? mailboxes.error.message : "加载失败"} />;
  }
  if (!current) return <EmptyState title="还没有邮箱" />;

  const folders = detail.data?.folders ?? [];
  const inbox = folders.find((item) => item.role === "inbox");
  const rest = folders.filter((item) => item.role !== "inbox");

  function open(params: Record<string, string>) {
    router.push({
      pathname: "/mailbox/[id]",
      params: { id: current!.id, title: current!.displayName || current!.address, ...params },
    });
  }

  return (
    <View style={styles.page}>
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.account}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(current.displayName || current.address).slice(0, 1)}</Text>
        </View>
        <View style={styles.accountCopy}>
          <Text style={styles.name}>{current.displayName || current.address}</Text>
          <Text style={styles.address} numberOfLines={1}>{current.address}</Text>
        </View>
      </View>
      <TextInput
        value={keyword}
        onChangeText={setKeyword}
        placeholder="搜索"
        placeholderTextColor={colors.muted}
        returnKeyType="search"
        onSubmitEditing={() => {
          if (keyword.trim()) open({ q: keyword.trim() });
        }}
        style={styles.search}
      />
      <Text style={styles.section}>我的邮件</Text>
      <MailRow
        color="#ff9f0a"
        label="收件箱"
        count={inbox?.unread || inbox?.total}
        onPress={() => open(inbox ? { folderId: inbox.id } : {})}
      />
      <MailRow color="#f5c518" label="星标邮件" onPress={() => open({ starred: "true" })} />
      <MailRow color="#4c8dff" label="未读邮件" count={inbox?.unread} onPress={() => open({ unread: "true" })} />
      {rest.map((folder) => (
        <MailRow
          key={folder.id}
          color="#8f959e"
          label={roleName[folder.role] || folder.name}
          count={folder.unread || undefined}
          onPress={() => open({ folderId: folder.id, title: roleName[folder.role] || folder.name })}
        />
      ))}
      {switching ? (
        <View style={styles.switcher}>
          <Text style={styles.section}>切换邮箱</Text>
          {mailboxes.data?.mailboxes.map((item) => (
            <Pressable
              key={item.id}
              style={styles.switchRow}
              onPress={() => {
                setSelected(item.id);
                setSwitching(false);
              }}
            >
              <Text style={styles.name}>{item.displayName || item.address}</Text>
              <Text style={styles.address}>{item.address}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setSwitching(false)}>
            <Text style={styles.cancel}>完成</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
    <FAB
      icon="email-edit-outline"
      style={styles.fab}
      color="#fff"
      onPress={() => router.push({ pathname: "/compose", params: { mailboxId: current.id } })}
    />
    </View>
  );
}

function MailRow({
  color,
  label,
  count,
  onPress,
}: {
  color: string;
  label: string;
  count?: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={[styles.icon, { backgroundColor: color }]}>
        <Text style={styles.iconText}>{label.slice(0, 1)}</Text>
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      {count ? <Text style={styles.count}>{count}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  content: { paddingBottom: 32 },
  account: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#e8f3ff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.accent, fontSize: 18, fontWeight: "700" },
  accountCopy: { flex: 1 },
  name: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  address: { color: colors.muted, fontSize: 12, marginTop: 2 },
  search: {
    margin: 16,
    height: 36,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: "#f2f3f5",
    color: colors.ink,
  },
  section: { color: colors.muted, fontSize: 13, marginHorizontal: 16, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  iconText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  rowLabel: { flex: 1, color: colors.ink, fontSize: 16 },
  count: { color: colors.muted, fontSize: 14 },
  switcher: {
    marginTop: 12,
    marginHorizontal: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.bg,
    gap: 8,
  },
  switchRow: { paddingVertical: 8 },
  cancel: { color: colors.accent, textAlign: "center", paddingVertical: 8 },
  fab: { position: "absolute", right: 16, bottom: 16, backgroundColor: colors.accent },
});
