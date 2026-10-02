import { AsyncLocalStorage } from "node:async_hooks";
import type { DirectorySource } from "@smartdoca/plugin-contracts";
import type { DB } from "../../../../db/src/index.js";
import { databaseRuntimeScope } from "../../../../db/src/runtime-scope.js";
import { builtinDirectorySources } from "./directory-builtin.js";

function execution(db: DB): AsyncLocalStorage<DB> {
  const scope = databaseRuntimeScope(db);
  let storage = scope.get("directory-execution") as
    AsyncLocalStorage<DB> | undefined;
  if (!storage) {
    storage = new AsyncLocalStorage<DB>();
    scope.set("directory-execution", storage);
  }
  return storage;
}
export function withDirectoryDatabase<T>(db: DB, run: () => T): T {
  return execution(db).run(db, run);
}

export function directorySourceRegistry(db: DB): Map<string, DirectorySource> {
  const scope = databaseRuntimeScope(db);
  let registry = scope.get("directory-sources") as
    Map<string, DirectorySource> | undefined;
  if (!registry) {
    registry = new Map();
    scope.set("directory-sources", registry);
  }
  for (const source of builtinDirectorySources(
    () => execution(db).getStore() ?? db,
  ))
    if (!registry.has(source.id)) registry.set(source.id, source);
  return registry;
}

/** Same registration path for internal modules and installed plugin contributions. */
export function registerDirectorySource(
  db: DB,
  source: DirectorySource,
): () => void {
  const registry = directorySourceRegistry(db);
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(source.id) ||
    source.schemaVersion !== 1 ||
    typeof source.related !== "function" ||
    typeof source.verify !== "function" ||
    registry.has(source.id)
  )
    throw new Error(`Invalid or duplicate directory source: ${source.id}`);
  registry.set(source.id, source);
  return () => {
    if (registry.get(source.id) === source) registry.delete(source.id);
  };
}
