import { authorize } from "../access/queries.js";
import { AppError } from "../../shared/errors.js";
import { readNodeReuse } from "./retry.js";
import { readFeedbackOrigin } from "./feedback-origin.js";
import type { DB } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import { createResourceReads } from "../resources/reads.js";
import { createResourceRunner } from "../resources/context.js";
import { bookFail as fail } from "./errors.js";
import { bookAccess } from "./management.js";
import {
  bookConfigurationSchema,
  bookFeedbackInputSchema,
  type BookArtifact,
  type Evidence,
} from "./protocol.js";
import {
  canReadBookFeedback,
  canReadBookEvidence,
  validateBookSource,
} from "./sources.js";

/** All model-context inputs protect the result, including evidence omitted from model citations. */
export async function readableBookArtifact(
  db: DB,
  actor: Actor | null,
  bookId: string,
  artifact: BookArtifact,
) {
  await bookAccess(db, actor, bookId);
  const checked = new Set<string>();
  for (const evidence of artifact.evidence) {
    const key = JSON.stringify([evidence.reference, evidence.sourceId, evidence.sourceVersion, evidence.contentRef]);
    if (checked.has(key)) continue;
    if (!(await canReadBookEvidence(db, actor, evidence))) return null;
    checked.add(key);
  }
  return artifact;
}
export async function readBookRelease(
  db: DB,
  actor: Actor | null,
  bookId: string,
  id: string,
) {
  const { book } = await bookAccess(db, actor, bookId);
  const row = await db
    .selectFrom("knowledge_book_releases")
    .selectAll()
    .where("id", "=", id)
    .where("book_id", "=", bookId)
    .executeTakeFirst();
  if (!row) fail(404, "Knowledge book release not found");
  if (book.published_release_id !== row.id)
    await authorize(db, actor, bookId, "read_history");
  const artifact = await readableBookArtifact(
    db,
    actor,
    bookId,
    JSON.parse(row.artifact),
  );
  return {
    id: row.id,
    revision: row.revision,
    createdAt: row.created_at,
    runId: row.run_id,
    artifact,
    restricted: !artifact,
  };
}
export async function readKnowledgeBook(db: DB, actor: Actor, id: string) {
  const { book, rank } = await bookAccess(db, actor, id);
  const detail = await createResourceReads(db, createResourceRunner(db)).detail(
    actor,
    id,
  );
  const sources = [];
  for (const row of await db
    .selectFrom("knowledge_book_sources")
    .selectAll()
    .where("book_id", "=", id)
    .orderBy("created_at")
    .orderBy("id")
    .execute()) {
    let readable = true;
    try {
      await validateBookSource(db, actor, JSON.parse(row.configuration));
    } catch {
      readable = false;
    }
    const configuration = readable
      ? (JSON.parse(
          row.configuration,
        ) as import("./protocol.js").BookSourceInput)
      : null;
    const bindings = [];
    for (const binding of configuration?.items ?? []) {
      let title = "";
      if (binding.kind === "document" || binding.kind === "library")
        title =
          (
            await db
              .selectFrom("resources")
              .select("title")
              .where("id", "=", binding.resourceId)
              .executeTakeFirst()
          )?.title ?? "";
      else if (binding.kind === "file")
        title =
          (
            await db
              .selectFrom("file_items")
              .select("name")
              .where("id", "=", binding.resourceId)
              .executeTakeFirst()
          )?.name ?? "";
      else if (binding.kind === "folder")
        title =
          (
            await db
              .selectFrom("file_folders")
              .select("name")
              .where("id", "=", binding.resourceId)
              .executeTakeFirst()
          )?.name ?? "";
      else if (binding.kind === "url") title = binding.url;
      else if (binding.kind === "content") title = binding.sourceId;
      bindings.push({ id: binding.id, kind: binding.kind, title });
    }
    sources.push({
      id: row.id,
      revision: row.revision,
      title: readable ? row.title : "",
      configuration,
      bindings,
      status: row.status,
      creatorId: row.creator_id,
      readable,
      canEdit: readable && rank >= 3 && row.creator_id === actor.id,
      canRemove: rank >= 4 || (rank >= 3 && row.creator_id === actor.id),
    });
  }
  const feedbackRows = await db
    .selectFrom("knowledge_book_feedback")
    .selectAll()
    .where("book_id", "=", id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  let releases = await db
    .selectFrom("knowledge_book_releases")
    .select(["id", "revision", "run_id", "created_at"])
    .where("book_id", "=", id)
    .orderBy("revision", "desc")
    .limit(100)
    .execute();
  try {
    await authorize(db, actor, id, "read_history");
  } catch (error) {
    if (!(error instanceof AppError) || ![403, 404].includes(error.status))
      throw error;
    releases = releases.filter(
      (release) => release.id === book.published_release_id,
    );
  }
  const runs = await db
    .selectFrom("knowledge_book_runs")
    .select([
      "id",
      "status",
      "configuration_revision",
      "error",
      "created_at",
      "updated_at",
      "started_at",
      "trigger_key",
    ])
    .where("book_id", "=", id)
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();
  const triggers = await readBookRunTriggers(db, id, runs);
  const configuration = bookConfigurationSchema.parse(
    JSON.parse(book.configuration),
  );
  const feedback = [];
  for (const row of feedbackRows) {
    const detail = bookFeedbackInputSchema.parse(JSON.parse(row.detail));
    const readable = await canReadBookFeedback(db, actor, detail);
    feedback.push({
      origin: await readFeedbackOrigin(db, row.id, row.revision),
      id: row.id,
      revision: row.revision,
      authorId: row.author_id,
      detail: readable
        ? detail
        : {
            kind: detail.kind,
            content: "",
            releaseId: null,
            pageId: null,
            paragraphId: null,
          },
      status: row.status,
      createdAt: row.created_at,
      readable,
      canEdit: readable && (row.author_id === actor.id || rank >= 4),
      canWithdraw: rank >= 4 || (rank >= 2 && row.author_id === actor.id),
    });
  }
  return {
    detail,
    publishedOnly: false,
    revision: book.revision,
    configuration,
    canEdit: rank >= 3,
    canComment: rank >= 2,
    canManage: rank >= 4,
    sources,
    feedback,
    runs: runs.map(({ trigger_key, ...run }) => ({ ...run, trigger: triggers.get(run.id) ?? null })),
    releases,
    publishedRelease: book.published_release_id
      ? await readBookRelease(db, actor, id, book.published_release_id)
      : null,
  };
}
export async function readBookRun(
  db: DB,
  actor: Actor,
  bookId: string,
  id: string,
  view: "detail" | "pipeline" = "detail",
) {
  await bookAccess(db, actor, bookId, 3);
  const row = await db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("id", "=", id)
    .where("book_id", "=", bookId)
    .executeTakeFirst();
  if (!row) fail(404, "Knowledge book run not found");
  const artifact = row.artifact
    ? await readableBookArtifact(db, actor, bookId, JSON.parse(row.artifact))
    : null;
  const nodes = await db
    .selectFrom("knowledge_book_node_runs")
    .selectAll()
    .where("run_id", "=", id)
    .orderBy("started_at")
    .orderBy("node_id")
    .execute();
  const reused = await readNodeReuse(
    db,
    id,
    nodes.map((node) => node.node_id),
  );
  let visible = true;
  // Permissions depend on the original reference/version, not on each excerpt.
  // Cache within this request only: revocations are checked on every refresh.
  const permissions = new Map<string, boolean>();
  for (const node of nodes) {
    if (!node.output) continue;
    const output = JSON.parse(node.output);
    for (const evidence of (output.evidence ?? []) as Evidence[]) {
      const key = JSON.stringify([evidence.reference, evidence.sourceId, evidence.sourceVersion, evidence.contentRef]);
      if (!permissions.has(key)) permissions.set(key, await canReadBookEvidence(db, actor, evidence));
      if (!permissions.get(key)) visible = false;
    }
  }
  return {
    id: row.id,
    status: row.status,
    configurationRevision: row.configuration_revision,
    configuration: JSON.parse(row.configuration),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    trigger: (await readBookRunTriggers(db, bookId, [row])).get(row.id) ?? null,
    updatedAt: row.updated_at,
    heartbeatAt: row.heartbeat_at,
    logs: visible ? await readBookRunLogs(db, bookId, id, JSON.parse(row.configuration)) : [],
    artifact,
    restricted: !visible,
    nodes: nodes.map((node) => ({
      nodeId: node.node_id,
      reusedFromRunId: reused.get(node.node_id) || null,
      type: node.type,
      status: node.status,
      startedAt: node.started_at,
      completedAt: node.completed_at,
      error: node.error,
      ...(view === "detail" ? {
        inputRefs: JSON.parse(node.input_refs),
        output: visible && node.output ? JSON.parse(node.output) : null,
      } : {}),
    })),
  };
}

/** Small authorized payload for the canvas; full evidence stays in detail reads. */
export async function readBookPipeline(db: DB, actor: Actor, bookId: string, id: string) {
  const run = await readBookRun(db, actor, bookId, id, "pipeline");
  return { ...run, artifact: run.artifact ? { pages: run.artifact.pages, checks: run.artifact.checks } : null };
}

export async function readPublishedKnowledgeBook(db: DB, id: string) {
  const { book } = await bookAccess(db, null, id);
  const detail = await createResourceReads(db, createResourceRunner(db)).detail(
    null,
    id,
  );
  const publishedRelease = book.published_release_id
    ? await readBookRelease(db, null, id, book.published_release_id)
    : null;
  return {
    detail,
    revision: book.revision,
    publishedOnly: true,
    configuration: null,
    canEdit: false,
    canComment: false,
    canManage: false,
    sources: [],
    feedback: [],
    runs: [],
    releases: publishedRelease
      ? [{ id: publishedRelease.id, revision: publishedRelease.revision }]
      : [],
    publishedRelease,
  };
}
import { readBookRunLogs, readBookRunTriggers } from "./run-logs.js";
