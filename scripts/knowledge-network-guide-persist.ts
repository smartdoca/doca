/** Persist reviewed demo artifacts through the same native-document publication path. */
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import {
  saveHumanKnowledge,
  reviewKnowledgeEntry,
} from "../packages/core/src/modules/knowledge/system.js";
import {
  knowledgeOverviewContext,
  saveKnowledgeOverview,
} from "../packages/core/src/modules/knowledge/overview.js";
const directory = "artifacts/network-guide",
  state = JSON.parse(await readFile(`${directory}/state.json`, "utf8")),
  db = await openDatabase(config().database);
try {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("login", "=", "admin")
    .executeTakeFirstOrThrow();
  let updated = 0;
  for (const [key, chapter] of Object.entries(state.chapters) as any) {
    const markdown = await readFile(`${directory}/${key}.md`, "utf8"),
      entry = await db
        .selectFrom("knowledge_entries")
        .selectAll()
        .where("id", "=", chapter.id)
        .executeTakeFirstOrThrow();
    if (entry.markdown === markdown) continue;
    const draft = await saveHumanKnowledge(
      db,
      actor,
      state.libraryId,
      {
        id: entry.id,
        expectedRevision: entry.revision,
        title: chapter.title,
        path: chapter.path,
        markdown,
      },
      "ai",
    );
    await reviewKnowledgeEntry(
      db,
      actor,
      state.libraryId,
      draft.id,
      draft.revision,
      "publish",
    );
    chapter.characters = markdown.length;
    updated++;
  }
  const directories = await db
    .selectFrom("knowledge_directories")
    .selectAll()
    .where("library_id", "=", state.libraryId)
    .execute();
  for (const row of directories) {
    const title = row.path.split("\u001f").at(-1)!;
    const context = await knowledgeOverviewContext(
      db,
      actor,
      state.libraryId,
      row.resource_id,
    );
    if (context.title === title) continue;
    const file = `${directory}/overviews/${row.resource_id}.md`;
    const body = (await readFile(file, "utf8"))
      .replace(/^\s*# [^\n]*\n?/, "")
      .trim();
    await db
      .updateTable("resources")
      .set({ title })
      .where("id", "=", row.resource_id)
      .execute();
    const latest = await knowledgeOverviewContext(
      db,
      actor,
      state.libraryId,
      row.resource_id,
    );
    await saveKnowledgeOverview(db, actor, state.libraryId, {
      ...latest,
      markdown: `# ${title}\n\n${body}`,
    });
    await writeFile(file, `# ${title}\n\n${body}`);
  }
  await writeFile(`${directory}/state.json`, JSON.stringify(state, null, 2));
  console.log(
    JSON.stringify({
      updated,
      chapters: Object.keys(state.chapters).length,
      overviews: directories.length,
      characters: Object.values(state.chapters).reduce(
        (n: number, c: any) => n + c.characters,
        0,
      ),
    }),
  );
} finally {
  await db.destroy();
}
