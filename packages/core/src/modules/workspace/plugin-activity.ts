import type { DB } from "@db/index.js";
import type {
  ActivityEntry,
  ActivityPosition,
  ActivitySource,
} from "@smartdoca/plugin-sdk/platform";
import type { Actor } from "../identity/passwords.js";
import { activeActor } from "../access/queries.js";
import { notificationPath } from "../interactions/plugin-notifications.js";
import { pluginServices } from "../../shared/plugin-services.js";
import { fail } from "../../shared/errors.js";
import { recentActivity, type RecentItem } from "./activity.js";

const builtin = "doca";
const pageSize = 50;
const sourceId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const entryId = /^[\x21-\x7e]{1,500}$/;
const icons = new Set([
  "file",
  "mail",
  "calendar",
  "message",
  "task",
  "book",
  "folder",
]);
const kinds = new Set(["document", "library", "assistant", "folder", "file"]);
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const positionOrder = (a: ActivityPosition, b: ActivityPosition) =>
  textOrder(b.visitedAt, a.visitedAt) || textOrder(a.id, b.id);
function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function validPosition(value: unknown): value is ActivityPosition {
  const p = value as ActivityPosition | null;
  return (
    !!p &&
    validTime(p.visitedAt) &&
    typeof p.id === "string" &&
    entryId.test(p.id)
  );
}
function validateEntry(entry: ActivityEntry) {
  if (
    !validPosition(entry) ||
    typeof entry.title !== "string" ||
    !entry.title.trim() ||
    entry.title.length > 500
  )
    throw new Error("Invalid activity entry");
  notificationPath(entry.path);
}
export function registerActivitySource(db: DB, source: ActivitySource) {
  const sources = pluginServices(db).activities;
  if (
    !source ||
    !sourceId.test(source.pluginId) ||
    !sourceId.test(source.id) ||
    !source.id.startsWith(`${source.pluginId}.`) ||
    source.id.length > 150 ||
    !sourceId.test(source.resourceType) ||
    source.schemaVersion !== 1 ||
    !icons.has(source.icon) ||
    typeof source.list !== "function" ||
    typeof source.get !== "function" ||
    [source.title?.en, source.title?.zh].some(
      (title) =>
        typeof title !== "string" || !title.trim() || title.length > 100,
    ) ||
    sources.has(source.id) ||
    sources.size >= 64
  )
    throw new Error("Invalid or duplicate activity source");
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
  };
}
export function activitySources(db: DB) {
  return [...pluginServices(db).activities.values()].map(
    ({ id, title, icon }) => ({ id, title, icon }),
  );
}
export type PluginRecentItem = {
  kind: "plugin";
  id: string;
  sourceId: string;
  sourceTitle: ActivitySource["title"];
  icon: ActivitySource["icon"];
  title: string;
  visited_at: string;
  href: string;
};
export type WorkspaceActivityItem = RecentItem | PluginRecentItem;
type SourceCursor = {
  id: string;
  after: ActivityPosition | null;
  done: boolean;
};
type Cursor = {
  version: 1;
  user: string;
  filter: string;
  until: string;
  sources: SourceCursor[];
  unavailable: string[];
};
export type WorkspaceActivityPage = {
  items: WorkspaceActivityItem[];
  nextCursor: string | null;
  sources: ReturnType<typeof activitySources>;
  unavailableSources: string[];
};
async function bounded<T>(
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => {
          controller.abort();
          reject(new Error("Activity request aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Activity source timed out"));
        }, 1500);
      }),
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
async function authorized(
  db: DB,
  source: ActivitySource,
  user: string,
  id: string,
) {
  const services = pluginServices(db);
  const key = `${source.pluginId}.${source.resourceType}`;
  const permission = services.permissions.get(key);
  if (!permission) throw new Error("Activity authorizer unavailable");
  const allowed = await permission.authorize(user, id, "activity.read");
  if (
    services.activities.get(source.id) !== source ||
    services.permissions.get(key) !== permission
  )
    throw new Error("Activity source stopped");
  return allowed === true;
}
export async function pluginActivityTarget(
  db: DB,
  actor: Actor,
  sourceId: string,
  id: string,
  signal?: AbortSignal,
) {
  await activeActor(db, actor);
  const source = pluginServices(db).activities.get(sourceId);
  if (!source || !entryId.test(id)) fail(404, "activity_unavailable");
  try {
    return await bounded(signal, async (signal) => {
      if (!(await authorized(db, source, actor.id, id)))
        throw new Error("Denied");
      const entry = await source.get({ principalId: actor.id, signal }, id);
      if (!entry || entry.id !== id) throw new Error("Missing activity");
      validateEntry(entry);
      if (!(await authorized(db, source, actor.id, id)))
        throw new Error("Denied");
      return entry.path;
    });
  } catch {
    fail(404, "activity_unavailable");
  }
}
function readCursor(raw: string, user: string, filter: string): Cursor {
  try {
    if (raw.length > 100000) throw new Error();
    const c = JSON.parse(Buffer.from(raw, "base64url").toString()) as Cursor;
    if (
      c.version !== 1 ||
      c.user !== user ||
      c.filter !== filter ||
      !validTime(c.until) ||
      c.until > new Date().toISOString() ||
      !Array.isArray(c.sources) ||
      c.sources.length > 65 ||
      !Array.isArray(c.unavailable) ||
      c.unavailable.length > 65 ||
      c.unavailable.some((id) => typeof id !== "string" || id.length > 150) ||
      new Set(c.sources.map((s) => s.id)).size !== c.sources.length ||
      c.sources.some(
        (s) =>
          !s ||
          typeof s.id !== "string" ||
          s.id.length > 150 ||
          !sourceId.test(s.id) ||
          typeof s.done !== "boolean" ||
          (s.after !== null &&
            (!validPosition(s.after) || s.after.visitedAt > c.until)),
      )
    )
      throw new Error();
    return c;
  } catch {
    fail(400, "invalid_activity_cursor");
  }
}
export async function workspaceActivity(
  db: DB,
  actor: Actor,
  input: {
    kind?: string;
    source?: string;
    cursor?: string;
    signal?: AbortSignal;
  } = {},
): Promise<WorkspaceActivityPage> {
  await activeActor(db, actor);
  if ((input.kind && !kinds.has(input.kind)) || (input.kind && input.source))
    fail(400, "invalid_activity_filter");
  const filter = JSON.stringify([input.kind ?? "", input.source ?? ""]);
  const registry = pluginServices(db).activities;
  const cursor: Cursor = input.cursor
    ? readCursor(input.cursor, actor.id, filter)
    : {
        version: 1,
        user: actor.id,
        filter,
        until: new Date().toISOString(),
        unavailable: [],
        sources: [
          ...(!input.source ? [builtin] : []),
          ...(!input.kind
            ? [...registry.keys()].filter(
                (id) => !input.source || id === input.source,
              )
            : []),
        ].map((id) => ({ id, after: null, done: false })),
      };
  if (
    cursor.sources.some((s) =>
      input.source
        ? s.id !== input.source
        : input.kind
          ? s.id !== builtin
          : false,
    )
  )
    fail(400, "invalid_activity_cursor");
  type Candidate = {
    source: string;
    position: ActivityPosition;
    item: WorkspaceActivityItem;
  };
  const results = await Promise.allSettled(
    cursor.sources
      .filter((s) => !s.done)
      .map(async (state) => {
        if (state.id === builtin) {
          const page = await recentActivity(db, actor, {
            signal: input.signal,
            kind: input.kind,
            until: cursor.until,
            after: state.after,
            limit: pageSize + 1,
          });
          return {
            state,
            registration: null,
            permission: null,
            more: page.nextOffset !== null,
            candidates: page.items.map(
              (item) =>
                ({
                  source: builtin,
                  position: {
                    visitedAt: item.visited_at,
                    id: `${item.kind}:${item.id}`,
                  },
                  item,
                }) as Candidate,
            ),
          };
        }
        const source = registry.get(state.id);
        if (!source) throw new Error("Activity source unavailable");
        const permission = pluginServices(db).permissions.get(
          `${source.pluginId}.${source.resourceType}`,
        );
        return bounded(input.signal, async (signal) => {
          const candidates: Candidate[] = [];
          let after = state.after;
          const seen = new Set<string>();
          // Refill after permission filtering, with a bounded budget for broken providers.
          for (let batch = 0; batch < 20; batch++) {
            signal.throwIfAborted();
            const limit = pageSize + 1 - candidates.length;
            const page = await source.list(
              { principalId: actor.id, signal },
              { until: cursor.until, after, limit },
            );
            if (
              !page ||
              !Array.isArray(page.items) ||
              page.items.length > limit ||
              typeof page.hasMore !== "boolean" ||
              (page.hasMore && !page.items.length)
            )
              throw new Error("Invalid activity page");
            for (const entry of page.items) {
              validateEntry(entry);
              if (
                entry.visitedAt > cursor.until ||
                (after && positionOrder(after, entry) >= 0) ||
                seen.has(entry.id)
              )
                throw new Error("Unordered activity page");
              seen.add(entry.id);
              after = { visitedAt: entry.visitedAt, id: entry.id };
            }
            const allowed = await Promise.all(
              page.items.map((entry) =>
                authorized(db, source, actor.id, entry.id),
              ),
            );
            page.items.forEach((entry, index) => {
              if (allowed[index])
                candidates.push({
                  source: state.id,
                  position: { visitedAt: entry.visitedAt, id: entry.id },
                  item: {
                    kind: "plugin",
                    id: entry.id,
                    sourceId: source.id,
                    sourceTitle: source.title,
                    icon: source.icon,
                    title: entry.title,
                    visited_at: entry.visitedAt,
                    href: `/api/v1/workspace/activity/open?source=${encodeURIComponent(source.id)}&id=${encodeURIComponent(entry.id)}`,
                  },
                });
            });
            if (registry.get(state.id) !== source)
              throw new Error("Activity source stopped");
            if (!page.hasMore || candidates.length === pageSize + 1)
              return {
                state,
                registration: source,
                permission,
                more: page.hasMore,
                candidates,
              };
          }
          throw new Error("Activity source exceeded page budget");
        });
      }),
  );
  input.signal?.throwIfAborted();
  const active = cursor.sources.filter((s) => !s.done);
  const candidates: Candidate[] = [];
  const successful: Extract<
    (typeof results)[number],
    { status: "fulfilled" }
  >["value"][] = [];
  results.forEach((result, index) => {
    if (
      result.status === "fulfilled" &&
      (!result.value.registration ||
        (registry.get(result.value.state.id) === result.value.registration &&
          pluginServices(db).permissions.get(
            `${result.value.registration.pluginId}.${result.value.registration.resourceType}`,
          ) === result.value.permission))
    ) {
      candidates.push(...result.value.candidates);
      successful.push(result.value);
    } else {
      const state = active[index]!;
      // Host database failures must remain visible as request failures.
      if (state.id === builtin && result.status === "rejected")
        throw result.reason;
      state.done = true;
      cursor.unavailable.push(state.id);
    }
  });
  candidates.sort(
    (a, b) =>
      textOrder(b.position.visitedAt, a.position.visitedAt) ||
      textOrder(a.source, b.source) ||
      textOrder(a.position.id, b.position.id),
  );
  const emitted = candidates.slice(0, pageSize);
  for (const candidate of emitted)
    cursor.sources.find((s) => s.id === candidate.source)!.after =
      candidate.position;
  for (const result of successful) {
    const { state, more, candidates: offered } = result;
    if (!more && offered.every((item) => emitted.includes(item)))
      state.done = true;
  }
  return {
    items: emitted.map((c) => c.item),
    nextCursor: cursor.sources.some((s) => !s.done)
      ? Buffer.from(JSON.stringify(cursor)).toString("base64url")
      : null,
    sources: activitySources(db),
    unavailableSources: cursor.unavailable,
  };
}
