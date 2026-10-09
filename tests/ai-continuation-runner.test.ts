import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { aiDefaults, saveAIConfig } from "@core/modules/ai/config.js";
import {
  createAIRunner,
  type AIContributionExecutionContext,
} from "@server/services/ai/runner.js";
import { continuationJobStatus } from "@server/services/ai/continuations.js";
import { provideAI } from "@server/plugins/ai-capability.js";
import { AIContributionHost } from "@doca/ai-host";
import {
  aiServiceToken,
  aiContinuationsServiceToken,
  type AIServiceV1,
  type AIContinuationsServiceV1,
} from "@smartdoca/plugin-sdk/ai";
import type { PluginLifecycleContext } from "@smartdoca/plugin-sdk";
import { completionResponse } from "./ai-mock.js";

it.each(["running", "waiting_input"] as const)(
  "resumes a public plugin task from %s after reopening the database without replaying its start side effect",
  async (initialState) => {
    const root = await mkdtemp(join(tmpdir(), "doca-plugin-continuation-"));
    let db = await openTestDatabase({
      driver: "sqlite",
      path: join(root, "test.db"),
    });
    const actor = {
      ...(await createUser(
        db,
        {
          login: "owner",
          displayName: "Owner",
          password: "test-password-2026",
        },
        { bootstrap: true },
      )),
      admin: 1,
    };
    await saveAIConfig(
      db,
      {
        ...aiDefaults,
        defaultModel: "mock",
        vendors: [
          {
            id: "vendor",
            name: "Fixture",
            provider: "compatible",
            baseUrl: "https://model.example.test/v1",
            apiKey: "fixture",
            enabled: true,
          },
        ],
        models: [
          {
            id: "mock",
            vendorId: "vendor",
            model: "fixture-model",
            alias: "Fixture",
            tools: true,
            enabled: true,
            maxInput: 64000,
            maxOutput: 2000,
          },
        ],
      },
      0,
    );
    const now = new Date().toISOString(),
      sessionId = randomUUID(),
      jobId = randomUUID();
    await db
      .insertInto("ai_sessions")
      .values({
        id: sessionId,
        user_id: actor.id,
        title: "Background report",
        model_id: "mock",
        resource_ids: "[]",
        archived: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("ai_jobs")
      .values({
        id: jobId,
        session_id: sessionId,
        user_id: actor.id,
        model_id: "mock",
        status: "queued",
        input: JSON.stringify({
          text: "Generate the report, wait for completion, and report its stable result.",
          references: [],
          scope: "all",
          skillIds: [],
        }),
        digest: "fixture",
        result: "",
        error: "",
        lease: null,
        lease_until: null,
        attempts: 0,
        cancelled: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    let starts = 0,
      modelCalls = 0;
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)),
        messages = body.messages as any[];
      modelCalls++;
      const resumed = messages.some((message) =>
        JSON.stringify(message).includes("stable-report-result"),
      );
      const awaitingInput = messages.some(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message).includes("waiting_input"),
      );
      const next = resumed
        ? { role: "assistant", content: "Completed: stable-report-result." }
        : awaitingInput
          ? {
              role: "assistant",
              content:
                "Please review the pending business task. I will continue after your decision.",
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "start-report",
                  type: "function",
                  function: { name: "example.reports.start", arguments: "{}" },
                },
              ],
            };
      return completionResponse(
        {
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: next,
              finish_reason: resumed || awaitingInput ? "stop" : "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        },
        !!body.stream,
      );
    }) as typeof fetch;
    let runner: ReturnType<typeof createAIRunner> | undefined;
    const mount = () => {
      const host = new AIContributionHost<AIContributionExecutionContext>(),
        services = new Map<string, unknown>();
      provideAI(
        {
          provide(token: { id: string }, value: unknown) {
            services.set(token.id, value);
          },
        } as PluginLifecycleContext,
        db,
        host,
      );
      const continuations = services.get(
        aiContinuationsServiceToken.id,
      ) as AIContinuationsServiceV1;
      const disposeSource = continuations.registerSource({
        id: "example.reports.jobs",
        pluginId: "example.reports",
        async read(request) {
          if (request.principal.id !== actor.id) return null;
          // The fixture uses a durable host-owned record to simulate a plugin job.
          const result = await db
            .selectFrom("ai_notes")
            .select("content")
            .where("user_id", "=", actor.id)
            .executeTakeFirst();
          return {
            version: 1,
            state: result ? "completed" : initialState,
            revision: result ? "2" : "1",
            summary: result ? "Report saved" : "Generating",
            ...(result ? { result: { reportId: result.content } } : {}),
          };
        },
      });
      const disposeTool = (
        services.get(aiServiceToken.id) as AIServiceV1
      ).registerTool({
        id: "example.reports.start",
        description: "Start an isolated report",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(_input, request) {
          starts++;
          return continuations.wait("example.reports", request, {
            sourceId: "example.reports.jobs",
            operationId: "report-1",
          });
        },
      });
      runner = createAIRunner(db, {
        fetch: fetcher,
        contributions: host,
        memory: { driver: "sqlite", url: join(root, "memory.db") },
      });
      return async () => {
        await runner!.close();
        runner = undefined;
        disposeTool();
        disposeSource();
      };
    };
    const row = () =>
      db
        .selectFrom("ai_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
    const waitFor = async (
      predicate: (job: Awaited<ReturnType<typeof row>>) => boolean,
    ) => {
      for (let i = 0; i < 300; i++) {
        const job = await row();
        if (predicate(job)) return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out: ${JSON.stringify(await row())}`);
    };
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = mount();
      await runner!.pump();
      const waiting = await waitFor(
        (job) =>
          continuationJobStatus(job) === "awaiting_dependency" ||
          job.status === "failed",
      );
      expect(waiting.error).toBe("");
      expect(continuationJobStatus(waiting)).toBe("awaiting_dependency");
      expect(
        JSON.parse(waiting.result).checkpoint.messages.some(
          (message: any) => message.role === "tool",
        ),
      ).toBe(true);
      expect(waiting.attempts).toBe(0);
      expect(starts).toBe(1);
      await dispose();
      dispose = undefined;
      await db.destroy();
      db = await openTestDatabase({
        driver: "sqlite",
        path: join(root, "test.db"),
      });
      // Commit while no runner is alive; do not send a wake notification.
      await db
        .insertInto("ai_notes")
        .values({
          user_id: actor.id,
          content: "stable-report-result",
          updated_at: new Date().toISOString(),
        })
        .execute();
      dispose = mount();
      await runner!.pump();
      const completed = await waitFor((job) =>
        ["completed", "failed"].includes(job.status),
      );
      expect(completed.error).toBe("");
      expect(completed.status).toBe("completed");
      expect(starts).toBe(1);
      expect(modelCalls).toBe(initialState === "waiting_input" ? 3 : 2);
      const result = JSON.parse(completed.result);
      expect(result.progress.text).toContain("stable-report-result");
      expect(
        result.progress.events.filter(
          (event: any) => event.code === "continuation_resumed",
        ),
      ).toHaveLength(1);
      expect(result.checkpoint.continuations).toMatchObject({
        waits: [],
        ready: [],
      });
    } finally {
      await dispose?.();
      await runner?.close();
      await db.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
