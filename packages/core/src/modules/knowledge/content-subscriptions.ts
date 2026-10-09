import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import type { JsonObject } from "@smartdoca/plugin-sdk";
import type { PluginRequestContext } from "@smartdoca/plugin-sdk/platform";
import { createContentService } from "../content/service.js";
import {
  readContentInventory,
} from "../content/snapshot.js";
import { authorize } from "../access/queries.js";
import { fail } from "../../shared/errors.js";

const configSchema = z
  .object({
    protocol: z.literal("content.v1"),
    sourceId: z.string().min(1).max(200),
    config: z.record(z.string(), z.json()),
    principalId: z.string().uuid(),
  })
  .strict();
export function contentRequest(actor: Actor): PluginRequestContext {
  return {
    requestId: randomUUID(),
    signal: AbortSignal.timeout(120_000),
    principal: {
      id: actor.id,
      displayName: actor.display_name,
      publicId: "",
      admin: !!actor.admin,
    },
  };
}
export async function contentSubscriptionConfig(
  db: DB,
  source: Pick<
    Schema["knowledge_subscriptions"],
    "source_kind" | "source_id" | "library_id" | "creator_id"
  >,
) {
  if (source.source_kind !== "content") fail(400, "Not a content subscription");
  const group = await db
    .selectFrom("knowledge_source_groups")
    .selectAll()
    .where("id", "=", source.source_id)
    .where("library_id", "=", source.library_id)
    .where("source_kind", "=", "content")
    .executeTakeFirst();
  if (!group?.config)
    fail(409, "Content subscription configuration is missing");
  const parsed = configSchema.safeParse(JSON.parse(group.config));
  if (!parsed.success || parsed.data.principalId !== source.creator_id)
    fail(409, "Invalid content subscription configuration");
  return { group, value: parsed.data };
}
export async function createContentSubscription(
  db: DB,
  actor: Actor,
  libraryId: string,
  input: { sourceId: string; config: JsonObject; title: string },
) {
  await authorize(db, actor, libraryId, 4);
  const library = await db
    .selectFrom("resources")
    .select("kind")
    .where("id", "=", libraryId)
    .executeTakeFirst();
  if (library?.kind !== "library") fail(400, "A library is required");
  const config = configSchema.parse({
    protocol: "content.v1",
    sourceId: input.sourceId,
    config: input.config,
    principalId: actor.id,
  });
  // Validate provider scope before persisting; do not acknowledge any blocks until analysis succeeds.
  await readContentInventory(createContentService(db), contentRequest(actor), {
    sourceId: input.sourceId,
    purpose: "knowledge",
    config: input.config,
  });
  const id = randomUUID(),
    groupId = randomUUID(),
    now = new Date().toISOString();
  await transact(db, async (tx) => {
    await authorize(tx, actor, libraryId, 4);
    await tx
      .insertInto("knowledge_source_groups")
      .values({
        id: groupId,
        library_id: libraryId,
        title: input.title,
        source_kind: "content",
        created_at: now,
        config: JSON.stringify(config),
      })
      .execute();
    await tx
      .insertInto("knowledge_subscriptions")
      .values({
        id,
        group_id: groupId,
        library_id: libraryId,
        name: input.title,
        creator_id: actor.id,
        source_kind: "content",
        source_id: groupId,
        url: "",
        source_version: "",
        status: "active",
        created_at: now,
      })
      .execute();
  });
  return { id, groupId };
}
export async function contentSubscriptionInventory(
  db: DB,
  actor: Actor,
  source: Schema["knowledge_subscriptions"],
) {
  const { value } = await contentSubscriptionConfig(db, source);
  return readContentInventory(createContentService(db), contentRequest(actor), {
    sourceId: value.sourceId,
    purpose: "knowledge",
    config: value.config as JsonObject,
  });
}
export async function updateContentSubscription(
  db: DB,
  actor: Actor,
  libraryId: string,
  groupId: string,
  input: { sourceId: string; config: JsonObject; title: string },
) {
  await authorize(db, actor, libraryId, 4);
  const source = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", libraryId)
    .where("source_id", "=", groupId)
    .where("source_kind", "=", "content")
    .executeTakeFirst();
  if (!source || source.status === "detached")
    fail(404, "Content subscription unavailable");
  if (source.creator_id !== actor.id)
    fail(403, "Only the subscribing user can change the content scope");
  const { group, value } = await contentSubscriptionConfig(db, source);
  if (input.sourceId !== value.sourceId)
    fail(400, "Create a separate subscription for a different source");
  await readContentInventory(createContentService(db), contentRequest(actor), {
    sourceId: input.sourceId,
    purpose: "knowledge",
    config: input.config,
  });
  const scopeChanged =
    JSON.stringify(value.config) !== JSON.stringify(input.config);
  await transact(db, async (tx) => {
    await authorize(tx, actor, libraryId, 4);
    const saved = await tx
      .updateTable("knowledge_source_groups")
      .set({
        title: input.title,
        config: JSON.stringify({
          ...value,
          config: input.config,
        }),
      })
      .where("id", "=", group.id)
      .where("config", "=", group.config!)
      .executeTakeFirst();
    if (!Number(saved.numUpdatedRows))
      fail(409, "Content subscription changed");
    await tx
      .updateTable("knowledge_subscriptions")
      .set({
        name: input.title,
        source_version: scopeChanged ? "" : source.source_version,
      })
      .where("id", "=", source.id)
      .execute();
  });
  return { id: source.id, groupId };
}
