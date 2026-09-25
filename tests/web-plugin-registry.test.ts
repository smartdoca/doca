import { describe, expect, it } from "vitest";
import {
  ConversationAssembler,
  MobilePluginRegistry,
  RegistryConflictError,
  WebPluginRegistry,
  type ConversationDefinition,
  type ConversationEvent,
  type WebPluginBundle,
} from "../packages/web-plugin-registry/src/index.js";

const manifest = (pluginId: string, target: "web" | "mobile" = "web") => ({
  pluginId,
  version: "1.0.0",
  targets: [target] as const,
});

describe("web plugin registry", () => {
  it("rejects duplicate IDs and normalized paths without partial registration", () => {
    const registry = new WebPluginRegistry();
    registry.register({
      manifest: manifest("example.alpha"),
      routes: [
        {
          id: "example.alpha.route.home",
          pluginId: "example.alpha",
          path: "/alpha",
          render: () => "alpha",
        },
      ],
    });

    expect(() =>
      registry.register({
        manifest: manifest("example.beta"),
        routes: [
          {
            id: "example.beta.route.temporary",
            pluginId: "example.beta",
            path: "/temporary",
            render: () => "temporary",
          },
          {
            id: "example.beta.route.conflict",
            pluginId: "example.beta",
            path: "/alpha/",
            render: () => "conflict",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_CONTRIBUTION_PATH",
      }),
    );
    expect(registry.resolveRoute("/temporary")).toBeUndefined();

    expect(() =>
      registry.routes.register({
        id: "example.alpha.route.home",
        pluginId: "example.alpha",
        path: "/other",
        render: () => "other",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_CONTRIBUTION_ID",
      }),
    );
  });

  it("disposes complete bundles in reverse-safe, idempotent form", () => {
    const registry = new WebPluginRegistry();
    const contribution: WebPluginBundle = {
      manifest: manifest("example.disposable"),
      routes: [
        {
          id: "example.disposable.route.main",
          pluginId: "example.disposable",
          path: "/disposable",
          render: () => "view",
        },
      ],
      navigation: [
        {
          id: "example.disposable.navigation.main",
          pluginId: "example.disposable",
          scope: "disposable",
          path: "/disposable",
          labelKey: "example.disposable.nav.main",
        },
      ],
      messages: [
        {
          id: "example.disposable.messages.client",
          pluginId: "example.disposable",
          messages: {
            en: { "example.disposable.nav.main": "Disposable" },
            zh: { "example.disposable.nav.main": "可移除" },
          },
        },
      ],
    };

    const dispose = registry.register(contribution);
    expect(registry.resolveRoute("/disposable")).toBeDefined();
    expect(
      registry.translate("zh", "example.disposable.nav.main"),
    ).toBe("可移除");

    dispose();
    dispose();
    expect(registry.resolveRoute("/disposable")).toBeUndefined();
    expect(registry.navigation.list()).toEqual([]);
    expect(registry.manifests()).toEqual([]);
    expect(registry.translate("en", "example.disposable.nav.main")).toBe(
      "example.disposable.nav.main",
    );

    expect(() => registry.register(contribution)).not.toThrow();
  });

  it("validates dictionary parity and English fallback", () => {
    const registry = new WebPluginRegistry();
    registry.register({
      manifest: manifest("example.locale"),
      messages: [
        {
          id: "example.locale.messages.client",
          pluginId: "example.locale",
          messages: {
            en: { "example.locale.greeting": "Hello {name}" },
            zh: { "example.locale.greeting": "你好，{name}" },
          },
        },
      ],
    });
    expect(
      registry.translate("fr", "example.locale.greeting", { name: "Lin" }),
    ).toBe("Hello Lin");

    expect(() =>
      new WebPluginRegistry().register({
        manifest: manifest("example.invalid"),
        messages: [
          {
            id: "example.invalid.messages.client",
            pluginId: "example.invalid",
            messages: {
              en: { "example.invalid.one": "One" },
              zh: { "example.invalid.two": "二" },
            },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONTRIBUTION",
      }),
    );
  });

  it("supports target-specific mobile manifests and reversible tabs", () => {
    const registry = new MobilePluginRegistry();
    const dispose = registry.register({
      manifest: manifest("example.mobile", "mobile"),
      tabs: [
        {
          id: "example.mobile.tab.files",
          pluginId: "example.mobile",
          route: "files",
          labelKey: "example.mobile.files",
        },
      ],
    });
    expect(registry.tabs.getByConflictKey("files")?.pluginId).toBe(
      "example.mobile",
    );
    dispose();
    expect(registry.tabs.getByConflictKey("files")).toBeUndefined();
  });
});

type CounterState = { count: number; trail: string[] };
type CounterNode = { count: number; trail: string[] };

const counterDefinition: ConversationDefinition<CounterState, CounterNode> = {
  id: "example.counter.conversation.definition",
  pluginId: "example.counter",
  kind: "counter",
  isStart: (event) => event.type === "counter/start",
  start: (event) => ({
    count: Number((event.payload as { value: number }).value),
    trail: [event.type],
  }),
  update: (state, event) => ({
    count:
      state.count +
      Number((event.payload as { increment?: number }).increment ?? 0),
    trail: [...state.trail, event.type],
  }),
  materialize: (state) => state,
};

const event = (
  seq: number,
  type: string,
  payload: unknown,
  settled = false,
): ConversationEvent => ({
  kind: "counter",
  id: "stable-task",
  seq,
  type,
  payload,
  settled,
});

describe("conversation assembler", () => {
  it("holds updates until a late start and replays by seq", () => {
    const assembler = new ConversationAssembler<CounterNode>();
    assembler.definitions.register(
      counterDefinition as ConversationDefinition<unknown, CounterNode>,
    );
    assembler.append(event(2, "counter/progress", { increment: 2 }));
    assembler.append(event(3, "counter/end", { increment: 3 }, true));
    expect(assembler.snapshot()).toEqual([]);

    assembler.append(event(1, "counter/start", { value: 10 }));
    expect(assembler.snapshot()).toEqual([
      expect.objectContaining({
        key: "counter\u0000stable-task",
        firstSeq: 1,
        lastSeq: 3,
        settled: true,
        definitionId: counterDefinition.id,
        value: {
          count: 15,
          trail: [
            "counter/start",
            "counter/progress",
            "counter/end",
          ],
        },
      }),
    ]);
  });

  it("produces identical projections for every arrival order", () => {
    const ordered = [
      event(1, "counter/start", { value: 4 }),
      event(2, "counter/progress", { increment: 1 }),
      event(3, "counter/end", { increment: 5 }, true),
    ];
    const replay = (events: readonly ConversationEvent[]) => {
      const assembler = new ConversationAssembler<CounterNode>();
      assembler.definitions.register(
        counterDefinition as ConversationDefinition<unknown, CounterNode>,
      );
      assembler.appendAll(events);
      return assembler.snapshot();
    };
    expect(replay([ordered[2]!, ordered[0]!, ordered[1]!])).toEqual(
      replay(ordered),
    );
  });

  it("uses a generic fallback for unknown kinds and restores it after disposal", () => {
    const assembler = new ConversationAssembler<CounterNode>();
    assembler.append({
      kind: "future/plugin-event",
      id: "unknown-1",
      seq: 8,
      type: "future/changed",
      payload: { safe: true },
    });
    expect(assembler.snapshot()).toEqual([
      expect.objectContaining({
        definitionId: "generic",
        value: expect.objectContaining({
          type: "generic-event",
          kind: "future/plugin-event",
          id: "unknown-1",
        }),
      }),
    ]);

    const dispose = assembler.definitions.register(
      counterDefinition as ConversationDefinition<unknown, CounterNode>,
    );
    assembler.append(event(1, "counter/start", { value: 1 }));
    expect(
      assembler.snapshot().some((node) => node.definitionId === counterDefinition.id),
    ).toBe(true);
    dispose();
    expect(
      assembler.snapshot().find((node) => node.kind === "counter")?.definitionId,
    ).toBe("generic");
  });

  it("deduplicates exact replay and rejects conflicting seq reuse", () => {
    const assembler = new ConversationAssembler();
    const start = event(1, "counter/start", { value: 1 });
    expect(assembler.append(start)).toBe(true);
    expect(assembler.append(structuredClone(start))).toBe(false);
    expect(() =>
      assembler.append(event(1, "counter/start", { value: 2 })),
    ).toThrowError(
      expect.objectContaining({
        code: "EVENT_SEQUENCE_CONFLICT",
      }),
    );
    expect(RegistryConflictError).toBeTypeOf("function");
  });
});
