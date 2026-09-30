import { fileOperationScope } from "./file-operation-scope.js";
import type {
  DocaPlugin,
  PluginLifecycleContext,
  ServiceToken,
} from "@smartdoca/plugin-sdk";

/** Bind public registration capabilities to the plugin that received them. */
export function scopeInstalledPlugin(plugin: DocaPlugin): DocaPlugin {
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
        if (property === "provide")
          return (token: ServiceToken<unknown>, value: unknown) => {
            owned(token.id);
            return target.provide(token, value);
          };
        if (property === "inject")
          return <T>(token: ServiceToken<T>) => inject(token, false)!;
        if (property === "injectOptional")
          return <T>(token: ServiceToken<T>) => inject(token, true);
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
  };
}
