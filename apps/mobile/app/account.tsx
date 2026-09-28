import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "expo-router";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Text } from "react-native-paper";
import { ApiError, api } from "../src/api";
import { useAuth } from "../src/auth";
import { colors } from "../src/chrome";
import { loadSession, saveSession } from "../src/session";

type Me = {
  profileName: string;
  editable?: { displayName?: boolean };
  preferences: {
    version: number;
    avatar: string;
    avatar_asset_id?: string | null;
  };
  user: { public_id?: string };
};
type AccountInfo = {
  editable: Record<string, boolean>;
  contacts: { kind: string; value: string }[];
  policy: {
    fields?: { email?: { enabled?: boolean }; phone?: { enabled?: boolean } };
  };
};
type Identities = {
  login: string;
  passwordEnabled: boolean;
  passwordAllowed: boolean;
};
type Security = {
  methods: { id: string; label: string; value: string }[];
  verified: boolean;
};
type ContactKind = "phone" | "email";

const avatars = new Set([
  "initials",
  "fox",
  "panda",
  "cat",
  "dog",
  "rabbit",
  "lion",
  "tiger",
  "bear",
  "koala",
  "monkey",
  "penguin",
  "owl",
  "dragon",
  "whale",
  "butterfly",
  "leaf",
  "cactus",
  "sun",
  "moon",
  "rocket",
]);
const labels: Record<string, string> = {
  phone: "手机号",
  email: "邮箱",
  password: "密码",
};

async function accountCall<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    flow?: string;
    mobile?: boolean;
  } = {},
) {
  const session = await loadSession();
  if (!session) throw new ApiError(401, "请先登录");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${session.token}`,
  };
  if (init.flow) headers.cookie = `doca_account_flow=${init.flow}`;
  if (init.mobile) headers["x-doca-client"] = "mobile";
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const response = await fetch(`${session.origin}/api/v1${path}`, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new ApiError(response.status, data.message ?? "请求失败");
  return data as T;
}

export default function Account() {
  const navigation = useNavigation();
  const client = useQueryClient();
  const { session, refresh, signOut } = useAuth();
  const flow = useRef("");
  const [name, setName] = useState("");
  const [nameReady, setNameReady] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [kind, setKind] = useState<ContactKind>("phone");
  const [contact, setContact] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [securityKind, setSecurityKind] = useState<ContactKind>("phone");
  const [securityChallenge, setSecurityChallenge] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: "个人信息" });
  }, [navigation]);

  const me = useQuery({
    queryKey: ["me", session?.origin],
    enabled: !!session,
    queryFn: () => api<Me>("/me"),
  });
  const account = useQuery({
    queryKey: ["me-account", session?.origin],
    enabled: !!session,
    queryFn: () => api<AccountInfo>("/me/account"),
  });
  const identities = useQuery({
    queryKey: ["me-identities", session?.origin],
    enabled: !!session,
    queryFn: () => api<Identities>("/me/identities"),
  });
  const security = useQuery({
    queryKey: ["me-security", session?.origin],
    enabled: !!session,
    queryFn: () => api<Security>("/me/security"),
  });

  if (me.data && !nameReady) {
    setName(me.data.profileName || "");
    setNameReady(true);
  }

  const phoneOn = account.data?.policy.fields?.phone?.enabled !== false;
  const emailOn = account.data?.policy.fields?.email?.enabled !== false;
  const methods = security.data?.methods ?? [];
  const verified = !!security.data?.verified;
  const contactMethods = methods.filter(
    (item) => item.id === "phone" || item.id === "email",
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    if (!me.data) return;
    const displayName = name.trim();
    const avatar = avatars.has(me.data.preferences.avatar)
      ? me.data.preferences.avatar
      : "initials";
    await api("/me/profile", {
      method: "PUT",
      body: {
        version: me.data.preferences.version,
        displayName,
        avatar,
        avatarAssetId: me.data.preferences.avatar_asset_id ?? null,
      },
    });
    if (session) {
      await saveSession({ ...session, name: displayName || session.name });
      await refresh();
    }
    await client.invalidateQueries({ queryKey: ["me", session?.origin] });
    setMessage("昵称已保存");
  }

  async function verifyPassword() {
    await api("/auth/reauth", { body: { password: currentPassword } });
    setCurrentPassword("");
    await client.invalidateQueries({
      queryKey: ["me-security", session?.origin],
    });
    setMessage("安全验证通过，5 分钟内可以修改一项认证信息");
  }

  async function sendSecurityCode() {
    const method = contactMethods.find((item) => item.id === securityKind);
    if (!method?.value) return;
    const started = await accountCall<{ challengeId: string; flow?: string }>(
      "/auth/challenges",
      {
        body: { kind: securityKind, value: method.value, purpose: "security" },
        mobile: true,
        flow: flow.current,
      },
    );
    if (started.flow) flow.current = started.flow;
    setSecurityChallenge(started.challengeId);
    setSecurityCode("");
    setMessage("验证码已发送，5 分钟内有效");
  }

  async function confirmSecurityCode() {
    const result = await accountCall<{ proof: string }>(
      "/auth/challenges/verify",
      {
        body: { challengeId: securityChallenge, code: securityCode },
        flow: flow.current,
      },
    );
    await accountCall("/auth/security/contact", {
      body: { kind: securityKind, proof: result.proof },
      flow: flow.current,
    });
    setSecurityChallenge("");
    setSecurityCode("");
    await client.invalidateQueries({
      queryKey: ["me-security", session?.origin],
    });
    setMessage("安全验证通过，5 分钟内可以修改一项认证信息");
  }

  async function changePassword(setup: boolean) {
    if (nextPassword.length < 12) throw new Error("密码至少 12 位");
    if (setup) {
      await api("/auth/password/setup", { body: { password: nextPassword } });
      setNextPassword("");
      await client.invalidateQueries({
        queryKey: ["me-identities", session?.origin],
      });
      await client.invalidateQueries({
        queryKey: ["me-security", session?.origin],
      });
      setMessage("密码已设置");
      return;
    }
    await api("/auth/password", { body: { newPassword: nextPassword } });
    Alert.alert("密码已修改", "所有设备上的登录已退出，请用新密码重新登录。", [
      { text: "确定", onPress: () => void signOut() },
    ]);
  }

  async function sendContactCode() {
    const started = await accountCall<{ challengeId: string; flow?: string }>(
      "/auth/challenges",
      {
        body: { kind, value: contact, purpose: "contact" },
        mobile: true,
        flow: flow.current,
      },
    );
    if (started.flow) flow.current = started.flow;
    setChallengeId(started.challengeId);
    setCode("");
    setMessage("验证码已发送，5 分钟内有效");
  }

  async function saveContact() {
    const result = await accountCall<{ proof: string }>(
      "/auth/challenges/verify",
      {
        body: { challengeId, code },
        flow: flow.current,
      },
    );
    await accountCall("/me/contacts", {
      method: "PUT",
      body: { kind, proof: result.proof },
      flow: flow.current,
    });
    setContact("");
    setCode("");
    setChallengeId("");
    await client.invalidateQueries({
      queryKey: ["me-account", session?.origin],
    });
    await client.invalidateQueries({
      queryKey: ["me-security", session?.origin],
    });
    setMessage("联系方式已保存");
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.section}>个人资料</Text>
      <View style={styles.card}>
        <Text style={styles.label}>昵称</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          editable={me.data?.editable?.displayName !== false && !busy}
          maxLength={160}
          placeholder="昵称"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        <Text style={styles.note}>
          用户标识：@{me.data?.user.public_id || "…"}
        </Text>
        <Pressable
          style={styles.button}
          disabled={busy || !name.trim()}
          onPress={() => void run(saveName)}
        >
          <Text style={styles.buttonText}>保存昵称</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>已绑定</Text>
      <View style={styles.card}>
        <Text style={styles.line}>账号：{identities.data?.login || "…"}</Text>
        <Text style={styles.line}>
          密码：{identities.data?.passwordEnabled ? "已设置" : "未设置"}
        </Text>
        {(account.data?.contacts ?? []).map((item) => (
          <Text key={item.kind} style={styles.line}>
            {labels[item.kind] || item.kind}：{item.value}
            {account.data?.editable[item.kind] === false
              ? " · 由认证源管理"
              : ""}
          </Text>
        ))}
        {!account.data?.contacts.length ? (
          <Text style={styles.note}>还没有绑定手机号或邮箱</Text>
        ) : null}
      </View>

      <Text style={styles.section}>安全验证</Text>
      <View style={styles.card}>
        <Text style={styles.note}>
          {verified
            ? "已通过，5 分钟内可以修改一项认证信息。"
            : "修改密码或联系方式前，先用已绑定的方式验证身份。"}
        </Text>
        {methods.some((item) => item.id === "password") ? (
          <>
            <TextInput
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
              placeholder="当前密码"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <Pressable
              style={styles.button}
              disabled={busy || !currentPassword}
              onPress={() => void run(verifyPassword)}
            >
              <Text style={styles.buttonText}>验证身份</Text>
            </Pressable>
          </>
        ) : null}
        {contactMethods.length ? (
          <>
            <View style={styles.choices}>
              {contactMethods.map((item) => (
                <Pressable
                  key={item.id}
                  style={[
                    styles.choice,
                    securityKind === item.id && styles.choiceOn,
                  ]}
                  onPress={() => {
                    setSecurityKind(item.id as ContactKind);
                    setSecurityChallenge("");
                  }}
                >
                  <Text
                    style={
                      securityKind === item.id
                        ? styles.choiceTextOn
                        : styles.choiceText
                    }
                  >
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              style={styles.button}
              disabled={busy}
              onPress={() => void run(sendSecurityCode)}
            >
              <Text style={styles.buttonText}>
                {securityChallenge ? "重新发送验证码" : "发送验证码"}
              </Text>
            </Pressable>
            {securityChallenge ? (
              <>
                <TextInput
                  value={securityCode}
                  onChangeText={setSecurityCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="6 位验证码"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
                <Pressable
                  style={styles.button}
                  disabled={busy || securityCode.length !== 6}
                  onPress={() => void run(confirmSecurityCode)}
                >
                  <Text style={styles.buttonText}>确认验证码</Text>
                </Pressable>
              </>
            ) : null}
          </>
        ) : null}
        {!methods.length ? (
          <Text style={styles.note}>
            没有可用的安全验证方式，请联系管理员。
          </Text>
        ) : null}
        {methods.length > 0 &&
        !methods.some((item) => item.id === "password") &&
        !contactMethods.length ? (
          <Text style={styles.note}>
            当前只能通过网页上的身份源完成安全验证。
          </Text>
        ) : null}
      </View>

      {identities.data?.passwordAllowed ? (
        <>
          <Text style={styles.section}>
            {identities.data.passwordEnabled ? "修改密码" : "设置密码"}
          </Text>
          <View style={styles.card}>
            <Text style={styles.note}>
              {identities.data.passwordEnabled
                ? "修改成功后，所有设备都需要用新密码重新登录。"
                : "密码至少 12 位。"}
            </Text>
            <TextInput
              value={nextPassword}
              onChangeText={setNextPassword}
              secureTextEntry
              placeholder="新密码"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
            <Pressable
              style={styles.button}
              disabled={busy || nextPassword.length < 12}
              onPress={() =>
                void run(() =>
                  changePassword(!identities.data?.passwordEnabled),
                )
              }
            >
              <Text style={styles.buttonText}>
                {identities.data.passwordEnabled
                  ? "修改密码并退出"
                  : "设置密码"}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {phoneOn || emailOn ? (
        <>
          <Text style={styles.section}>更换联系方式</Text>
          <View style={styles.card}>
            <Text style={styles.note}>
              手机号需要国家/地区码，例如
              +8613800138000。新号码不能属于其他账号。
            </Text>
            <View style={styles.choices}>
              {phoneOn ? (
                <Pressable
                  style={[styles.choice, kind === "phone" && styles.choiceOn]}
                  onPress={() => setKind("phone")}
                >
                  <Text
                    style={
                      kind === "phone" ? styles.choiceTextOn : styles.choiceText
                    }
                  >
                    手机号
                  </Text>
                </Pressable>
              ) : null}
              {emailOn ? (
                <Pressable
                  style={[styles.choice, kind === "email" && styles.choiceOn]}
                  onPress={() => setKind("email")}
                >
                  <Text
                    style={
                      kind === "email" ? styles.choiceTextOn : styles.choiceText
                    }
                  >
                    邮箱
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              value={contact}
              onChangeText={(value) => {
                setContact(value);
                setChallengeId("");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={kind === "email" ? "email-address" : "phone-pad"}
              placeholder={
                kind === "phone" ? "+8613800138000" : "name@example.com"
              }
              placeholderTextColor={colors.muted}
              editable={account.data?.editable[kind] !== false}
              style={styles.input}
            />
            <Pressable
              style={styles.button}
              disabled={busy || !contact.trim()}
              onPress={() => void run(sendContactCode)}
            >
              <Text style={styles.buttonText}>
                {challengeId ? "重新发送验证码" : "发送验证码"}
              </Text>
            </Pressable>
            {challengeId ? (
              <>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="6 位验证码"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
                <Pressable
                  style={styles.button}
                  disabled={busy || code.length !== 6}
                  onPress={() => void run(saveContact)}
                >
                  <Text style={styles.buttonText}>保存联系方式</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </>
      ) : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48 },
  section: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  label: { color: colors.secondary, fontSize: 13, marginBottom: 8 },
  line: { color: colors.ink, fontSize: 15, lineHeight: 24 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  input: {
    height: 40,
    marginTop: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  button: {
    height: 40,
    marginTop: 10,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  choices: { flexDirection: "row", gap: 8, marginTop: 10 },
  choice: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.bg,
  },
  choiceOn: { backgroundColor: colors.selected },
  choiceText: { color: colors.secondary, fontSize: 13 },
  choiceTextOn: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  message: { color: colors.ink, fontSize: 13, marginTop: 16, lineHeight: 20 },
});
