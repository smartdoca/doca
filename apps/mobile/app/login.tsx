import { zodResolver } from "@hookform/resolvers/zod";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { Button, HelperText, Text, TextInput } from "react-native-paper";
import { z } from "zod";
import { ApiError } from "../src/api";
import { useAuth } from "../src/auth";
import { colors } from "../src/chrome";

const schema = z.object({
  origin: z.string().trim().min(1, "请填写服务器地址"),
  login: z.string().trim().min(1, "请填写账号"),
  password: z.string().min(1, "请填写密码"),
});

type FormValues = z.infer<typeof schema>;

export default function Login() {
  const router = useRouter();
  const params = useLocalSearchParams<{ origin?: string; add?: string }>();
  const adding = params.add === "1";
  const { ready, session, signIn } = useAuth();
  const [error, setError] = useState("");
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      origin: typeof params.origin === "string" ? params.origin : "http://127.0.0.1:39130",
      login: "",
      password: "",
    },
  });

  if (!ready) return null;
  if (session && !adding) return <Redirect href="/(tabs)" />;

  async function submit(values: FormValues) {
    setError("");
    try {
      await signIn(values.origin, values.login, values.password, adding ? "back" : undefined);
    } catch (reason) {
      setError(reason instanceof ApiError || reason instanceof Error ? reason.message : "登录失败");
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
    <View style={styles.page}>
      <Text variant="headlineMedium" style={styles.title}>
        Doca
      </Text>
      <Text variant="bodyMedium" style={styles.hint}>
        {adding
          ? "登录后会记住这个服务器。切换时不会退出其他服务器。"
          : "填写与网页端相同的服务器地址。本机开发默认是 http://127.0.0.1:39130。已登录的服务器可在设置里切换。"}
      </Text>
      <Controller
        control={form.control}
        name="origin"
        render={({ field, fieldState }) => (
          <View>
            <TextInput
              mode="outlined"
              label="服务器"
              autoCapitalize="none"
              autoCorrect={false}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
            />
            <HelperText type="error" visible={!!fieldState.error}>
              {fieldState.error?.message}
            </HelperText>
          </View>
        )}
      />
      <Controller
        control={form.control}
        name="login"
        render={({ field, fieldState }) => (
          <View>
            <TextInput
              mode="outlined"
              label="账号"
              autoCapitalize="none"
              autoCorrect={false}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
            />
            <HelperText type="error" visible={!!fieldState.error}>
              {fieldState.error?.message}
            </HelperText>
          </View>
        )}
      />
      <Controller
        control={form.control}
        name="password"
        render={({ field, fieldState }) => (
          <View>
            <TextInput
              mode="outlined"
              label="密码"
              secureTextEntry
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
            />
            <HelperText type="error" visible={!!fieldState.error}>
              {fieldState.error?.message}
            </HelperText>
          </View>
        )}
      />
      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>
      <Button
        mode="contained"
        loading={form.formState.isSubmitting}
        disabled={form.formState.isSubmitting}
        onPress={form.handleSubmit(submit)}
      >
        登录
      </Button>
      {adding ? (
        <Button mode="text" onPress={() => router.back()}>
          返回
        </Button>
      ) : null}
    </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 72, gap: 4 },
  title: { marginBottom: 8, color: colors.ink },
  hint: { marginBottom: 16, color: colors.secondary },
});
