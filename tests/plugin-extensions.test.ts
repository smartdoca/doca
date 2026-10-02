import { expect, it } from "vitest";
import {
  WebPluginRegistry,
  ExtensionViewController,
  type ExtensionContext,
  type WebPluginBundle,
} from "../packages/web-plugin-registry/src/index.js";
import { createPluginPlatformClient } from "@smartdoca/plugin-sdk/web";
const manifest = {
  pluginId: "example.tools",
  version: "1.0.0",
  targets: ["web"] as const,
};
const command = {
  id: "example.tools.convert",
  pluginId: manifest.pluginId,
  title: { en: "Convert", zh: "转换" },
  supportedContexts: ["document"] as const,
  execute() {},
};
const view = {
  id: "example.tools.preview",
  pluginId: manifest.pluginId,
  title: { en: "Preview", zh: "预览" },
  supportedContexts: ["document"] as const,
  render() {
    return "preview";
  },
};
const context = (signal = new AbortController().signal): ExtensionContext => ({
  scope: "document",
  target: "web",
  locale: "zh",
  resource: { id: "doc", kind: "document", format: "markdown" },
  capabilities: ["resource.read"],
  signal,
});
it("registers the two global More locations independently and disposes them", () => {
  const registry = new WebPluginRegistry();
  const globalCommand = { ...command, supportedContexts: ["global"] as const };
  const dispose = registry.register({
    manifest,
    commands: [globalCommand],
    placements: ["global.more", "global.leftMore"].map((slot, i) => ({
      id: `example.tools.global${i}`,
      pluginId: manifest.pluginId,
      slot: slot as "global.more" | "global.leftMore",
      commandId: command.id,
    })),
  });
  const globalContext = { ...context(), scope: "global" as const };
  expect(
    registry.extensions("global.more", globalContext).map((p) => p.id),
  ).toEqual(["example.tools.global0"]);
  expect(
    registry.extensions("global.leftMore", globalContext).map((p) => p.id),
  ).toEqual(["example.tools.global1"]);
  expect(registry.extensions("global.leftMore", context())).toEqual([]);
  expect(
    registry.extensions("global.leftMore", {
      ...globalContext,
      signal: AbortSignal.abort(),
    }),
  ).toEqual([]);
  dispose();
  expect(registry.extensions("global.more", globalContext)).toEqual([]);
  expect(registry.extensions("global.leftMore", globalContext)).toEqual([]);
});
it("allows a command in multiple optional slots, filters conditions and cleans all contributions", () => {
  const registry = new WebPluginRegistry();
  const dispose = registry.register({
    manifest,
    commands: [command],
    views: [view],
    placements: [
      {
        id: "example.tools.menu",
        pluginId: manifest.pluginId,
        slot: "document.menu",
        commandId: command.id,
        conditions: {
          formats: ["markdown"],
          capabilities: ["resource.read"],
          targets: ["web"],
        },
      },
      {
        id: "example.tools.toolbar",
        pluginId: manifest.pluginId,
        slot: "document.toolbar",
        commandId: command.id,
      },
      {
        id: "example.tools.sidebar",
        pluginId: manifest.pluginId,
        slot: "document.sidebar",
        viewId: view.id,
      },
    ],
  });
  expect(registry.extensions("document.menu", context())).toHaveLength(1);
  expect(registry.extensions("document.toolbar", context())).toHaveLength(1);
  expect(
    registry.extensions("document.menu", { ...context(), target: "mobile" }),
  ).toEqual([]);
  expect(
    registry.extensions("document.menu", { ...context(), capabilities: [] }),
  ).toEqual([]);
  expect(
    registry.extensions("document.menu", context(AbortSignal.abort())),
  ).toEqual([]);
  dispose();
  dispose();
  expect(registry.commands.list()).toEqual([]);
  expect(registry.views.list()).toEqual([]);
  expect(registry.placements.list()).toEqual([]);
  expect(() =>
    registry.register({
      manifest,
      routes: [
        {
          id: "example.tools.page",
          pluginId: manifest.pluginId,
          path: "/tools",
          render: () => "page",
        },
      ],
    }),
  ).not.toThrow();
});
it.each(["missing", "foreign", "invalid-slot", "both", "command-presentation"])(
  "rolls back an invalid %s registration atomically",
  (reason) => {
    const registry = new WebPluginRegistry();
    const placement: any = {
      id: "example.tools.menu",
      pluginId: manifest.pluginId,
      slot: "document.menu",
      commandId: command.id,
    };
    if (reason === "missing") placement.commandId = "example.tools.missing";
    if (reason === "foreign") placement.pluginId = "example.other";
    if (reason === "invalid-slot") placement.slot = "unknown";
    if (reason === "both") placement.viewId = view.id;
    if (reason === "command-presentation") placement.presentation = "dialog";
    expect(() =>
      registry.register({
        manifest,
        commands: [command],
        views: [view],
        placements: [placement],
      } as WebPluginBundle),
    ).toThrow();
    expect(registry.manifests()).toEqual([]);
    expect(registry.commands.list()).toEqual([]);
    expect(registry.views.list()).toEqual([]);
  },
);
it("owns panel cancellation, rejects other plugins and prevents stale handles from closing a later panel", () => {
  const controller = new ExtensionViewController((id) =>
    id === view.id ? view : undefined,
  );
  const parent = new AbortController();
  const first = controller.open(manifest.pluginId, {
    viewId: view.id,
    presentation: "dialog",
    context: context(parent.signal),
  });
  const firstSignal = controller.snapshot()!.context.signal;
  const second = controller.open(manifest.pluginId, {
    viewId: view.id,
    presentation: "drawer",
    context: context(parent.signal),
  });
  expect(firstSignal.aborted).toBe(true);
  first.close();
  expect(controller.snapshot()?.presentation).toBe("drawer");
  expect(() =>
    controller.open("example.other", {
      viewId: view.id,
      presentation: "dialog",
      context: context(),
    }),
  ).toThrow();
  parent.abort();
  expect(controller.snapshot()).toBeNull();
  second.close();
  expect(() =>
    controller.open(manifest.pluginId, {
      viewId: view.id,
      presentation: "sidebar",
      context: context(parent.signal),
    }),
  ).toThrow();
});
it("uses only explicit typed public operations and forwards cancellation", async () => {
  const calls: unknown[][] = [],
    signal = new AbortController().signal;
  const client = createPluginPlatformClient(async <T>(...args: unknown[]) => {
    calls.push(args);
    return {} as T;
  });
  await client.users.me({ signal });
  await client.documents.readSnapshot(
    { documentId: "doc", expectedRevision: "rev" },
    { signal },
  );
  await client.libraries.children({ libraryId: "lib", parentId: null });
  expect(calls).toEqual([
    ["users.me", {}, signal],
    [
      "documents.readSnapshot",
      { documentId: "doc", expectedRevision: "rev" },
      signal,
    ],
    ["libraries.children", { libraryId: "lib", parentId: null }, undefined],
  ]);
  expect(client).not.toHaveProperty("request");
});
