import { Redirect } from "expo-router";
import { ActivityIndicator } from "react-native-paper";
import { useAuth } from "../src/auth";

export default function Index() {
  const { ready, session } = useAuth();
  if (!ready) return <ActivityIndicator style={{ marginTop: 48 }} />;
  if (!session) return <Redirect href="/login" />;
  return <Redirect href="/(tabs)" />;
}
