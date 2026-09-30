import { MobileNavigationArea } from "../../src/plugins/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Drawer } from "react-native-drawer-layout";
import { Tabs, useRouter, useSegments } from "expo-router";
import { BookOpen, ChevronRight, FolderOpen, Home, Settings, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { IconButton } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../src/api";
import { setAiSession } from "../../src/ai-session";
import { useAuth } from "../../src/auth";
import { colors } from "../../src/chrome";
import { useI18n } from "../../src/locale";
import {
  mobilePluginMessage,
  mobilePluginRegistry,
} from "../../src/plugins/registry";

type AiSession = { id: string; title: string };

function AccountMenu({ close }: { close: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { locale } = useI18n();
  const initial = (session?.name || "我").slice(0, 1);

  function open(path: "/account" | "/settings") {
    close();
    router.push(path);
  }

  return (
    <View style={[styles.menu, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 12 }]}>
      <Pressable style={styles.user} onPress={() => open("/account")}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.userCopy}>
          <Text style={styles.name}>{session?.name || "未登录"}</Text>
          <Text style={styles.origin} numberOfLines={1}>
            个人信息
          </Text>
        </View>
        <ChevronRight color={colors.muted} size={18} />
      </Pressable>
      <MobileNavigationArea slot="mobile.account" close={close}/>
      <MobileNavigationArea slot="mobile.drawer" close={close}/>
    </View>
  );
}

function SessionMenu({ close }: { close: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const [menuError, setMenuError] = useState("");
  const sessions = useQuery({
    queryKey: ["ai-sessions", session?.origin],
    enabled: !!session,
    queryFn: () => api<AiSession[]>("/ai/sessions?archived=false"),
  });

  function openSession(id: string) {
    setAiSession(id);
    close();
    router.navigate("/ai");
  }

  async function createSession() {
    setMenuError("");
    try {
      const options = await api<{
        defaultModel: string;
        models: { id: string }[];
        preferences?: { default_model?: string | null };
      }>("/ai/options");
      const modelId = options.preferences?.default_model || options.defaultModel || options.models[0]?.id;
      if (!modelId) {
        setMenuError("还没有可用的模型");
        return;
      }
      const created = await api<{ id: string }>("/ai/sessions", { body: { title: "新对话", modelId } });
      await client.invalidateQueries({ queryKey: ["ai-sessions", session?.origin] });
      openSession(created.id);
    } catch (reason) {
      setMenuError(reason instanceof Error ? reason.message : "无法新建对话");
    }
  }

  return (
    <View style={[styles.menu, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 12 }]}>
      <MobileNavigationArea slot="mobile.drawer" close={close}/>
      <View style={styles.sessionHead}>
        <Text style={styles.section}>对话</Text>
        <Pressable onPress={() => void createSession()}>
          <Text style={styles.link}>新对话</Text>
        </Pressable>
      </View>
      {menuError ? <Text style={styles.error}>{menuError}</Text> : null}
      <ScrollView>
        {(sessions.data ?? []).map((item) => (
          <Pressable key={item.id} style={styles.item} onPress={() => openSession(item.id)}>
            <Sparkles color={colors.secondary} size={16} />
            <Text style={styles.itemText} numberOfLines={1}>
              {item.title || "新对话"}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export default function TabsLayout() {
  const [open, setOpen] = useState(false);
  const ai = useSegments().includes("ai");
  const { locale } = useI18n();
  const librariesTab =
    mobilePluginRegistry.tabs.getByConflictKey("libraries");
  const filesTab = mobilePluginRegistry.tabs.getByConflictKey("files");
  return (
    <Drawer
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      swipeEdgeWidth={28}
      drawerStyle={styles.drawer}
      renderDrawerContent={() =>
        ai ? <SessionMenu close={() => setOpen(false)} /> : <AccountMenu close={() => setOpen(false)} />
      }
    >
      <Tabs
        tabBar={() => <View style={{backgroundColor:"white",paddingBottom:8}}><MobileNavigationArea slot="mobile.bottom" horizontal/></View>}
        screenOptions={{
          headerTintColor: colors.ink,
          headerStyle: { backgroundColor: "#fff" },
          headerShadowVisible: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.muted,
          tabBarStyle: { backgroundColor: "#fff", borderTopColor: colors.lineSoft },
          headerRight: () => <MobileNavigationArea slot="mobile.topRight" horizontal/>,
          headerLeft: () => <IconButton icon="menu" onPress={() => setOpen(true)} />,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "首页",
            tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="libraries"
          options={{
            title: librariesTab
              ? mobilePluginMessage(locale, librariesTab.labelKey)
              : "知识库",
            tabBarIcon: ({ color, size }) => <BookOpen color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: filesTab
              ? mobilePluginMessage(locale, filesTab.labelKey)
              : "文件",
            tabBarIcon: ({ color, size }) => <FolderOpen color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="ai"
          options={{
            title: "AI",
            tabBarIcon: ({ color, size }) => <Sparkles color={color} size={size} />,
          }}
        />
      </Tabs>
    </Drawer>
  );
}

const styles = StyleSheet.create({
  drawer: { width: 288, backgroundColor: "#fff" },
  menu: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16 },
  user: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 28 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.selected,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.accent, fontSize: 18, fontWeight: "700" },
  userCopy: { flex: 1 },
  name: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  origin: { color: colors.muted, fontSize: 12, marginTop: 2 },
  section: { color: colors.muted, fontSize: 12, marginBottom: 8 },
  sessionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
  link: { color: colors.accent, fontSize: 13, marginBottom: 8 },
  error: { color: colors.danger, fontSize: 12, marginBottom: 8 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  itemText: { color: colors.ink, fontSize: 16 },
});
