import { describe, expect, it } from "vitest";
import {
  MemoryPluginMigrationStore,
  PluginHost,
  PluginLifecycleError,
  validatePluginGraph,
} from "../packages/plugin-host/src/index.js";
import {
  defineContributionPoint,
  definePlugin,
  defineService,
  type DocaPlugin,
  type JsonObject,
  type PluginManifest,
} from "../packages/plugin-sdk/src/index.js";

function manifest(
  id: string,
  dependencies: PluginManifest["dependencies"] = [],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    displayName: id,
    ...(dependencies.length ? { dependencies } : {}),
  };
}

describe("plugin dependency graph", () => {
  it("orders dependencies first while allowing absent optional dependencies", () => {
    const ordered = validatePluginGraph([
      manifest("doca.feature", [
        { id: "doca.core", range: "^1.0.0" },
        { id: "doca.not-installed", range: "*", optional: true },
      ]),
      manifest("doca.core"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      "doca.core",
      "doca.feature",
    ]);
  });

  it("rejects missing, incompatible and cyclic dependencies before lifecycle work", () => {
    expect(() =>
      validatePluginGraph([
        manifest("doca.feature", [{ id: "doca.missing", range: "^1.0.0" }]),
      ]),
    ).toThrow(/requires doca.missing/);
    expect(() =>
      validatePluginGraph([
        manifest("doca.feature", [{ id: "doca.core", range: "^2.0.0" }]),
        manifest("doca.core"),
      ]),
    ).toThrow(/1.0.0 is installed/);
    expect(() =>
      validatePluginGraph([
        manifest("doca.alpha", [{ id: "doca.beta", range: "*" }]),
        manifest("doca.beta", [{ id: "doca.alpha", range: "*" }]),
      ]),
    ).toThrow(/doca.alpha -> doca.beta -> doca.alpha/);
    expect(() =>
      validatePluginGraph(
        [{ ...manifest("doca.future"), sdkRange: "^2.0.0" }],
        "1.0.0",
      ),
    ).toThrow(/requires Doca SDK/);
  });

  it("leaves the host idle when graph validation fails before discovery", async () => {
    const calls: string[] = [];
    const host = new PluginHost();
    host.register(
      definePlugin({
        manifest: manifest("doca.feature", [
          { id: "doca.missing", range: "*" },
        ]),
        discover() {
          calls.push("discover");
        },
      }),
    );

    await expect(host.start()).rejects.toMatchObject({
      code: "MISSING_DEPENDENCY",
    });
    expect(host.state).toBe("idle");
    expect(calls).toEqual([]);
    await host.dispose();
  });
});

describe("plugin host lifecycle", () => {
  it("runs global lifecycle phases in dependency order and disposes in reverse order", async () => {
    const calls: string[] = [];
    const service = defineService<{ value: string }>("doca.example-service");
    const commands = defineContributionPoint<{ execute(): string }>(
      "doca.commands",
    );
    const migrations = new MemoryPluginMigrationStore();
    await migrations.set("doca.core", "0.8.0");

    const core = definePlugin({
      manifest: manifest("doca.core"),
      discover(context) {
        calls.push("core:discover");
        context.provide(service, { value: "available" });
        context.effect(() => () => {
          calls.push("core:discover-clean");
        });
      },
      async migrate(_context, previous) {
        calls.push(`core:migrate:${previous}`);
      },
      mount(context) {
        calls.push("core:mount");
        context.effect(() => () => {
          calls.push("core:mount-clean");
        });
      },
      ready() {
        calls.push("core:ready");
      },
      dispose() {
        calls.push("core:dispose");
      },
    });
    const feature = definePlugin({
      manifest: manifest("doca.feature", [
        { id: "doca.core", range: "^1.0.0" },
      ]),
      injections: { required: [service] },
      discover(context) {
        calls.push("feature:discover");
        expect(context.inject(service).value).toBe("available");
        context.contributions.register(commands, "document.open", {
          execute: () => "opened",
        });
        context.effect(() => () => {
          calls.push("feature:discover-clean");
        });
      },
      migrate(_context, previous) {
        calls.push(`feature:migrate:${previous}`);
      },
      mount(context) {
        calls.push("feature:mount");
        context.effect(() => () => {
          calls.push("feature:mount-clean");
        });
      },
      ready() {
        calls.push("feature:ready");
      },
      dispose() {
        calls.push("feature:dispose");
      },
    });

    const host = new PluginHost({ migrations });
    host.register(feature).register(core);
    await host.start();
    expect(host.state).toBe("running");
    expect(calls).toEqual([
      "core:discover",
      "feature:discover",
      "core:migrate:0.8.0",
      "feature:migrate:undefined",
      "core:mount",
      "feature:mount",
      "core:ready",
      "feature:ready",
    ]);
    expect(
      host.contributions.get(commands, "document.open")?.value.execute(),
    ).toBe("opened");

    await host.dispose();
    expect(host.state).toBe("disposed");
    expect(calls.slice(8)).toEqual([
      "feature:dispose",
      "feature:mount-clean",
      "feature:discover-clean",
      "core:dispose",
      "core:mount-clean",
      "core:discover-clean",
    ]);
    expect(host.contributions.list(commands)).toEqual([]);
  });

  it("rolls back all discovered plugins when ready fails", async () => {
    const calls: string[] = [];
    const create = (
      id: string,
      dependencies: PluginManifest["dependencies"] = [],
      fail = false,
    ) =>
      definePlugin({
        manifest: manifest(id, dependencies),
        discover(context) {
          calls.push(`${id}:discover`);
          context.effect(() => () => {
            calls.push(`${id}:clean`);
          });
        },
        ready() {
          calls.push(`${id}:ready`);
          if (fail) throw new Error("not ready");
        },
        dispose() {
          calls.push(`${id}:dispose`);
        },
      });
    const host = new PluginHost();
    host.register(create("doca.alpha"));
    host.register(
      create("doca.beta", [{ id: "doca.alpha", range: "*" }], true),
    );

    const error = await host.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PluginLifecycleError);
    expect(error).toMatchObject({
      pluginId: "doca.beta",
      phase: "ready",
    });
    expect(calls.slice(-4)).toEqual([
      "doca.beta:dispose",
      "doca.beta:clean",
      "doca.alpha:dispose",
      "doca.alpha:clean",
    ]);
    expect(host.state).toBe("disposed");
  });

  it("checks required injections after discovery while optional injections remain undefined", async () => {
    const required = defineService<string>("doca.required");
    const optional = defineService<string>("doca.optional");
    const missing: DocaPlugin<JsonObject> = {
      manifest: manifest("doca.consumer"),
      injections: { required: [required], optional: [optional] },
      mount(context) {
        expect(context.injectOptional(optional)).toBeUndefined();
      },
    };
    const host = new PluginHost();
    host.register(missing);

    await expect(host.start()).rejects.toMatchObject({
      code: "MISSING_INJECTION",
    });
    expect(host.state).toBe("disposed");
  });
});
