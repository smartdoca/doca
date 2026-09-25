import { canonicalJson, type JsonValue } from "./json.js";

export type StableIdKind =
  | "acceptance"
  | "attempt"
  | "event"
  | "message"
  | "result"
  | "session"
  | "step"
  | "tool-call"
  | "turn"
  | "workflow"
  | (string & {});

const prefixes: Record<string, string> = {
  acceptance: "acc",
  attempt: "att",
  event: "evt",
  message: "msg",
  result: "res",
  session: "ses",
  step: "stp",
  "tool-call": "call",
  turn: "turn",
  workflow: "wf",
};

function fnv1a64(text: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

/**
 * Produces the same opaque identifier for the same kind and JSON parts across
 * processes. IDs contain no time, randomness, adapter state, or object order.
 */
export function stableId(
  kind: StableIdKind,
  ...parts: readonly JsonValue[]
): string {
  if (!kind) throw new TypeError("ID kind must not be empty");
  const source = canonicalJson([kind, ...parts]);
  const first = fnv1a64(source, 0xcbf29ce484222325n);
  const second = fnv1a64(source, 0x84222325cbf29cen);
  const prefix = prefixes[kind] ?? kind.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${prefix}_${first}${second}`;
}

export function eventId(sessionId: string, sequence: number): string {
  return stableId("event", sessionId, sequence);
}

export function toolResultId(callId: string): string {
  return stableId("result", callId);
}
