import { randomUUID } from "node:crypto";
import type { DB, Schema } from "@db/index.js";
import type { Actor } from "../identity/passwords.js";
import type { JsonObject } from "@smartdoca/plugin-sdk";
import { authorize } from "../access/queries.js";
import {
  authorizeFileFolder,
  authorizeFileItem,
} from "../access/file-access.js";
import {
  createContentService,
  contentReferenceKey,
} from "../content/service.js";
import {
  readContentInventory,
  readChangedContent,
} from "../content/snapshot.js";
import { contentBlocks } from "../content/blocks.js";
import { bookAccess, bookHash } from "./management.js";
import {
  bookFeedbackInputSchema,
  type BookFeedbackInput,
  type BookArtifact,
  bookSourceInputSchema,
  type BookSourceBinding,
  type BookSourceReference,
  type Evidence,
} from "./protocol.js";
import { AppError } from "../../shared/errors.js";
import { bookFail as fail } from "./errors.js";

export interface BookSourceRuntime {
  readFile(
    actor: Actor,
    id: string,
  ): Promise<{ title: string; text: string; version: string }>;
  readWeb(url: string): Promise<{ title: string; text: string }>;
}
export function bookContentContext(actor: Actor) {
  return {
    requestId: randomUUID(),
    signal: AbortSignal.timeout(120000),
    principal: {
      id: actor.id,
      displayName: actor.display_name,
      publicId: "",
      admin: !!actor.admin,
    },
  };
}
export async function validateBookSource(db: DB, actor: Actor, raw: unknown) {
  const configuration = bookSourceInputSchema.parse(raw);
  for (const input of configuration.items)
    await validateBinding(db, actor, input);
}
/** Binding a URL proves the page is readable now; ordinary DTO reads do not fetch the web. */
export async function validateBookSourceForSave(
  db: DB,
  actor: Actor,
  raw: unknown,
  runtime?: BookSourceRuntime,
) {
  const configuration = bookSourceInputSchema.parse(raw);
  await validateBookSource(db, actor, configuration);
  const urls = configuration.items.filter((binding) => binding.kind === "url");
  if (!urls.length) return;
  if (!runtime)
    fail(503, "A web reader is required to validate source bindings");
  let characters = 0;
  for (const binding of urls) {
    const page = await runtime.readWeb(binding.url);
    if (!page.text.trim()) fail(422, "The web source has no readable text");
    characters += page.text.length;
    if (characters > 120000)
      fail(
        413,
        "Web source content exceeds group limits; narrow the selection",
      );
  }
}
async function validateBinding(db: DB, actor: Actor, input: BookSourceBinding) {
  if (input.kind === "document" || input.kind === "library") {
    const access = await authorize(db, actor, input.resourceId, 1);
    if (access.resource.kind !== input.kind)
      fail(400, "Source resource type does not match");
    if (
      await db
        .selectFrom("knowledge_books")
        .select("id")
        .where("id", "=", input.resourceId)
        .executeTakeFirst()
    )
      fail(
        400,
        "Select source documents rather than a generated knowledge book",
      );
  } else if (input.kind === "file")
    await authorizeFileItem(db, actor, input.resourceId);
  else if (input.kind === "folder")
    await authorizeFileFolder(db, actor, input.resourceId);
  else if (input.kind === "content")
    await readContentInventory(
      createContentService(db),
      bookContentContext(actor),
      {
        sourceId: input.sourceId,
        purpose: "knowledge",
        config: input.config as JsonObject,
      },
    );
  else if (input.kind === "url") {
    const url = new URL(input.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail(400, "Use an HTTP source URL without credentials");
  }
}
export async function bookSourceContributor(
  db: DB,
  row: Schema["knowledge_book_sources"],
) {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", row.creator_id)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) fail(403, "Source contributor is unavailable");
  await bookAccess(db, actor, row.book_id, 3);
  return actor;
}
async function memberIds(db: DB, actor: Actor, source: BookSourceBinding) {
  if (!("resourceId" in source)) return [];
  const queue = [source.resourceId],
    seen = new Set<string>(),
    result: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 5000)
      fail(413, "Source tree is too large; narrow the selection");
    try {
      if (source.kind === "document" || source.kind === "library") {
        const access = await authorize(db, actor, id, 1);
        if (access.resource.kind === "document") result.push(id);
        const children = await db
          .selectFrom("resources")
          .select("id")
          .where("deleted_at", "is", null)
          .where((eb) =>
            access.resource.kind === "library"
              ? eb.and([eb("library_id", "=", id), eb("parent_id", "is", null)])
              : eb("parent_id", "=", id),
          )
          .orderBy("id")
          .execute();
        queue.push(...children.map((child) => child.id));
      } else if (source.kind === "folder") {
        await authorizeFileFolder(db, actor, id);
        queue.push(
          ...(
            await db
              .selectFrom("file_folders")
              .select("id")
              .where("parent_id", "=", id)
              .where("deleted_at", "is", null)
              .orderBy("id")
              .execute()
          ).map((x) => x.id),
        );
        for (const file of await db
          .selectFrom("file_items")
          .select("id")
          .where("parent_type", "=", "folder")
          .where("parent_id", "=", id)
          .where("deleted_at", "is", null)
          .orderBy("id")
          .execute()) {
          try {
            await authorizeFileItem(db, actor, file.id);
            result.push(file.id);
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              ![403, 404].includes(error.status)
            )
              throw error;
          }
        }
      } else {
        await authorizeFileItem(db, actor, id);
        result.push(id);
      }
    } catch (error) {
      if (
        id === source.resourceId ||
        !(error instanceof AppError) ||
        ![403, 404].includes(error.status)
      )
        throw error;
    }
  }
  return result.sort();
}
export async function readBookSource(
  db: DB,
  row: Schema["knowledge_book_sources"],
  runtime: BookSourceRuntime,
): Promise<Evidence[]> {
  const actor = await bookSourceContributor(db, row),
    configuration = bookSourceInputSchema.parse(JSON.parse(row.configuration));
  await validateBookSource(db, actor, configuration);
  const evidence: Evidence[] = [];
  let characters = 0;
  function add(
    binding: BookSourceBinding,
    title: string,
    text: string,
    version: string,
    reference: BookSourceReference,
    supplied?: { blockId: string; contentRef: Evidence["contentRef"] },
  ) {
    characters += text.length;
    if (characters > 120000)
      fail(413, "Source content exceeds analysis limits; narrow the selection");
    for (const block of supplied
      ? [{ blockId: supplied.blockId, text }]
      : contentBlocks(title, text)) {
      evidence.push({
        id: `ev_${bookHash([
          row.id,
          binding.id,
          version,
          block.blockId,
          reference.kind === "content"
            ? supplied!.contentRef
            : reference.kind === "manual"
              ? "manual"
              : reference,
        ])}`,
        sourceId: row.id,
        sourceRevision: row.revision,
        sourceVersion: version,
        title,
        text: block.text,
        contentHash: bookHash(block.text),
        reference:
          reference.kind === "manual"
            ? { kind: "manual" }
            : reference.kind === "content"
              ? { kind: "content", sourceId: reference.sourceId }
              : reference,
        blockId: block.blockId,
        ...(supplied ? { contentRef: supplied.contentRef } : {}),
      });
    }
  }
  for (const source of configuration.items) {
    const initialCount = evidence.length;
    const { id: _bindingId, ...reference } = source;
    if (source.kind === "manual")
      add(source, row.title, source.markdown, String(row.revision), reference);
    else if (source.kind === "url") {
      const page = await runtime.readWeb(source.url);
      add(
        source,
        page.title || row.title,
        page.text,
        bookHash(page.text),
        reference,
      );
    } else if (source.kind === "content") {
      const content = await readChangedContent(
        createContentService(db),
        bookContentContext(actor),
        {
          sourceId: source.sourceId,
          purpose: "knowledge",
          config: source.config as JsonObject,
        },
        new Map(),
      );
      for (const item of content.changed)
        add(source, item.title, item.text, item.fingerprint, reference, {
          blockId: item.ref.blockId,
          contentRef: item.ref,
        });
    } else {
      const ids = await memberIds(db, actor, source);
      if (!ids.length) fail(422, "The source has no readable content");
      for (const id of ids) {
        if (source.kind === "file" || source.kind === "folder") {
          const file = await runtime.readFile(actor, id);
          if (!file.text.trim())
            fail(
              422,
              "File has no extracted text; provide another source or a manual supplement",
            );
          add(source, file.title, file.text, file.version, {
            kind: "file",
            resourceId: id,
          });
        } else {
          const { resource } = await authorize(db, actor, id, 1);
          const state = await db
            .selectFrom("document_states")
            .select(["text", "seq"])
            .where("resource_id", "=", id)
            .executeTakeFirst();
          if (!state || !state.text.trim())
            fail(422, "Document has no readable content");
          add(
            source,
            resource.title,
            state.text,
            `${resource.version}:${state.seq}`,
            {
              kind: "document",
              resourceId: id,
            },
          );
        }
      }
    }
    if (evidence.length === initialCount)
      fail(422, "Source binding has no readable content");
  }
  return evidence;
}
export async function canReadBookEvidence(
  db: DB,
  actor: Actor | null,
  evidence: Evidence,
) {
  const source = evidence.reference;
  try {
    if (source.kind === "feedback") {
      const row = await db
        .selectFrom("knowledge_book_feedback_versions")
        .select("detail")
        .where("feedback_id", "=", source.feedbackId)
        .where("revision", "=", source.revision)
        .executeTakeFirst();
      return (
        !!row &&
        (await canReadBookFeedback(
          db,
          actor,
          bookFeedbackInputSchema.parse(JSON.parse(row.detail)),
        ))
      );
    }
    if (source.kind === "manual" || source.kind === "url") return true;
    if (source.kind === "document" || source.kind === "library") {
      await authorize(db, actor, source.resourceId, 1);
      if (source.kind === "document") {
        if (!/^[0-9]+:[0-9]+$/.test(evidence.sourceVersion)) return false;
        const state = await db
          .selectFrom("document_states")
          .select("seq")
          .where("resource_id", "=", source.resourceId)
          .executeTakeFirst();
        if (!state) return false;
        if (String(state.seq) !== evidence.sourceVersion.split(":")[1])
          await authorize(db, actor, source.resourceId, "read_history");
      }
      return true;
    }
    if (source.kind === "file") {
      if (!actor) return false;
      await authorizeFileItem(db, actor, source.resourceId);
      return true;
    }
    if (source.kind === "folder") {
      if (!actor) return false;
      await authorizeFileFolder(db, actor, source.resourceId);
      return true;
    }
    if (source.kind === "content" && evidence.contentRef) {
      if (!actor) return false;
      const subscription = await db
        .selectFrom("knowledge_book_sources")
        .select("status")
        .where("id", "=", evidence.sourceId)
        .executeTakeFirst();
      if (!subscription || subscription.status === "removed") return false;
      const resolved = await createContentService(db).resolve(
        bookContentContext(actor),
        { ref: evidence.contentRef, purpose: "knowledge" },
      );
      return !!resolved;
    }
    return false;
  } catch {
    return false;
  }
}
export async function validateBookEvidence(
  db: DB,
  bookId: string,
  evidence: Evidence[],
  runtime: BookSourceRuntime,
) {
  const sources = await db
    .selectFrom("knowledge_book_sources")
    .selectAll()
    .where("book_id", "=", bookId)
    .where("status", "=", "active")
    .orderBy("id")
    .execute();
  for (const sourceId of new Set(
    evidence
      .filter((e) => e.reference.kind !== "feedback")
      .map((e) => e.sourceId),
  )) {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) fail(409, "Source was removed or paused during the run");
    const expected = evidence.filter((e) => e.sourceId === sourceId);
    if (expected.some((e) => e.sourceRevision !== source.revision))
      fail(409, "Source configuration changed during the run");
    const current = new Map(
      (await readBookSource(db, source, runtime)).map((e) => [e.id, e]),
    );
    for (const item of expected) {
      const live = current.get(item.id);
      if (
        !live ||
        live.sourceVersion !== item.sourceVersion ||
        live.contentHash !== item.contentHash
      )
        fail(409, "Source content changed during the run");
    }
  }
}

/** Follow immutable feedback anchors to original evidence without cycles or credential unions. */
export async function canReadBookFeedback(
  db: DB,
  actor: Actor | null,
  detail: BookFeedbackInput,
) {
  const queue = detail.releaseId ? [detail.releaseId] : [],
    seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 100) return false;
    const release = await db
      .selectFrom("knowledge_book_releases")
      .select(["book_id", "artifact"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!release) return false;
    try {
      await bookAccess(db, actor, release.book_id);
    } catch {
      return false;
    }
    const artifact = JSON.parse(release.artifact) as BookArtifact;
    for (const evidence of artifact.evidence) {
      if (evidence.reference.kind === "feedback") {
        const ref = evidence.reference,
          row = await db
            .selectFrom("knowledge_book_feedback_versions")
            .select("detail")
            .where("feedback_id", "=", ref.feedbackId)
            .where("revision", "=", ref.revision)
            .executeTakeFirst();
        if (!row) return false;
        const prior = bookFeedbackInputSchema.parse(JSON.parse(row.detail));
        if (prior.releaseId) queue.push(prior.releaseId);
      } else if (!(await canReadBookEvidence(db, actor, evidence)))
        return false;
    }
  }
  return true;
}
