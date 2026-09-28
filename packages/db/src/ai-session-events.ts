import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import type { DB, Schema } from "./schema.js";
import { readSnapshot, transact } from "./transactions.js";

export type SessionEventJson =
  | null
  | boolean
  | number
  | string
  | readonly SessionEventJson[]
  | { readonly [key: string]: SessionEventJson };

export interface AISessionEventInput {
  readonly sessionId: string;
  readonly id?: string;
  readonly eventId?: string;
  readonly sequence?: number;
  readonly type: string;
  readonly data?: unknown;
  readonly payload?: unknown;
  readonly timestamp?: string;
  readonly createdAt?: string;
}

export interface CommittedAISessionEvent {
  readonly delivery: "committed";
  readonly id: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly seq: number;
  readonly timestamp: string;
  readonly createdAt: string;
  readonly type: string;
  readonly data: SessionEventJson;
  readonly payload: SessionEventJson;
}

export interface ReadSessionEventsOptions {
  /** Inclusive lower bound. */
  readonly fromSequence?: number;
  /** Exclusive lower bound. Takes precedence over fromSequence. */
  readonly afterSequence?: number;
  readonly limit?: number;
}

export class AISessionEventDigestMismatchError extends Error {
  readonly name = "AISessionEventDigestMismatchError";
  readonly code = "EVENT_DIGEST_MISMATCH";

  constructor(
    readonly sessionId: string,
    readonly eventId: string,
  ) {
    super(
      `Session event ${eventId} in ${sessionId} was already committed with different content`,
    );
  }
}

export class AISessionEventSequenceError extends Error {
  readonly name = "AISessionEventSequenceError";
  readonly code = "NON_MONOTONIC_EVENT_SEQUENCE";

  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `Session ${sessionId} expected event sequence ${expected}, received ${received}`,
    );
  }
}

function normalizeJson(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): SessionEventJson {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== "object")
    throw new TypeError(`${path} must be JSON-compatible`);
  if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle`);

  seen.add(value);
  try {
    if (Array.isArray(value))
      return Object.freeze(
        value.map((item, index) =>
          normalizeJson(item, `${path}[${index}]`, seen),
        ),
      );
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${path} must contain only plain objects`);
    const normalized: Record<string, SessionEventJson> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined)
        throw new TypeError(`${path}.${key} must not be undefined`);
      normalized[key] = normalizeJson(item, `${path}.${key}`, seen);
    }
    return Object.freeze(normalized);
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: SessionEventJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, SessionEventJson>)[key]!,
        )}`,
    )
    .join(",")}}`;
}

function eventDigest(type: string, payload: SessionEventJson): string {
  return createHash("sha256")
    .update(canonicalJson(Object.freeze({ type, payload })))
    .digest("hex");
}

function validateSequence(sequence: number, label: string) {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
}

function parsePayload(payload: string): SessionEventJson {
  return normalizeJson(JSON.parse(payload), "stored event payload");
}

function toCommitted(
  row: Schema["ai_session_events"],
): CommittedAISessionEvent {
  const payload = parsePayload(row.payload);
  return Object.freeze({
    delivery: "committed",
    id: row.event_id,
    eventId: row.event_id,
    sessionId: row.session_id,
    sequence: row.seq,
    seq: row.seq,
    timestamp: row.created_at,
    createdAt: row.created_at,
    type: row.type,
    data: payload,
    payload,
  });
}

function normalizeInput(input: AISessionEventInput) {
  if (!input.sessionId) throw new TypeError("sessionId must not be empty");
  const eventId = input.id ?? input.eventId;
  if (!eventId) throw new TypeError("event id must not be empty");
  if (!input.type) throw new TypeError("event type must not be empty");
  if (input.sequence !== undefined)
    validateSequence(input.sequence, "event sequence");
  const suppliedPayload = Object.prototype.hasOwnProperty.call(input, "data")
    ? input.data
    : input.payload;
  const payload = normalizeJson(suppliedPayload, "event payload");
  return {
    sessionId: input.sessionId,
    eventId,
    sequence: input.sequence,
    type: input.type,
    payload,
    encodedPayload: canonicalJson(payload),
    digest: eventDigest(input.type, payload),
    createdAt: input.timestamp ?? input.createdAt ?? new Date().toISOString(),
  };
}

async function findByEventId(
  db: DB | Transaction<Schema>,
  sessionId: string,
  eventId: string,
) {
  return db
    .selectFrom("ai_session_events")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("event_id", "=", eventId)
    .executeTakeFirst();
}

/**
 * Durable append-only storage for committed AI session events.
 *
 * Event IDs are idempotency keys. A retry with the same type and canonical
 * payload returns the original commit; reusing an ID for different content is
 * rejected. Sequence allocation and insertion happen in one transaction.
 */
export function createAISessionEventStore(db: DB) {
  const read = async (
    sessionId: string,
    options: ReadSessionEventsOptions = {},
  ): Promise<readonly CommittedAISessionEvent[]> => {
    if (!sessionId) throw new TypeError("sessionId must not be empty");
    const lowerBound =
      options.afterSequence === undefined
        ? options.fromSequence
        : options.afterSequence + 1;
    if (lowerBound !== undefined)
      validateSequence(lowerBound, "sequence bound");
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit <= 0)
    )
      throw new TypeError("limit must be a positive safe integer");

    return readSnapshot(db, async (tx) => {
      let query = tx
        .selectFrom("ai_session_events")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("seq");
      if (lowerBound !== undefined)
        query = query.where("seq", ">=", lowerBound);
      if (options.limit !== undefined) query = query.limit(options.limit);
      const rows = await query.execute();
      return Object.freeze(rows.map(toCommitted));
    });
  };

  return {
    async append(input: AISessionEventInput): Promise<CommittedAISessionEvent> {
      const event = normalizeInput(input);
      return transact(db, async (tx) => {
        // A no-op row update is portable across SQLite/Postgres and serializes
        // sequence allocation per session without a dialect-specific lock.
        await tx
          .updateTable("ai_sessions")
          .set((eb) => ({ revision: eb.ref("revision") }))
          .where("id", "=", event.sessionId)
          .execute();
        const existing = await findByEventId(
          tx,
          event.sessionId,
          event.eventId,
        );
        if (existing) {
          const existingDigest =
            existing.digest ||
            eventDigest(existing.type, parsePayload(existing.payload));
          if (existingDigest !== event.digest)
            throw new AISessionEventDigestMismatchError(
              event.sessionId,
              event.eventId,
            );
          if (!existing.digest)
            await tx
              .updateTable("ai_session_events")
              .set({ digest: existingDigest })
              .where("session_id", "=", existing.session_id)
              .where("seq", "=", existing.seq)
              .execute();
          return toCommitted({ ...existing, digest: existingDigest });
        }

        const last = await tx
          .selectFrom("ai_session_events")
          .select("seq")
          .where("session_id", "=", event.sessionId)
          .orderBy("seq", "desc")
          .limit(1)
          .executeTakeFirst();
        const sequence = (last?.seq ?? -1) + 1;
        if (event.sequence !== undefined && event.sequence !== sequence)
          throw new AISessionEventSequenceError(
            event.sessionId,
            sequence,
            event.sequence,
          );

        const row: Schema["ai_session_events"] = {
          session_id: event.sessionId,
          seq: sequence,
          event_id: event.eventId,
          digest: event.digest,
          type: event.type,
          payload: event.encodedPayload,
          created_at: event.createdAt,
        };
        await tx.insertInto("ai_session_events").values(row).execute();
        return toCommitted(row);
      });
    },

    read,
    list: read,
    readCommitted: read,

    async replay<State>(
      sessionId: string,
      initial: State,
      reducer: (state: State, event: CommittedAISessionEvent) => State,
      options?: ReadSessionEventsOptions,
    ): Promise<State> {
      return (await read(sessionId, options)).reduce(reducer, initial);
    },
  };
}

export const createAiSessionEventStore = createAISessionEventStore;
export const createSessionEventStore = createAISessionEventStore;
