import {
  recordFeedbackOrigin,
  type BookFeedbackMethod,
} from "./feedback-origin.js";
import { canReadBookEvidence } from "./sources.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB, Schema } from "@db/index.js";
import { transact } from "@db/transactions.js";
import type { Actor } from "../identity/passwords.js";
import { authorize, roleQuery } from "../access/queries.js";
import { sql } from "kysely";
import { createResourceCommands } from "../resources/commands.js";
import { createResourceRunner } from "../resources/context.js";
import { bookFail as fail } from "./errors.js";
import {
  bookConfigurationSchema,
  bookFeedbackInputSchema,
  bookSourceInputSchema,
  defaultBookConfiguration,
  type BookArtifact,
} from "./protocol.js";

export const bookHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const bookNow = () => new Date().toISOString();
export async function bookAccess(
  db: DB,
  actor: Actor | null,
  id: string,
  rank = 1,
) {
  const person = actor
    ? await db
        .selectFrom("users")
        .select("status")
        .where("id", "=", actor.id)
        .executeTakeFirst()
    : null;
  if (actor && person?.status !== "active") fail(403, "Account is unavailable");
  const access = await authorize(db, actor, id, rank);
  const book = await db
    .selectFrom("knowledge_books")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!book || access.resource.kind !== "library")
    fail(404, "Knowledge book not found");
  return { ...access, book };
}
async function audit(db: DB, actor: Actor, id: string, action: string) {
  await db
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      actor_id: actor.id,
      resource_id: id,
      action,
      created_at: bookNow(),
    })
    .execute();
}
export async function createKnowledgeBook(db: DB, actor: Actor, title: string) {
  title = z.string().trim().min(1).max(160).parse(title);
  return transact(db, async (tx) => {
    const resource = await createResourceCommands(
      tx,
      createResourceRunner(tx),
    ).create(actor, {
      title,
      kind: "library",
      format: "markdown",
      private: true,
    });
    const configuration = JSON.stringify(defaultBookConfiguration()),
      now = bookNow();
    await tx
      .insertInto("knowledge_books")
      .values({
        id: resource.id,
        revision: 1,
        configuration,
        published_release_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await tx
      .insertInto("knowledge_book_configurations")
      .values({
        book_id: resource.id,
        revision: 1,
        configuration,
        author_id: actor.id,
        created_at: now,
      })
      .execute();
    await audit(tx, actor, resource.id, "knowledge_book.created");
    return {
      id: resource.id,
      revision: 1,
      href: `/#/knowledge-books/${resource.id}`,
    };
  });
}
export async function listKnowledgeBooks(db: DB, actor: Actor, offset = 0) {
  return db
    .selectFrom("knowledge_books as b")
    .innerJoin("resources as r", "r.id", "b.id")
    .select([
      "b.id",
      "b.revision",
      "b.published_release_id",
      "r.title",
      "r.owner_id",
      "b.updated_at",
    ])
    .where("r.deleted_at", "is", null)
    .where(roleQuery(sql.ref("r.id"), actor), ">=", 1)
    .orderBy("b.updated_at", "desc")
    .orderBy("b.id")
    .limit(50)
    .offset(offset)
    .execute();
}
export async function saveBookConfiguration(
  db: DB,
  actor: Actor,
  id: string,
  expectedRevision: number,
  raw: unknown,
) {
  const configuration = bookConfigurationSchema.parse(raw);
  return transact(db, async (tx) => {
    const { book } = await bookAccess(tx, actor, id, 3);
    if (book.revision !== expectedRevision)
      fail(409, "Knowledge book configuration changed; reload before saving");
    const now = bookNow(),
      revision = expectedRevision + 1,
      encoded = JSON.stringify(configuration);
    const result = await tx
      .updateTable("knowledge_books")
      .set({ revision, configuration: encoded, updated_at: now })
      .where("id", "=", id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows))
      fail(409, "Knowledge book configuration changed");
    await tx
      .insertInto("knowledge_book_configurations")
      .values({
        book_id: id,
        revision,
        configuration: encoded,
        author_id: actor.id,
        created_at: now,
      })
      .execute();
    await audit(tx, actor, id, "knowledge_book.configured");
    return { revision, configuration };
  });
}
export async function saveBookSource(
  db: DB,
  actor: Actor,
  bookId: string,
  input: {
    id?: string;
    title: string;
    configuration: unknown;
    expectedRevision: number;
    status: "active" | "paused" | "removed";
  },
  validate: (db: DB, actor: Actor, configuration: unknown) => Promise<void>,
) {
  const configuration = bookSourceInputSchema.parse(input.configuration);
  const title = z.string().trim().min(1).max(200).parse(input.title);
  await bookAccess(db, actor, bookId, 3);
  if (input.status !== "removed") await validate(db, actor, configuration);
  return transact(db, async (tx) => {
    const access = await bookAccess(tx, actor, bookId, 3);
    const old = input.id
      ? await tx
          .selectFrom("knowledge_book_sources")
          .selectAll()
          .where("book_id", "=", bookId)
          .where("id", "=", input.id)
          .executeTakeFirst()
      : undefined;
    if (input.id && !old) fail(404, "Knowledge book source not found");
    if (old && old.creator_id !== actor.id && input.status !== "removed")
      fail(403, "Only the contributor can modify their source authorization");
    if (old && old.creator_id !== actor.id && access.rank < 4)
      fail(
        403,
        "Managing another contributor's source requires manager permission",
      );
    if (
      old &&
      old.creator_id !== actor.id &&
      (title !== old.title ||
        JSON.stringify(configuration) !== old.configuration)
    )
      fail(403, "Only the contributor can change source scope or title");
    if ((old?.revision ?? 0) !== input.expectedRevision)
      fail(409, "Knowledge book source changed");
    const id = old?.id ?? randomUUID(),
      revision = input.expectedRevision + 1,
      now = bookNow();
    const values = {
      title,
      revision,
      configuration: JSON.stringify(configuration),
      status: input.status,
      updated_at: now,
    };
    if (old) {
      const result = await tx
        .updateTable("knowledge_book_sources")
        .set(values)
        .where("id", "=", id)
        .where("revision", "=", input.expectedRevision)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows))
        fail(409, "Knowledge book source changed");
    } else
      await tx
        .insertInto("knowledge_book_sources")
        .values({
          ...values,
          id,
          book_id: bookId,
          creator_id: actor.id,
          created_at: now,
        })
        .execute();
    await tx
      .insertInto("knowledge_book_source_versions")
      .values({
        source_id: id,
        revision,
        title,
        configuration: values.configuration,
        status: input.status,
        author_id: actor.id,
        created_at: now,
      })
      .execute();
    await audit(tx, actor, bookId, "knowledge_book.source_changed");
    return { id, revision };
  });
}
export async function saveBookFeedback(
  db: DB,
  actor: Actor,
  bookId: string,
  input: {
    id?: string;
    expectedRevision: number;
    detail: unknown;
    status: "active" | "withdrawn";
  },
  method: BookFeedbackMethod = "manual",
) {
  const detail = bookFeedbackInputSchema.parse(input.detail);
  await bookAccess(db, actor, bookId, 2);
  if (detail.releaseId && input.status !== "withdrawn") {
    const release = await db
      .selectFrom("knowledge_book_releases")
      .select("artifact")
      .where("book_id", "=", bookId)
      .where("id", "=", detail.releaseId)
      .executeTakeFirst();
    if (!release) fail(404, "Knowledge book release not found");
    const artifact = JSON.parse(release.artifact) as BookArtifact;
    for (const evidence of artifact.evidence)
      if (!(await canReadBookEvidence(db, actor, evidence)))
        fail(403, "Original source access is required for anchored feedback");
  }
  return transact(db, async (tx) => {
    const access = await bookAccess(tx, actor, bookId, 2);
    const old = input.id
      ? await tx
          .selectFrom("knowledge_book_feedback")
          .selectAll()
          .where("id", "=", input.id)
          .where("book_id", "=", bookId)
          .executeTakeFirst()
      : undefined;
    if (input.id && !old) fail(404, "Knowledge book feedback not found");
    if (old && old.author_id !== actor.id && access.rank < 4)
      fail(403, "Only the author or manager can change feedback");
    if ((old?.revision ?? 0) !== input.expectedRevision)
      fail(409, "Knowledge book feedback changed");
    if (detail.releaseId) {
      const release = await tx
        .selectFrom("knowledge_book_releases")
        .select("artifact")
        .where("book_id", "=", bookId)
        .where("id", "=", detail.releaseId)
        .executeTakeFirst();
      if (!release) fail(404, "Knowledge book release not found");
      const artifact = JSON.parse(release.artifact) as BookArtifact;
      const page = artifact.pages.find((p) => p.id === detail.pageId);
      if (detail.pageId && !page)
        fail(400, "Feedback page is not in the selected release");
      if (
        detail.paragraphId &&
        !page?.paragraphs.some((p) => p.id === detail.paragraphId)
      )
        fail(400, "Feedback paragraph is not in the selected release");
    } else if (detail.pageId || detail.paragraphId)
      fail(400, "A feedback anchor requires a release");
    const id = old?.id ?? randomUUID(),
      revision = input.expectedRevision + 1,
      now = bookNow();
    const values = {
      revision,
      detail: JSON.stringify(detail),
      status: input.status,
      updated_at: now,
    };
    if (old) {
      const result = await tx
        .updateTable("knowledge_book_feedback")
        .set(values)
        .where("id", "=", id)
        .where("revision", "=", input.expectedRevision)
        .executeTakeFirst();
      if (!Number(result.numUpdatedRows))
        fail(409, "Knowledge book feedback changed");
    } else
      await tx
        .insertInto("knowledge_book_feedback")
        .values({
          ...values,
          id,
          book_id: bookId,
          author_id: actor.id,
          created_at: now,
        })
        .execute();
    await tx
      .insertInto("knowledge_book_feedback_versions")
      .values({
        feedback_id: id,
        revision,
        detail: values.detail,
        status: input.status,
        author_id: actor.id,
        created_at: now,
      })
      .execute();
    await recordFeedbackOrigin(tx, actor, bookId, id, revision, method);
    return { id, revision };
  });
}
export async function bookInputSnapshot(db: DB, bookId: string) {
  const sources = await db
    .selectFrom("knowledge_book_sources")
    .selectAll()
    .where("book_id", "=", bookId)
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  const feedback = await db
    .selectFrom("knowledge_book_feedback")
    .selectAll()
    .where("book_id", "=", bookId)
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  return {
    sources,
    feedback,
    hash: bookHash({
      sources: sources.map((s) => [s.id, s.revision]),
      feedback: feedback.map((f) => [f.id, f.revision]),
    }),
  };
}
export async function queueBookRun(
  db: DB,
  actor: Actor,
  id: string,
  triggerKey: string | null = null,
) {
  return transact(db, async (tx) => {
    const { book } = await bookAccess(tx, actor, id, 3);
    const configuration = bookConfigurationSchema.parse(
      JSON.parse(book.configuration),
    );
    if (!configuration.goal.trim())
      fail(400, "Set the knowledge book goal before running");
    const snapshot = await bookInputSnapshot(tx, id);
    if (!snapshot.sources.length)
      fail(400, "Register at least one active source");
    if (triggerKey) {
      const existing = await tx
        .selectFrom("knowledge_book_runs")
        .select(["id", "status"])
        .where("book_id", "=", id)
        .where("trigger_key", "=", triggerKey)
        .executeTakeFirst();
      if (existing) return existing;
    }
    const runId = randomUUID(),
      now = bookNow();
    await tx
      .insertInto("knowledge_book_runs")
      .values({
        id: runId,
        book_id: id,
        actor_id: actor.id,
        configuration_revision: book.revision,
        configuration: book.configuration,
        input_hash: snapshot.hash,
        status: "queued",
        lease_id: null,
        started_at: null,
        heartbeat_at: null,
        artifact: null,
        error: "",
        trigger_key: triggerKey,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await audit(tx, actor, id, "knowledge_book.run_queued");
    return { id: runId, status: "queued" as const };
  });
}
export async function changeBookRun(
  db: DB,
  actor: Actor,
  bookId: string,
  id: string,
  action: "cancel" | "publish",
) {
  return transact(db, async (tx) => {
    await bookAccess(tx, actor, bookId, 3);
    const statuses: Schema["knowledge_book_runs"]["status"][] =
      action === "publish"
        ? ["awaiting_publication"]
        : [
            "queued",
            "running",
            "awaiting_input",
            "queued_resume",
            "awaiting_publication",
            "queued_publish",
          ];
    const result = await tx
      .updateTable("knowledge_book_runs")
      .set({
        status: action === "publish" ? "queued_publish" : "cancelled",
        ...(action === "publish" ? { actor_id: actor.id } : {}),
        updated_at: bookNow(),
      })
      .where("id", "=", id)
      .where("book_id", "=", bookId)
      .where("status", "in", statuses)
      .executeTakeFirst();
    if (!Number(result.numUpdatedRows))
      fail(409, "The run cannot perform this action in its current state");
    if (action === "cancel")
      await tx
        .updateTable("knowledge_book_node_runs")
        .set({ status: "cancelled", completed_at: bookNow() })
        .where("run_id", "=", id)
        .where("status", "in", [
          "running",
          "awaiting_input",
          "awaiting_publication",
        ])
        .execute();
    await tx
      .updateTable("knowledge_book_human_tasks")
      .set({
        status: action === "publish" ? "resolved" : "cancelled",
        resolution: JSON.stringify({
          decision: action,
          actorId: actor.id,
          createdAt: bookNow(),
        }),
        updated_at: bookNow(),
      })
      .where("run_id", "=", id)
      .where("status", "=", "pending")
      .execute();
    await audit(tx, actor, bookId, `knowledge_book.run_${action}`);
    return { ok: true };
  });
}
