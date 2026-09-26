/** Builds editable parent guides from child digests, deepest first. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
import { aiConfig } from "../packages/core/src/modules/ai/config.js";
import { meteredModel } from "../apps/server/src/services/ai/model.js";
import { knowledgeGenerate } from "../apps/server/src/services/ai/knowledge-model.js";
import {
  knowledgeOverviewContext,
  saveKnowledgeOverview,
} from "../packages/core/src/modules/knowledge/overview.js";
import { appendKnowledgeMessage } from "../packages/core/src/modules/knowledge/conversations.js";
const directory = "artifacts/network-guide",
  state = JSON.parse(await readFile(`${directory}/state.json`, "utf8"));
const db = await openDatabase(config().database);
try {
  const actor = await db
    .selectFrom("users")
    .select(["id", "display_name", "admin"])
    .where("login", "=", "admin")
    .executeTakeFirstOrThrow();
  const model = await meteredModel(
    db,
    actor.id,
    (await aiConfig(db)).defaultModel,
    null,
  );
  const directories = await db
    .selectFrom("knowledge_directories")
    .selectAll()
    .where("library_id", "=", state.libraryId)
    .execute();
  const progress: any = await readFile(`${directory}/overviews.json`, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  await mkdir(`${directory}/overviews`, { recursive: true });
  let writing = Promise.resolve();
  for (const depth of [
    ...new Set(directories.map((x) => x.path.split("\u001f").length)),
  ].sort((a, b) => b - a)) {
    const queue = directories.filter(
      (x) =>
        x.path.split("\u001f").length === depth && !progress[x.resource_id],
    );
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const parent = queue.shift()!;
          for (let attempt = 0; attempt < 3; attempt++)
            try {
              const context = await knowledgeOverviewContext(
                db,
                actor,
                state.libraryId,
                parent.resource_id,
              );
              const result = await knowledgeGenerate(model, {
                prompt: [
                  {
                    role: "system",
                    content:
                      "根据子章节摘要编写中文知识分类导读页，只输出Markdown。300到700个汉字。解释本类解决的问题、核心概念之间的关系、推荐阅读路径、排障入口，最后以Markdown链接列出每个子页及其学习价值。只引用提供的link，不编造链接。导读不是全文合并，不新增未经子页支持的技术参数。避免空话。",
                  },
                  {
                    role: "user",
                    content: [{ type: "text", text: JSON.stringify(context) }],
                  },
                ],
                maxOutputTokens: 3000,
                abortSignal: AbortSignal.timeout(120000),
              });
              if (result.finishReason.unified === "length")
                throw Error("Overview truncated");
              const markdown = result.content
                .filter((x: any) => x.type === "text")
                .map((x: any) => x.text)
                .join("\n");
              await saveKnowledgeOverview(db, actor, state.libraryId, {
                ...context,
                markdown,
              });
              writing = writing.then(async () => {
                progress[parent.resource_id] = {
                  title: context.title,
                  path: parent.path.split("\u001f"),
                  characters: markdown.length,
                  children: context.children.length,
                };
                await writeFile(
                  `${directory}/overviews/${parent.resource_id}.md`,
                  markdown,
                );
                await writeFile(
                  `${directory}/overviews.json`,
                  JSON.stringify(progress, null, 2),
                );
                await appendKnowledgeMessage(
                  db,
                  state.conversationId,
                  "tool",
                  "overview",
                  null,
                  "assistant",
                  {
                    name: "overview",
                    status: "completed",
                    result: progress[parent.resource_id],
                  },
                );
                console.log(
                  JSON.stringify({
                    overview: context.title,
                    characters: markdown.length,
                  }),
                );
              });
              await writing;
              break;
            } catch (error) {
              console.log(
                JSON.stringify({
                  retry: parent.path,
                  attempt,
                  error: String(error),
                }),
              );
              if (attempt === 2) throw error;
            }
        }
      }),
    );
  }
} finally {
  await db.destroy();
}
