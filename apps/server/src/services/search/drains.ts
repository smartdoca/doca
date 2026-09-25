import type { DB } from "@db/index.js";

export interface SearchProjectionHost {
  registry: { get(source: unknown): unknown };
  upsertProjections(input: {
    source: unknown;
    projections: readonly unknown[];
  }): Promise<unknown>;
  deleteProjections(input: {
    source: unknown;
    documentIds: readonly string[];
  }): Promise<unknown>;
}

type ProjectionDrain = (
  db: DB,
  search: SearchProjectionHost,
) => Promise<void>;

const drainKey = Symbol.for("doca.search.projection-drains");

function drainList(): ProjectionDrain[] {
  const host = globalThis as typeof globalThis & {
    [drainKey]?: ProjectionDrain[];
  };
  return (host[drainKey] ??= []);
}

export function registerProjectionDrain(drain: ProjectionDrain) {
  const drains = drainList();
  drains.push(drain);
  return () => {
    const index = drains.indexOf(drain);
    if (index >= 0) drains.splice(index, 1);
  };
}

export function projectionDrains(): readonly ProjectionDrain[] {
  return drainList();
}
