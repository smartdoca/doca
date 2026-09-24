import { Drawer } from "react-native-drawer-layout";
import { Tabs, useRouter } from "expo-router";
import { BookOpen, FolderOpen, Home, Mail, Settings, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { IconButton } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth";
import { colors } from "../../src/chrome";

function SideMenu({ close }: { close: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const initial = (session?.name || "我").slice(0, 1);
  return (
    <View style={[styles.menu, { paddingTop: insets.top + 20 }]}>
      <View style={styles.user}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.userCopy}>
          <Text style={styles.name}>{session?.name || "未登录"}</Text>
          <Text style={styles.origin} numberOfLines={1}>
            {session?.origin?.replace(/^https?:\/\//, "")}
          </Text>
        </View>
      </View>
      <Text style={styles.section}>账户</Text>
      <Pressable
        style={styles.item}
        onPress={() => {
          close();
          router.push("/mail");
        }}
      >
        <Mail color={colors.accent} size={18} />
        <Text style={styles.itemText}>邮箱</Text>
      </Pressable>
      <Pressable
        style={styles.item}
        onPress={() => {
          close();
          router.push("/settings");
        }}
      >
        <Settings color={colors.accent} size={18} />
        <Text style={styles.itemText}>设置</Text>
      </Pressable>
    </View>
  );
}

export default function TabsLayout() {
  const [open, setOpen] = useState(false);
  return (
    <Drawer
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      swipeEdgeWidth={28}
      drawerStyle={styles.drawer}
      renderDrawerContent={() => <SideMenu close={() => setOpen(false)} />}
    >
      <Tabs
        screenOptions={{
          headerTintColor: colors.ink,
          headerStyle: { backgroundColor: "#fff" },
          headerShadowVisible: false,
          sceneStyle: { backgroundColor: colors.bg },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.muted,
          tabBarStyle: { backgroundColor: "#fff", borderTopColor: colors.lineSoft },
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
            title: "知识库",
            tabBarIcon: ({ color, size }) => <BookOpen color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: "文件",
            tabBarIcon: ({ color, size }) => <FolderOpen color={color} size={size} />,
          }}
        />
        <Tabs.Screen name="mail" options={{ href: null, title: "邮箱" }} />
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
