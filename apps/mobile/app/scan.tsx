import { CameraView, useCameraPermissions } from "expo-camera";
import { useNavigation } from "expo-router";
import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Text } from "react-native-paper";
import { ApiError, confirmQrLogin } from "../src/api";
import { useAuth } from "../src/auth";
import { colors } from "../src/chrome";
import { parseLoginQr } from "../src/login-qr";
import { removeAccount } from "../src/session";

export default function ScanLogin() {
  const navigation = useNavigation();
  const { accounts, refresh } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState("");
  const [pending, setPending] = useState<{ origin: string; code: string } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: "扫码登录" });
  }, [navigation]);

  function accept(value: string) {
    const parsed = parseLoginQr(value);
    if (!parsed) {
      setError("这不是 Doca 登录二维码");
      return;
    }
    setError("");
    setMessage("");
    setPending(parsed);
  }

  function onScan({ data }: { data: string }) {
    if (locked.current || pending) return;
    locked.current = true;
    accept(data);
  }

  const account = accounts.find((item) => item.origin === pending?.origin);

  async function confirm() {
    if (!pending || !account) return;
    setBusy(true);
    setError("");
    try {
      await confirmQrLogin(account, pending.code);
      setMessage(`网页已使用「${account.name}」登录`);
      setPending(null);
      locked.current = false;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        await removeAccount(account.origin);
        await refresh();
        setPending(null);
        locked.current = false;
        setError("这个服务器的登录已失效，请重新登录后再扫码");
      } else {
        setError(reason instanceof Error ? reason.message : "确认失败");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      {permission?.granted ? (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={pending ? undefined : onScan}
        />
      ) : (
        <View style={styles.cameraFallback}>
          <Text style={styles.fallbackText}>需要相机权限才能扫码</Text>
          <Pressable style={styles.button} onPress={() => void requestPermission()}>
            <Text style={styles.buttonText}>允许使用相机</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.panel}>
        {pending ? (
          <View>
            <Text style={styles.title}>确认登录网页</Text>
            <Text style={styles.copy}>{pending.origin}</Text>
            {account ? (
              <Text style={styles.copy}>将使用「{account.name}」确认，不会切换手机当前服务器。</Text>
            ) : (
              <Text style={styles.copy}>这个服务器还没有登录。请先在设置里添加并登录它，再回来扫码。</Text>
            )}
            {account ? (
              <Pressable style={styles.button} disabled={busy} onPress={() => void confirm()}>
                <Text style={styles.buttonText}>{busy ? "正在确认…" : `确认使用「${account.name}」登录`}</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => { setPending(null); locked.current = false; }}>
              <Text style={styles.link}>取消</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Text style={styles.title}>{message || "扫描网页上的登录二维码"}</Text>
            <TextInput
              value={payload}
              onChangeText={setPayload}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="或粘贴二维码内容"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <Pressable style={styles.button} onPress={() => accept(payload)}>
              <Text style={styles.buttonText}>使用这段内容</Text>
            </Pressable>
          </View>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  cameraFallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: colors.bg },
  fallbackText: { color: colors.ink, fontSize: 16, marginBottom: 16 },
  panel: { backgroundColor: "#fff", padding: 16, paddingBottom: 28 },
  title: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  copy: { color: colors.secondary, fontSize: 14, marginTop: 8, lineHeight: 20 },
  input: {
    height: 40,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.ink,
  },
  button: {
    height: 44,
    marginTop: 12,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  link: { color: colors.secondary, textAlign: "center", marginTop: 12 },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
});
