/** Regroups only this demo's registered RFCs; member IDs and citations are retained. */
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import {
  subscribeKnowledgeSource,
  updateKnowledgeSourceGroup,
} from "../packages/core/src/modules/knowledge/subscriptions.js";
const path = "artifacts/network-guide/state.json",
  state = JSON.parse(await readFile(path, "utf8")),
  db = await openDatabase(config().database);
try {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("login", "=", "admin")
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom("knowledge_subscriptions")
    .selectAll()
    .where("library_id", "=", state.libraryId)
    .where("id", "in", Object.values(state.sources) as string[])
    .execute();
  const urls = rows.map((x) => x.url).filter(Boolean),
    title = "网络协议 · IETF / RFC 原始规范";
  if (state.sourceGroupId)
    await updateKnowledgeSourceGroup(
      db,
      actor,
      state.libraryId,
      state.sourceGroupId,
      { title, urls },
    );
  else {
    const group = await subscribeKnowledgeSource(db, actor, state.libraryId, {
      sourceKind: "url",
      title,
      urls,
    });
    state.sourceGroupId = group.groupId;
    await writeFile(path, JSON.stringify(state, null, 2));
  }
  console.log(
    JSON.stringify({ groupId: state.sourceGroupId, members: urls.length }),
  );
} finally {
  await db.destroy();
}
