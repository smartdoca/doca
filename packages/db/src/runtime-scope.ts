const scopes = new WeakMap<object, Map<string, unknown>>();
export function databaseRuntimeScope(database: object): Map<string, unknown> {
  let scope = scopes.get(database);
  if (!scope) { scope = new Map(); scopes.set(database, scope); }
  return scope;
}
export function inheritDatabaseRuntimeScope(parent: object, child: object) {
  scopes.set(child, databaseRuntimeScope(parent));
}
