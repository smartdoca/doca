import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, Fragment } from "react";
import { AppState, Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { useRouter, type Href } from "expo-router";
import {
  Package,
  Home,
  BookOpen,
  FolderOpen,
  Sparkles,
  Settings,
  UserRound,
  Mail,
  MoreHorizontal,
} from "lucide-react-native";
import {
  builtinNavigation,
  resolveNavigation,
  type ResolvedNavigation,
  type NavigationEntry,
  type NavigationSlot,
} from "@smartdoca/web-plugin-registry";
import { api } from "../api";
import { useAuth } from "../auth";
import { useI18n } from "../locale";
import { colors } from "../chrome";
export function useMobileNavigation() {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: ["navigation", session?.origin, session?.token],
    enabled: !!session,
    queryFn: () => api<ResolvedNavigation>("/navigation"),
    refetchInterval: 30000,
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && session) void query.refetch();
    });
    return () => sub.remove();
  }, [session?.origin, session?.token]);
  return {
    ...query,
    data:
      query.data ??
      resolveNavigation(
        builtinNavigation,
        {schemaVersion:1,layout:{placements:[]}},
        { id: "", admin: false },
      ),
  };
}
export function mobileEntryPath(entry: NavigationEntry): Href {
  return (
    entry.pluginId
      ? `/plugin/${encodeURIComponent(entry.id)}`
      : (entry.mobilePath ?? "/")
  ) as Href;
}
const icons: Record<string, typeof Package> = {
  home: Home,
  libraries: BookOpen,
  files: FolderOpen,
  ai: Sparkles,
  preferences: Settings,
  account: UserRound,
  mail: Mail,
};
export function MobileNavigationArea({
  slot,
  close,
  horizontal = false,
}: {
  slot: NavigationSlot;
  close?: () => void;
  horizontal?: boolean;
}) {
  const { data } = useMobileNavigation(),
    { locale, t } = useI18n(),
    router = useRouter();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const placements = data.layout.placements.filter((p) => p.slot === slot);
  return (
    <View
      style={{
        flexDirection: horizontal ? "row" : "column",
        flexWrap: "wrap",
        gap: 4,
      }}
    >
      {data.layout.placements
        .filter((p) => p.slot === slot)
        .map((p, index) => {
          const entry = data.entries.find((e) => e.id === p.entryId);
          if (!entry) return null;
          const Icon = icons[p.icon ?? entry.icon] ?? Package,
            title = (p.title ?? entry.title)[locale];
          const group = p.group ?? "";
          const first =
            group && !placements.slice(0, index).some((x) => x.group === group);
          const folded = collapsed[group] ?? p.collapsed ?? false;
          return (
            <Fragment key={entry.id}>
              {!horizontal && first && (
                <Pressable
                  onPress={() =>
                    setCollapsed({ ...collapsed, [group]: !folded })
                  }
                >
                  <Text style={{ padding: 12, fontWeight: "bold" }}>
                    {group} {folded ? "+" : "−"}
                  </Text>
                </Pressable>
              )}
              {(horizontal || !group || !folded) && (
                <Pressable
                  key={entry.id}
                  accessibilityLabel={title}
                  onPress={() => {
                    close?.();
                    router.navigate(mobileEntryPath(entry));
                  }}
                  style={{
                    padding: 12,
                    flexDirection: horizontal ? "column" : "row",
                    gap: 8,
                    alignItems: "center",
                    flex: horizontal ? 1 : undefined,
                  }}
                >
                  {p.display !== "text" && (
                    <Icon color={colors.accent} size={20} />
                  )}
                  {p.display !== "icon" && <Text>{title}</Text>}
                </Pressable>
              )}
            </Fragment>
          );
        })}
      {slot === "mobile.bottom" && (
        <Pressable
          onPress={() => router.push("/extensions" as Href)}
          accessibilityLabel={t("navigation.more")}
          style={{ padding: 12, alignItems: "center", flex: 1 }}
        >
          <MoreHorizontal color={colors.accent} size={20} />
          <Text>{t("navigation.more")}</Text>
        </Pressable>
      )}
    </View>
  );
}
