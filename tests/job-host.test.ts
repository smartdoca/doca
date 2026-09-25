import { describe, expect, it } from "vitest";
import {
  DuplicateJobKindError,
  JobHandlerRegistry,
  JobHost,
  MemoryJobSchedulerAdapter,
} from "../packages/job-host/src/index.js";

describe("job handler registry", () => {
  it("enforces unique kinds and gives ownership to an idempotent disposer", () => {
    const registry = new JobHandlerRegistry();
    const dispose = registry.register({
      kind: "documents.render",
      run() {},
    });

    expect(registry.has("documents.render")).toBe(true);
    expect(() =>
      registry.register({ kind: "documents.render", run() {} }),
    ).toThrow(DuplicateJobKindError);
    dispose();
    dispose.dispose();
    expect(registry.has("documents.render")).toBe(false);
  });
});

describe("job host dispatch", () => {
  it("completes an owned job and blocks a missing plugin handler", async () => {
    const scheduler = new MemoryJobSchedulerAdapter({
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    });
    const handled: string[] = [];
    scheduler.enqueue({
      id: "job-1",
      kind: "documents.render",
      pluginId: "doca.documents",
      payload: { documentId: "document-1" },
    });
    scheduler.enqueue({
      id: "job-2",
      kind: "mail.sync",
      pluginId: "doca.mail",
      payload: {},
    });
    const host = new JobHost({
      scheduler,
      context: { handled },
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    });
    host.register({
      kind: "documents.render",
      pluginId: "doca.documents",
      run(payload, { host: context }) {
        context.handled.push(
          String((payload as { documentId: string }).documentId),
        );
      },
    });

    expect((await host.runOnce()).state).toBe("completed");
    expect((await host.runOnce()).state).toBe("blocked-plugin-missing");
    expect(handled).toEqual(["document-1"]);
    expect(scheduler.get("job-1")?.state).toBe("completed");
    expect(scheduler.get("job-2")?.state).toBe("blocked-plugin-missing");
  });
});
