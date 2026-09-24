import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

export const colors = {
  bg: "#f7f8fa",
  ink: "#1f2329",
  muted: "#8f959e",
  secondary: "#646a73",
  line: "#dee0e3",
  lineSoft: "#eff0f1",
  card: "#ffffff",
  accent: "#3370ff",
  accentPressed: "#245bdb",
  selected: "#e1eaff",
  danger: "#f54a45",
};

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.empty}>
      <Text variant="titleMedium" style={{ color: colors.ink, textAlign: "center" }}>
        {title}
      </Text>
      {detail ? (
        <Text variant="bodyMedium" style={styles.detail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
  return (
    <Text variant="bodyLarge" style={styles.loading}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: "hidden",
  },
  empty: { alignItems: "center", marginTop: 72, paddingHorizontal: 32, gap: 8 },
  detail: { color: colors.muted, textAlign: "center" },
  loading: { margin: 24, color: colors.muted },
});
