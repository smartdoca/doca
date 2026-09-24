import { useRouter } from "expo-router";
import { Search } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { colors } from "../../src/chrome";
import { ResourceList } from "../../src/resource-list";

const tabs = [
  {
    key: "recent",
    label: "最近浏览",
    empty: "还没有最近浏览的文档",
    params: { scope: "recent", kind: "document", sort: "visited_at", order: "desc" },
  },
  {
    key: "owned",
    label: "我的文档",
    empty: "还没有归你所有的文档",
    params: { scope: "owned", kind: "document", sort: "updated_at", order: "desc" },
  },
  {
    key: "shared",
    label: "与我共享",
    empty: "还没有共享给你的文档",
    params: { scope: "shared", kind: "document", sort: "updated_at", order: "desc" },
  },
  {
    key: "favorites",
    label: "收藏文档",
    empty: "还没有收藏的文档",
    params: { scope: "favorites", kind: "document", sort: "updated_at", order: "desc" },
  },
  {
    key: "libraries",
    label: "收藏知识库",
    empty: "还没有收藏的知识库",
    params: { scope: "favorites", kind: "library", sort: "updated_at", order: "desc" },
  },
] as const;

export default function Home() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof tabs)[number]["key"]>("recent");
  const current = tabs.find((item) => item.key === tab) ?? tabs[0];
  return (
    <View style={styles.page}>
      <Pressable style={styles.search} onPress={() => router.push("/search")}>
        <Search color={colors.muted} size={16} />
        <Text style={styles.searchText}>搜索文档、文件和邮件</Text>
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabs}
      >
        {tabs.map((item) => {
          const active = item.key === current.key;
          return (
            <Pressable key={item.key} onPress={() => setTab(item.key)} style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <ResourceList params={{ ...current.params }} empty={current.empty} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  search: {
    height: 36,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchText: { color: colors.muted, fontSize: 14 },
  tabBar: { height: 48, flexGrow: 0, flexShrink: 0 },
  tabs: { alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  chip: {
    alignSelf: "flex-start",
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.selected, borderColor: colors.selected },
  chipText: { color: colors.secondary, fontSize: 14 },
  chipTextActive: { color: colors.accent, fontWeight: "600" },
});
