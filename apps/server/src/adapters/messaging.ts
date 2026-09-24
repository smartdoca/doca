export type VerificationMessage = {
  kind: "phone" | "email";
  destination: string;
  code: string;
  purpose: string;
  expiresInSeconds: number;
};
export interface MessagingRuntime {
  send?: (message: VerificationMessage) => Promise<void>;
  secret: string;
  phoneReady: boolean;
  emailReady: boolean;
}
/** Build the initial messaging runtime from deployment configuration. */
export function messagingRuntime(): MessagingRuntime {
  const endpoint = process.env.DOCA_VERIFICATION_ENDPOINT,
    key = process.env.DOCA_VERIFICATION_SECRET ?? "";
  const channels = (process.env.DOCA_VERIFICATION_CHANNELS ?? "").split(",");
  return configuredMessaging({
    endpoint: endpoint ?? "",
    secret: key,
    channels,
  });
}
export function configuredMessaging(config: {
  endpoint: string;
  secret: string;
  channels: string[];
}): MessagingRuntime {
  const { endpoint, secret: key, channels } = config;
  return {
    secret: key,
    phoneReady: !!endpoint && !!key && channels.includes("phone"),
    emailReady: !!endpoint && !!key && channels.includes("email"),
    ...(endpoint && key
      ? {
          send: async (message: VerificationMessage) => {
            const url = new URL(endpoint);
            if (url.protocol !== "https:" || url.username || url.password)
              throw new Error("验证码发送服务配置无效");
            const response = await fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(message),
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) throw new Error("验证码发送失败，请稍后再试");
          },
        }
      : {}),
  };
}
