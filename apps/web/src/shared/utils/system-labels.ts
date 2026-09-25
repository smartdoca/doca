import type { MessageKey } from "@doca/i18n";

type Translator = (key: MessageKey) => string;
export function fileLocationLabel(
  location: { type: string; id: string; name: string },
  t: Translator,
) {
  const keys: Record<string, MessageKey> = {
    root: "nav.files",
    shared: "nav.sharedFiles",
    ai: "nav.assistant",
    documents: "nav.documents",
  };
  const key = location.type === "system" ? keys[location.id] : undefined;
  return key ? t(key) : location.name;
}

export type LoginMethodLabel = {
  kind: "password" | "phone" | "email" | "provider";
  name?: string;
};
export function loginMethodLabel(method: LoginMethodLabel, t: Translator) {
  const keys = {
    password: "authAdmin.password",
    phone: "accountPolicy.phoneCode",
    email: "accountPolicy.emailCode",
  } as const;
  return method.kind === "provider"
    ? (method.name ?? "")
    : t(keys[method.kind]);
}
