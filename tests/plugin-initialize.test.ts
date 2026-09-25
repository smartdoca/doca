import { expect, it } from "vitest";
import { PluginHost, MemoryPluginMigrationStore } from "../packages/plugin-host/src/index.js";
import { definePlugin } from "@doca/plugin-sdk";

it("initializes private database connections on every start even when migration was recorded", async () => {
  const migrations = new MemoryPluginMigrationStore();
  const events: string[] = [];
  const make = () => definePlugin({
    manifest: { schemaVersion: 1, id: "example.database", version: "1.0.0", displayName: "Database" },
    initialize(context) { events.push("connect"); context.effect(() => () => { events.push("close"); }); },
    migrate() { events.push("migrate"); },
    ready() { events.push("ready"); },
  });
  for (let i = 0; i < 2; i++) {
    const host = new PluginHost({ migrations }); host.register(make());
    await host.start(); await host.dispose();
  }
  expect(events).toEqual(["connect", "migrate", "ready", "close", "connect", "ready", "close"]);
});

it("cleans initialized connections when a later migration fails", async () => {
  let closed = false;
  const host = new PluginHost();
  host.register(definePlugin({
    manifest: { schemaVersion: 1, id: "example.failed", version: "1.0.0", displayName: "Failed" },
    initialize(context) { context.effect(() => () => { closed = true; }); },
    migrate() { throw new Error("Private database migration failed"); },
  }));
  await expect(host.start()).rejects.toThrow();
  expect(closed).toBe(true);
  await host.dispose();
});

it("does not expose private host services to installed plugins", async () => {
  const { scopeInstalledPlugin } = await import("@server/plugins/scope.js");
  const { defineService } = await import("@doca/plugin-sdk");
  const { runPluginContractHarness } = await import("@doca/plugin-sdk/testing");
  const token = defineService<{ database: string }>("doca.server.runtime");
  const plugin = scopeInstalledPlugin(definePlugin({
    manifest: { schemaVersion: 1, id: "example.isolated", version: "1.0.0", displayName: "Isolated" },
    initialize(context) { context.inject(token); },
  }));
  await expect(runPluginContractHarness(plugin, { services: [{ token, value: { database: "private" } }] })).rejects.toThrow("Private host service");
});
