import { describe, expect, it, vi } from "vitest";
import {
  AIContributionHost,
  createToolCall,
  type EffectRegistry,
  type RegistryEntry,
} from "../packages/ai-host/src/index.js";

describe("AIContributionHost", () => {
  it("rolls back earlier registrations when a later domain entry collides", () => {
    const host = new AIContributionHost<{ tenant: string }>();
    host.registerDomain({
      namespace: "documents",
      tools: [
        {
          id: "documents.read",
          execute: () => ({ existing: true }),
        },
      ],
    });

    expect(() =>
      host.registerDomain({
        namespace: "documents",
        intents: [
          {
            id: "documents.create",
            evaluate: () => ({ eligible: true, confidence: 1 }),
          },
        ],
        tools: [
          {
            id: "documents.read",
            execute: () => ({ replacement: true }),
          },
        ],
      }),
    ).toThrow(/already registered/);

    expect(host.intents.has("documents.create")).toBe(false);
    expect(host.tools.get("documents.read")?.execute).toBeDefined();
    expect(host.tools.size).toBe(1);
  });

  it("disposes a complete domain once in reverse registration order", () => {
    const host = new AIContributionHost<string>();
    const order: string[] = [];
    const observe = <T extends RegistryEntry>(
      label: string,
      registry: EffectRegistry<T>,
    ) => {
      const register = registry.register.bind(registry);
      vi.spyOn(registry, "register").mockImplementation((entry) => {
        const dispose = register(entry);
        return () => {
          order.push(label);
          dispose();
        };
      });
    };
    observe("intent", host.intents);
    observe("tool", host.tools);
    observe("workflow", host.workflows);
    observe("acceptance", host.acceptance);
    observe("skill", host.skills);

    const dispose = host.registerDomain({
      namespace: "domain",
      intents: [
        {
          id: "domain.intent",
          evaluate: () => ({ eligible: true, confidence: 1 }),
        },
      ],
      tools: [{ id: "domain.tool", execute: () => true }],
      workflows: [{ id: "domain.workflow", run: () => ({ done: true }) }],
      acceptance: [
        {
          id: "domain.acceptance",
          evaluate: () => ({ verdict: "accepted" }),
        },
      ],
      skills: [{ id: "domain.skill", activate: () => undefined }],
    });

    expect(host.snapshot()).toMatchObject({
      intents: [{ id: "domain.intent" }],
      tools: [{ id: "domain.tool" }],
      workflows: [{ id: "domain.workflow" }],
      acceptance: [{ id: "domain.acceptance" }],
      skills: [{ id: "domain.skill" }],
    });

    dispose();
    dispose();
    expect(order).toEqual([
      "skill",
      "acceptance",
      "workflow",
      "tool",
      "intent",
    ]);
    expect(host.snapshot()).toEqual({
      intents: [],
      tools: [],
      workflows: [],
      acceptance: [],
      skills: [],
    });
  });

  it("returns immutable point-in-time snapshots and catalogs", () => {
    const host = new AIContributionHost();
    host.registerDomain({
      namespace: "notes",
      intents: [
        {
          id: "notes.write",
          description: "Write a note",
          priority: 3,
          evaluate: () => ({ eligible: true, confidence: 0.8 }),
        },
      ],
      tools: [
        {
          id: "notes.save",
          description: "Save a note",
          execute: () => ({ saved: true }),
        },
      ],
    });
    const snapshot = host.snapshot();
    const catalog = host.catalog();
    host.intents.register({
      id: "other.intent",
      evaluate: () => ({ eligible: false, confidence: 0 }),
    });

    expect(snapshot.intents.map((entry) => entry.id)).toEqual(["notes.write"]);
    expect(catalog.intents).toEqual([
      {
        id: "notes.write",
        kind: "intent",
        description: "Write a note",
        priority: 3,
      },
    ]);
    expect(catalog.tools[0]).toEqual({
      id: "notes.save",
      kind: "tool",
      description: "Save a note",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.intents)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.intents[0])).toBe(true);
  });

  it("validates optional namespaces before registration", () => {
    const host = new AIContributionHost();
    expect(() =>
      host.registerDomain({
        namespace: "documents",
        tools: [{ id: "files.read", execute: () => null }],
      }),
    ).toThrow(/must start with "documents\."/);
    expect(host.tools.size).toBe(0);

    const dispose = host.registerDomain({
      namespace: "legacy",
      validateNamespace: false,
      tools: [{ id: "unscoped-tool", execute: () => null }],
    });
    expect(host.tools.has("unscoped-tool")).toBe(true);
    dispose();
  });

  it("routes intents against the supplied host context", async () => {
    const host = new AIContributionHost<{ enabled: boolean }>();
    host.registerDomain({
      namespace: "search",
      intents: [
        {
          id: "search.query",
          evaluate: (_request, context) => ({
            eligible: context.enabled,
            confidence: 0.9,
          }),
        },
        {
          id: "search.fallback",
          evaluate: () => ({ eligible: true, confidence: 0.1 }),
        },
      ],
    });

    expect(
      (await host.routeIntent({ text: "find it" }, { enabled: true })).selected
        ?.intentId,
    ).toBe("search.query");
    expect(
      (await host.routeIntent({ text: "find it" }, { enabled: false })).selected
        ?.intentId,
    ).toBe("search.fallback");
  });

  it("creates a tool pipeline bound to the supplied context", async () => {
    const host = new AIContributionHost<{ tenantId: string }>();
    host.registerDomain({
      namespace: "documents",
      tools: [
        {
          id: "documents.owner",
          execute: (_input, context) => ({
            tenantId: context.host.tenantId,
            sessionId: context.sessionId,
          }),
        },
      ],
    });
    const published: string[] = [];
    const pipeline = host.createToolPipeline(
      { tenantId: "tenant-7" },
      {
        onResult: (result) => {
          published.push(result.id);
        },
      },
    );
    const call = createToolCall({
      sessionId: "session-1",
      turnId: "turn-1",
      toolId: "documents.owner",
      ordinal: 0,
      input: {},
    });

    const result = await pipeline.execute({
      sessionId: "session-1",
      turnId: "turn-1",
      call,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toEqual({
      status: "success",
      value: { sessionId: "session-1", tenantId: "tenant-7" },
    });
    expect(published).toEqual([result.id]);
  });
});
