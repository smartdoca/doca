import type { PluginStorageServices } from "../services/plugin-storage.js";
import { fileOperationScope } from "./file-operation-scope.js";
import type {
  DocaPlugin,
  PluginLifecycleContext,
  ServiceToken,
} from "@smartdoca/plugin-sdk";

/** Bind public registration capabilities to the plugin that received them. */
export function scopeInstalledPlugin(
  plugin: DocaPlugin,
  storage?: PluginStorageServices,
): DocaPlugin {
  const contexts = new WeakMap<
    PluginLifecycleContext,
    PluginLifecycleContext
  >();
  const scope = (context: PluginLifecycleContext) => {
    const previous = contexts.get(context);
    if (previous) return previous;
    const owned = (id: string, exact = false) => {
      if (
        exact
          ? id !== plugin.manifest.id
          : !id.startsWith(`${plugin.manifest.id}.`)
      )
        throw new Error("Plugin namespace mismatch");
    };
    const inject = <T>(
      token: ServiceToken<T>,
      optional: boolean,
    ): T | undefined => {
      if (
        token.id.startsWith("doca.server.") ||
        token.id === "doca.ai.contributions" ||
        token.id === "search.sources.v1" ||
        token.id === "files.jobs.v1"
      )
        throw new Error(
          `Private host service is unavailable to plugins: ${token.id}`,
        );
      if (token.id === "storage.credentials.v1") {
        if (storage?.credentials) return storage.credentials as T;
        if (optional) return undefined;
        throw new Error(
          "Plugin credentials require DOCA_CREDENTIAL_MASTER_KEY in the host environment",
        );
      }
      if (["storage.sql.v1", "storage.objects.v1"].includes(token.id)) {
        if (!storage)
          throw new Error("Plugin storage is unavailable in this host context");
        return (
          token.id === "storage.sql.v1" ? storage.database : storage.objects
        ) as T;
      }
      const value = optional
        ? context.injectOptional(token)
        : context.inject(token);
      if (value && token.id === "files.v1")
        return new Proxy(value as object, {
          get(target, property) {
            const member = Reflect.get(target, property);
            if (
              ![
                "folders",
                "files",
                "uploads",
                "receipts",
                "bindings",
                "content",
              ].includes(String(property))
            )
              return member;
            return new Proxy(member, {
              get(bindings, action) {
                const method = Reflect.get(bindings, action);
                if (typeof method !== "function") return method;
                return (...args: any[]) => {
                  args[0] = {
                    ...args[0],
                    [fileOperationScope]: plugin.manifest.id,
                  };
                  if (args[1]?.owner) owned(args[1].owner.ownerPlugin, true);
                  return method.apply(bindings, args);
                };
              },
            });
          },
        }) as T;
      if (
        !value ||
        ![
          "templates.v1",
          "materials.v2",
          "content.v1",
          "activity.v1",
          "notifications.v1",
          "http.v1",
          "permissions.v1",
          "policies.v1",
          "ai.v1",
          "search.v1",
          "knowledge.sources.v1",
        ].includes(token.id)
      )
        return value;
      return new Proxy(value as object, {
        get(target, property) {
          const method = Reflect.get(target, property);
          if (typeof method !== "function") return method;
          return (...args: any[]) => {
            if (
              ["templates.v1", "materials.v2"].includes(token.id) &&
              ["register", "registerConsumer"].includes(String(property))
            ) {
              owned(args[0].pluginId, true);
              owned(args[0].id);
              return context.effect(() => method.apply(target, args));
            }
            if (token.id === "content.v1" && property === "register") {
              owned(args[0].pluginId, true);
              owned(args[0].id);
              return context.effect(() => method.apply(target, args));
            }
            if (token.id === "activity.v1" && property === "register") {
              owned(args[0].pluginId, true);
              owned(args[0].id);
              return context.effect(() => method.apply(target, args));
            }
            if (token.id === "notifications.v1") owned(args[0], true);
            if (token.id === "http.v1" && property === "callbackUrl")
              owned(args[0], true);
            if (token.id === "http.v1" && property === "register") {
              owned(args[0], true);
              return context.effectAsync(() => method.apply(target, args));
            }
            if (token.id === "search.v1") {
              const descriptor =
                property === "query"
                  ? args[1].source
                  : property === "register"
                    ? args[0].descriptor
                    : args[0];
              owned(descriptor.pluginId, true);
              if (property === "register")
                return context.effect(() => method.apply(target, args));
            }
            if (
              token.id === "knowledge.sources.v1" &&
              property === "register"
            ) {
              owned(args[0].ownerPlugin, true);
              let registration: any;
              context.effect(() => {
                registration = method.apply(target, args);
                return () => registration.dispose();
              });
              return registration;
            }
            if (
              [
                "register",
                "registerDirectory",
                "registerTool",
                "registerSkill",
              ].includes(String(property))
            ) {
              if (token.id === "permissions.v1" && property === "register")
                owned(args[0].pluginId, true);
              else owned(args[0].id);
              return context.effect(() => method.apply(target, args));
            }
            return method.apply(target, args);
          };
        },
      }) as T;
    };
    const scoped = new Proxy(context, {
      get(target, property) {
        if (property === "context") return scope(Reflect.get(target, property));
        if (property === "child")
          return (id?: string) =>
            scope(target.child(id) as unknown as PluginLifecycleContext);
        if (property === "provide")
          return (token: ServiceToken<unknown>, value: unknown) => {
            owned(token.id);
            return target.provide(token, value);
          };
        if (property === "inject")
          return <T>(token: ServiceToken<T>) => inject(token, false)!;
        if (property === "injectOptional")
          return <T>(token: ServiceToken<T>) => inject(token, true);
        if (property === "has")
          return (token: ServiceToken<unknown>) =>
            token.id === "storage.credentials.v1"
              ? !!storage?.credentials
              : target.has(token);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    contexts.set(context, scoped);
    return scoped;
  };
  return {
    ...plugin,
    discover: plugin.discover
      ? (context) => plugin.discover!(scope(context))
      : undefined,
    initialize: plugin.initialize
      ? (context) => plugin.initialize!(scope(context))
      : undefined,
    mount: plugin.mount
      ? (context) => plugin.mount!(scope(context))
      : undefined,
    ready: plugin.ready
      ? (context) => plugin.ready!(scope(context))
      : undefined,
    dispose: plugin.dispose
      ? (context) => plugin.dispose!(scope(context))
      : undefined,
    uninstall: plugin.uninstall
      ? (context) => plugin.uninstall!(scope(context))
      : undefined,
  };
}
