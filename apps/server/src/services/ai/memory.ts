import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { PostgresStore } from "@mastra/pg";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { AIReference } from "@core/workflows/ai-documents.js";

export async function createAIMemory(config?: {
  driver: "sqlite" | "postgres";
  url: string;
}) {
  const driver =
    config?.driver ??
    (process.env.DOCA_DATABASE === "postgres" ? "postgres" : "sqlite");
  let url =
    config?.url ??
    (driver === "postgres"
      ? process.env.DOCA_DATABASE_URL!
      : (process.env.DOCA_AI_SQLITE_PATH ??
        resolve(
          dirname(process.env.DOCA_SQLITE_PATH ?? "data/v1/doca.db"),
          "ai.db",
        )));
  if (driver === "sqlite" && url !== ":memory:" && !url.startsWith("file:")) {
    await mkdir(dirname(resolve(url)), { recursive: true });
    url = "file:" + resolve(url);
  }
  const storage =
    driver === "postgres"
      ? new PostgresStore({
          id: "doca-ai",
          connectionString: url,
          schemaName: "doca_ai",
        })
      : new LibSQLStore({ id: "doca-ai", url });
  const memory = new Memory({
    storage,
    options: {
      lastMessages: 0,
      generateTitle: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  });
  await storage.init();
  return {
    memory,
    storage,
    close: async () => {
      await memory.settled();
      await storage.close();
    },
  };
}
export type AIMemory = Awaited<ReturnType<typeof createAIMemory>>;
export const memoryOwner = (userId: string) => "doca-user:" + userId;
export function messageText(message: any): string {
  if (typeof message.content === "string") return message.content;
  return (message.content?.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");
}
export function messageReasoning(message: any): string {
  if (message.role !== "assistant") return "";
  return (message.content?.parts ?? [])
    .filter((p: any) => p.type === "reasoning")
    .map((p: any) =>
      typeof p.reasoning === "string"
        ? p.reasoning
        : typeof p.text === "string"
          ? p.text
          : "",
    )
    .join("\n");
}
export type ExplorerMessageTarget = {
  kind: "file" | "folder";
  id: string;
  name?: string;
};

export function explorerTargets(value: unknown): ExplorerMessageTarget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const targets: ExplorerMessageTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { kind?: unknown; id?: unknown; name?: unknown };
    if (row.kind !== "file" && row.kind !== "folder") continue;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      kind: row.kind,
      id: row.id,
      ...(typeof row.name === "string" && row.name.trim()
        ? { name: row.name.trim().slice(0, 255) }
        : {}),
    });
  }
  return targets;
}

export async function saveChatMessage(
  memory: Memory,
  userId: string,
  sessionId: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  references: AIReference[] = [],
  attachments: import("./attachments.js").AIAttachment[] = [],
  reasoning?: string,
  promptContext?: string,
  quickNotes: {id: string; label: string; version: number}[] = [],
  explorer: ExplorerMessageTarget[] = [],
) {
  await memory.saveMessages({
    messages: [
      {
        id,
        resourceId: memoryOwner(userId),
        threadId: sessionId,
        role,
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            ...(role === "assistant" && reasoning
              ? [
                  {
                    type: "reasoning" as const,
                    reasoning,
                    details: [{ type: "text" as const, text: reasoning }],
                  },
                ]
              : []),
            { type: "text", text },
          ],
          metadata: {
            references,
            attachments,
            ...(explorer.length ? { explorer } : {}),
            ...(quickNotes.length ? {quickNotes} : {}),
            ...(promptContext ? { promptContext } : {}),
          },
        },
      },
    ],
  });
}
