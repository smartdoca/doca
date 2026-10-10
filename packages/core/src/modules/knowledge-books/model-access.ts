import type { DB } from "@db/index.js";
import type { Evidence } from "./protocol.js";
import { bookFeedbackInputSchema } from "./protocol.js";
import { bookAccess, bookInputSnapshot } from "./management.js";
import { validateBookSource, canReadBookFeedback } from "./sources.js";
import { bookFail as fail } from "./errors.js";
import { isFrozenBookResume } from "./resume.js";

/** Revalidate the run and contributor grants before every vendor call, including batches and repairs. */
export async function validateBookModelAccess(
  db: DB,
  userId: string,
  runId: string,
  evidence: Evidence[],
) {
  const run = await db
    .selectFrom("knowledge_book_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run || run.status !== "running" || run.actor_id !== userId)
    fail(409, "Run was cancelled or its actor changed");
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("id", "=", userId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!actor) fail(403, "Run actor is unavailable");
  const { book } = await bookAccess(db, actor, run.book_id, 3),
    snapshot = await bookInputSnapshot(db, run.book_id);
  if (
    ((book.revision !== run.configuration_revision ||
    book.configuration !== run.configuration) && !await isFrozenBookResume(db, run.id)) ||
    snapshot.hash !== run.input_hash
  )
    fail(409, "Workflow inputs changed; run again");
  const ids = new Set(evidence.map((item) => item.sourceId));
  for (const source of snapshot.sources.filter((source) =>
    ids.has(source.id),
  )) {
    const contributor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", source.creator_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!contributor) fail(403, "Source contributor is unavailable");
    await bookAccess(db, contributor, run.book_id, 3);
    await validateBookSource(db, contributor, JSON.parse(source.configuration));
  }
  for (const feedback of snapshot.feedback.filter((feedback) =>
    ids.has(feedback.id),
  )) {
    const contributor = await db
      .selectFrom("users")
      .select(["id", "display_name", "admin"])
      .where("id", "=", feedback.author_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!contributor) fail(403, "Feedback contributor is unavailable");
    await bookAccess(db, contributor, run.book_id, 2);
    if (
      !(await canReadBookFeedback(
        db,
        contributor,
        bookFeedbackInputSchema.parse(JSON.parse(feedback.detail)),
      ))
    )
      fail(403, "Feedback lost original evidence access");
  }
}
