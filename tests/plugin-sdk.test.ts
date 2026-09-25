import { describe, expect, it } from "vitest";
import {
  Context,
  ContributionStore,
  defineDocaConfig,
  defineContributionPoint,
  defineEvent,
  defineService,
  plugin,
} from "../packages/plugin-sdk/src/index.js";
import { runPluginContractHarness } from "../packages/plugin-sdk/src/testing.js";

describe("plugin SDK context", () => {
  it("defines one build-time plugin list and rejects duplicate packages", () => {
    expect(
      defineDocaConfig({
        plugins: [
          plugin("@doca/plugin-files"),
          plugin("@doca/plugin-mail", { targets: ["server", "web"] }),
        ],
      }).plugins.map((entry) => entry.package),
    ).toEqual(["@doca/plugin-files", "@doca/plugin-mail"]);
    expect(() =>
      defineDocaConfig({
        plugins: [
          plugin("@doca/plugin-files"),
          plugin("@doca/plugin-files"),
        ],
      }),
    ).toThrow(/Duplicate plugin package/);
  });

  it("runs external plugins through the contract lifecycle and cleanup", async () => {
    const calls: string[] = [];
    const result = await runPluginContractHarness({
      manifest: {
        schemaVersion: 1,
        id: "example.fixture",
        version: "1.0.0",
        displayName: "Fixture",
      },
      discover(context) {
        context.effect(() => () => {
          calls.push("effect");
        });
      },
      migrate() {
        calls.push("migrate");
      },
      mount() {
        calls.push("mount");
      },
      ready() {
        calls.push("ready");
      },
      dispose() {
        calls.push("dispose");
      },
    });
    expect(result.phases).toEqual([
      "discover",
      "migrate",
      "mount",
      "ready",
      "dispose",
    ]);
    expect(result.disposed).toBe(true);
    expect(calls).toEqual([
      "migrate",
      "mount",
      "ready",
      "dispose",
      "effect",
    ]);
  });

  it("shares one provider registry, rejects ambiguity and supports optional injection", async () => {
    const root = new Context();
    const provider = root.child("provider");
    const consumer = root.child("consumer");
    const clock = defineService<{ now(): number }>("doca.clock");
    const service = { now: () => 42 };

    const release = provider.provide(clock, service);
    expect(consumer.inject(clock)).toBe(service);
    expect(consumer.injectOptional(clock)?.now()).toBe(42);
    expect(() => consumer.provide(clock, { now: () => 0 })).toThrow(
      /already provided/,
    );

    await release();
    expect(consumer.injectOptional(clock)).toBeUndefined();
    expect(() => consumer.inject(clock)).toThrow(/required service/);
    await root.dispose();
  });

  it("owns child scopes and reverses interleaved effects during cleanup", async () => {
    const root = new Context();
    const scope = root.child("plugin.example");
    const calls: string[] = [];
    const resource = defineService<{ name: string }>("doca.resource");
    scope.provide(resource, { name: "open" });
    scope.effect(() => () => {
      calls.push("first");
    });
    const child = scope.child("request");
    child.effect(() => async () => {
      await Promise.resolve();
      calls.push("child");
    });
    scope.effect(() => () => {
      calls.push(`last:${scope.inject(resource).name}`);
    });

    await scope.dispose();
    expect(calls).toEqual(["last:open", "child", "first"]);
    expect(scope.disposed).toBe(true);
    expect(root.disposed).toBe(false);
    await scope.dispose();
    expect(calls).toHaveLength(3);
    await root.dispose();
  });

  it("rejects contribution collisions and unregisters contributions with their scope", async () => {
    const root = new Context();
    const store = new ContributionStore();
    const menus = defineContributionPoint<{ title: string }>("doca.menus");
    const alphaScope = root.child("alpha");
    const betaScope = root.child("beta");
    const alpha = store.forContext(alphaScope, "alpha");
    const beta = store.forContext(betaScope, "beta");

    alpha.register(menus, "document.open", { title: "Open" });
    expect(alpha.get(menus, "document.open")).toMatchObject({
      pluginId: "alpha",
      value: { title: "Open" },
    });
    expect(() =>
      beta.register(menus, "document.open", { title: "Other" }),
    ).toThrow(/already registered by alpha/);

    await alphaScope.dispose();
    beta.register(menus, "document.open", { title: "Replacement" });
    expect(beta.list(menus)).toHaveLength(1);
    await root.dispose();
    expect(beta.list(menus)).toEqual([]);
  });

  it("delegates all five dispatch modes to Cordis, including waterfall next", async () => {
    const context = new Context();
    const emit = defineEvent<number, void>("doca.changed");
    const parallel = defineEvent<number, void, "parallel">(
      "doca.parallel",
      "parallel",
    );
    const serial = defineEvent<number, string, "serial">(
      "doca.serial",
      "serial",
    );
    const bail = defineEvent<number, string, "bail">("doca.bail", "bail");
    const waterfall = defineEvent<string, string, "waterfall">(
      "doca.waterfall",
      "waterfall",
    );
    const calls: string[] = [];

    context.on(emit, (value) => {
      calls.push(`emit:${value}`);
    });
    context.on(parallel, async (value) => {
      await Promise.resolve();
      calls.push(`parallel:${value}`);
    });
    context.on(serial, () => false);
    context.on(serial, async (value) => `serial:${value}`);
    context.on(serial, () => "unreachable");
    context.on(bail, () => undefined);
    context.on(bail, (value) => `bail:${value}`);
    context.on(bail, () => "unreachable");
    context.on(waterfall, (value, next) => `outer:${value}[${next()}]`);
    context.on(waterfall, (value, next) => `inner:${value}[${next()}]`);

    expect(context.dispatch(emit, 3)).toBeUndefined();
    await expect(context.dispatch(parallel, 4)).resolves.toBeUndefined();
    await expect(context.dispatch(serial, 5)).resolves.toBe("serial:5");
    expect(context.dispatch(bail, 6)).toBe("bail:6");
    expect(context.dispatch(waterfall, "x", () => "base")).toBe(
      "outer:x[inner:x[base]]",
    );
    expect(calls).toEqual(["emit:3", "parallel:4"]);
    await context.dispose();
  });

  it("uses Cordis Fibers for plugin scopes and cleans their effects in reverse", async () => {
    const root = new Context();
    const scope = await root.createFiberScope("plugin.fiber-test");
    const service = defineService<string>("doca.fiber-service");
    const cleanup: string[] = [];

    scope.provide(service, "live");
    scope.effect(() => () => {
      cleanup.push(`first:${scope.inject(service)}`);
    });
    scope.effect(() => async () => {
      await Promise.resolve();
      cleanup.push(`last:${scope.inject(service)}`);
    });

    expect(scope.inject(service)).toBe("live");
    await scope.dispose();
    expect(cleanup).toEqual(["last:live", "first:live"]);
    expect(root.injectOptional(service)).toBeUndefined();
    await root.dispose();
  });
});
