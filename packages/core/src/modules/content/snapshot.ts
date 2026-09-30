import { createHash } from "node:crypto";
import type {
  ContentItem,
  ContentServiceV1,
  ContentPurpose,
  ContentRecord,
} from "@smartdoca/plugin-sdk/content";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import type { JsonObject } from "@smartdoca/plugin-sdk";
import { fail } from "../../shared/errors.js";
import { contentReferenceKey } from "./service.js";

/** Only a completed inventory can establish that a previously seen block disappeared. */
export async function readContentInventory(
  service: ContentServiceV1,
  context: PluginRequestContext,
  input: { sourceId: string; purpose: ContentPurpose; config: JsonObject },
  limit = 100_000,
) {
  const items: ContentItem[] = [];
  const refs = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | undefined;
  do {
    context.signal.throwIfAborted();
    const page = await service.list(context, { ...input, cursor, limit: 100 });
    if (snapshot !== undefined && snapshot !== page.snapshot)
      fail(409, "Content changed during traversal; retry from the first page");
    snapshot = page.snapshot;
    for (const item of page.items) {
      const key = contentReferenceKey(item.ref);
      if (refs.has(key))
        fail(502, "Content traversal returned duplicate references");
      refs.add(key);
      items.push(item);
      if (items.length > limit)
        fail(413, "Content inventory exceeds limits; narrow the source scope");
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor) || !page.items.length)
        fail(502, "Content traversal did not advance");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  const fingerprints = items
    .map((item) => [contentReferenceKey(item.ref), item.fingerprint] as const)
    .sort((a, b) => a[0].localeCompare(b[0], "en"));
  return {
    items,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprints))
      .digest("hex"),
  };
}

/** Caller owns prior state scoped to the same user, purpose and source configuration. */
export async function readChangedContent(
  service: ContentServiceV1,
  context: PluginRequestContext,
  input: { sourceId: string; purpose: ContentPurpose; config: JsonObject },
  previous: ReadonlyMap<string, string>,
  characterLimit = 120_000,
  include: (item: ContentItem) => boolean = () => true,
) {
  const inventory = await readContentInventory(service, context, input);
  const current = new Map(
    inventory.items.map((item) => [
      contentReferenceKey(item.ref),
      item.fingerprint,
    ]),
  );
  const changed: ContentRecord[] = [];
  let characters = 0;
  for (const item of inventory.items) {
    if (!include(item)) continue;
    if (previous.get(contentReferenceKey(item.ref)) === item.fingerprint)
      continue;
    const record = await service.read(context, {
      ...input,
      ref: item.ref,
      fingerprint: item.fingerprint,
    });
    if (!record) fail(409, "Content became unavailable during traversal");
    characters += record.text.length;
    if (characters > characterLimit)
      fail(
        413,
        "Changed content exceeds analysis limits; narrow the source scope",
      );
    changed.push(record);
  }
  return {
    ...inventory,
    changed,
    removed: [...previous.keys()].filter((key) => !current.has(key)),
    fingerprints: current,
  };
}
