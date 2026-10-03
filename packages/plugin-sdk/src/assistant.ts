/** Open the signed-in user's personal assistant through the host. */
export interface PluginAssistantOpenInput {
  readonly prompt?: string;
  /** Plain text appended to the editable user prompt, never a system instruction. */
  readonly context?: string;
  readonly documentIds?: readonly string[];
  /** Existing host files, copied through the authorized AI attachment endpoint. */
  readonly attachmentFileIds?: readonly string[];
  /** Omit to create a new conversation. */
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly autoSend?: boolean;
}
export interface PluginAssistantOpenResult {
  readonly sessionId: string;
  readonly jobId?: string;
}
export interface PluginAssistantClient {
  open(input?: PluginAssistantOpenInput): Promise<PluginAssistantOpenResult>;
}
export interface AssistantLaunchDraft {
  readonly userId: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly text: string;
  readonly references: { resourceId: string; label: string; format: string }[];
  readonly attachments: {
    id: string;
    filename: string;
    mime: string;
    size: number;
    extractStatus?: "pending" | "ready" | "failed";
    preview?: string;
    description?: string;
    sourceFileId?: string;
    sourceName?: string;
  }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = new Set([
  "prompt",
  "context",
  "documentIds",
  "attachmentFileIds",
  "sessionId",
  "modelId",
  "autoSend",
]);
export function validateAssistantOpenInput(
  value: unknown,
): PluginAssistantOpenInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.has(key))
  )
    throw new Error("Invalid assistant launch parameters");
  const input = value as PluginAssistantOpenInput;
  for (const key of ["prompt", "context"] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > 20_000)
    )
      throw new Error(`Invalid assistant ${key}`);
  const text = [input.prompt, input.context]
    .filter((part) => part?.trim())
    .join("\n\n")
    .trim();
  if (text.length > 20_000)
    throw new Error("Assistant prompt and context exceed 20000 characters");
  if (input.autoSend !== undefined && typeof input.autoSend !== "boolean")
    throw new Error("Invalid assistant autoSend");
  if (input.autoSend && !text)
    throw new Error("autoSend requires a non-empty prompt or context");
  if (
    input.sessionId !== undefined &&
    (typeof input.sessionId !== "string" || !uuid.test(input.sessionId))
  )
    throw new Error("Invalid assistant sessionId");
  if (
    input.modelId !== undefined &&
    (typeof input.modelId !== "string" ||
      !input.modelId.trim() ||
      input.modelId.length > 200)
  )
    throw new Error("Invalid assistant modelId");
  for (const [key, max] of [
    ["documentIds", 20],
    ["attachmentFileIds", 8],
  ] as const) {
    const ids = input[key];
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > max ||
        ids.some((id) => typeof id !== "string" || !uuid.test(id)) ||
        new Set(ids).size !== ids.length)
    )
      throw new Error(`Invalid assistant ${key}`);
  }
  // Copy the parameters so callers cannot mutate them while authorization is running.
  return {
    ...input,
    documentIds: input.documentIds?.slice(),
    attachmentFileIds: input.attachmentFileIds?.slice(),
  };
}

/** Host adapter: every read/send uses authenticated host routes and their current ACLs. */
export function createPluginAssistantClient(
  pluginId: string,
  request: <T>(path: string, body?: unknown) => Promise<T>,
  present: (
    draft: AssistantLaunchDraft | null,
    result: PluginAssistantOpenResult,
  ) => void | Promise<void>,
  newId: () => string,
): PluginAssistantClient {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(pluginId))
    throw new Error("Invalid assistant plugin ID");
  let opening = false;
  return Object.freeze({
    async open(value: PluginAssistantOpenInput = {}) {
      if (opening) throw new Error("Assistant launch already in progress");
      const input = validateAssistantOpenInput(value);
      opening = true;
      try {
        const platform = <T>(operation: string, body: unknown) =>
          request<T>(`/plugin-platform/${pluginId}/${operation}`, body);
        const user = await platform<{ id: string }>("users.me", {});
        const checkUser = async () => {
          if ((await platform<{ id: string }>("users.me", {})).id !== user.id)
            throw new Error("Assistant account changed during launch");
        };
        const options = await request<{
          defaultModel: string;
          preferences?: { default_model?: string | null };
          models: { id: string }[];
          webSearchAvailable: boolean;
        }>("/ai/options");
        let session:
          | { id: string; model_id: string | null; archived?: number }
          | undefined;
        if (input.sessionId) {
          const detail = await request<{
            session: NonNullable<typeof session>;
          }>(`/ai/sessions/${input.sessionId}`);
          session = detail.session;
          if (session.archived)
            throw new Error(
              "Restore the archived conversation before opening it",
            );
        }
        const modelId =
          input.modelId ??
          session?.model_id ??
          options.preferences?.default_model ??
          options.defaultModel;
        if (modelId && !options.models.some((model) => model.id === modelId))
          throw new Error("Assistant model is unavailable");
        if (input.autoSend && !modelId)
          throw new Error("No assistant model is available");
        const references: AssistantLaunchDraft["references"] = [];
        for (const documentId of input.documentIds ?? []) {
          const document = await platform<{
            id: string;
            kind: string;
            title: string;
            format: string;
          }>("documents.get", { documentId });
          if (document.kind !== "document")
            throw new Error("Assistant references must be documents");
          references.push({
            resourceId: document.id,
            label: document.title,
            format: document.format,
          });
        }
        const files: { id: string; name: string; size: number }[] = [];
        for (const fileId of input.attachmentFileIds ?? []) {
          const file = await platform<(typeof files)[number] | null>(
            "files.files.get",
            { fileId },
          );
          if (!file) throw new Error("Assistant attachment is unavailable");
          files.push(file);
        }
        if (
          files.some((file) => file.size > 20 * 1024 * 1024) ||
          files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024
        )
          throw new Error("Assistant attachments exceed the size limit");
        await checkUser();
        const attachments: AssistantLaunchDraft["attachments"] = [];
        for (const file of files) {
          const attachment = await request<
            AssistantLaunchDraft["attachments"][number]
          >(`/files/items/${file.id}/attach`, { purpose: "ai_attachment" });
          attachments.push({
            ...attachment,
            sourceFileId: file.id,
            sourceName: file.name,
          });
        }
        if (
          input.autoSend &&
          attachments.some((file) => file.extractStatus === "pending")
        )
          throw new Error(
            "Attachments are still being parsed; open a draft or retry when parsing completes",
          );
        await checkUser();
        const targetSession =
          session ??
          (await request<{ id: string }>("/ai/sessions", {
            modelId: modelId || null,
            resourceIds: input.documentIds ?? [],
          }));
        const draft: AssistantLaunchDraft = {
          userId: user.id,
          sessionId: targetSession.id,
          modelId: modelId || "",
          text: [input.prompt, input.context]
            .filter((part) => part?.trim())
            .join("\n\n")
            .trim(),
          references,
          attachments,
        };
        const result: PluginAssistantOpenResult = {
          sessionId: targetSession.id,
          ...(input.autoSend ? { jobId: newId() } : {}),
        };
        if (result.jobId)
          await request(`/ai/sessions/${targetSession.id}/messages`, {
            id: result.jobId,
            text: draft.text,
            modelId,
            scope: "all",
            references,
            attachments: attachments.map((file) => file.id),
            webSearch: !!options.webSearchAvailable,
          });
        await checkUser();
        await present(result.jobId ? null : draft, result);
        return result;
      } finally {
        opening = false;
      }
    },
  });
}
