import type { MessageKey } from "@doca/i18n";

type Translator = (key: MessageKey) => string;
export function fileLocationError(message: string, t: Translator) {
  const keys: Record<string, MessageKey> = {
    "fileManager.invalidSessionBinding": "fileManager.invalidSessionBinding",
    "fileManager.invalidSessionFolder": "fileManager.invalidSessionFolder",
    "fileManager.sessionFolderMissing": "fileManager.sessionFolderMissing",
    "fileManager.sessionFolderReadOnly": "fileManager.sessionFolderReadOnly",
  };
  const key = keys[message];
  return key ? t(key) : message;
}

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
  const key = location.type === "system" ? (location.id.startsWith("knowledge-assistant:") ? "fileManager.knowledgeAssistantFiles" : keys[location.id]) : undefined;
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
