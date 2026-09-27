import { request } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { openDatabase } from "../packages/db/src/index.js";
import { config } from "../apps/server/src/bootstrap/config.js";
const db = await openDatabase(config().database);
const actor = await db
  .selectFrom("users")
  .select("id")
  .where("login", "=", "admin")
  .executeTakeFirstOrThrow();
const token = randomBytes(32).toString("hex"),
  hash = createHash("sha256").update(token).digest("hex");
await db
  .insertInto("sessions")
  .values({
    id: hash,
    user_id: actor.id,
    expires_at: new Date(Date.now() + 600000).toISOString(),
  })
  .execute();
async function api(path: string, body?: unknown, raw = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 39120,
        path: "/api/v1" + path,
        method: body ? "POST" : "GET",
        headers: {
          Host: "127.0.0.1:39130",
          Origin: "http://127.0.0.1:39130",
          Cookie: `doca_session=${token}`,
          "Content-Type": raw ? "application/octet-stream" : "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (part) => (data += part));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400)
            reject(Error(`${res.statusCode} ${data}`));
          else resolve(JSON.parse(data));
        });
      },
    );
    req.on("error", reject);
    req.end(body ? (raw ? body : JSON.stringify(body)) : undefined);
  });
}
try {
  let report: any;
  const existing = await db
    .selectFrom("knowledge_assistants")
    .select("id")
    .where("title", "=", "验收 · 多库联合问答")
    .where("owner_id", "=", actor.id)
    .executeTakeFirst();
  const bot =
    existing ??
    (await api("/knowledge/assistants", {
      title: "验收 · 多库联合问答",
      libraryIds: [
        "20e776ed-246b-436e-980e-064411e5a309",
        "6204c6f3-732b-42f0-beec-e20f40d851c6",
      ],
      memberIds: [],
      managerIds: [],
      expectedRevision: 0,
      enabled: true,
      visibility: "invited",
      attachmentsEnabled: true,
      channels: ["web", "embed", "api", "mcp"],
    }));
  console.log(JSON.stringify({ botId: bot.id, stage: "created" }));
  const attachment = await api(
    "/assets?purpose=ai_attachment&filename=dns-acceptance.txt",
    Buffer.from(
      "DNS incident: SOA TTL=420 seconds; SOA MINIMUM=1800 seconds. NXDOMAIN was cached 120 seconds ago.",
    ),
    true,
  );
  const conversation = await api("/knowledge/conversations", {
    scopeId: bot.id,
    kind: "answer",
    title: "附件与多轮问答验收",
  });
  const requestId = randomUUID();
  await api(`/knowledge/conversations/${conversation.id}/messages`, {
    content:
      "根据附件给出的数值和知识库的 DNS 规则，初始负缓存 TTL 和现在剩余时间分别是多少？",
    requestId,
    attachments: [attachment.id],
  });
  let completed = false;
  for (let n = 0; n < 300; n++) {
    const view = await api(`/knowledge/conversations/${conversation.id}`);
    if (!["queued", "running"].includes(view.conversation.state)) {
      const result = {
        botId: bot.id,
        conversationId: conversation.id,
        state: view.conversation.state,
        messages: view.messages.map((m: any) => ({
          role: m.role,
          content: m.content,
        })),
      };
      report = result;
      console.log(JSON.stringify(result));
      const answer =
        result.messages
          .filter((message: any) => message.role === "assistant")
          .at(-1)?.content ?? "";
      if (
        !answer.includes("420") ||
        !answer.includes("300") ||
        !/\[\d+\]/.test(answer)
      )
        throw Error(
          "Attachment acceptance failed: expected 420 and 300 with evidence citation",
        );
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!completed) throw Error("Attachment acceptance timed out");
  await api(`/knowledge/conversations/${conversation.id}/messages`, {
    content: "再过一分钟还剩多少？请延续刚才附件的同一场景。",
    requestId: randomUUID(),
  });
  let followedUp = false;
  for (let n = 0; n < 180; n++) {
    const view = await api(`/knowledge/conversations/${conversation.id}`);
    if (!["queued", "running"].includes(view.conversation.state)) {
      const answer =
        view.messages
          .filter((message: any) => message.role === "assistant")
          .at(-1)?.content ?? "";
      const path = "artifacts/network-guide/bot-live-acceptance.json";
      report.followup = {
        question: "再过一分钟还剩多少？",
        answer,
        passed: answer.includes("240") && /\[\d+\]/.test(answer),
      };
      await writeFile(path, JSON.stringify(report, null, 2));
      if (!report.followup.passed)
        throw Error(
          "Follow-up acceptance failed: expected 240 with evidence citation",
        );
      console.log(JSON.stringify(report.followup));
      followedUp = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!followedUp) throw Error("Follow-up acceptance timed out");
} finally {
  await db.deleteFrom("sessions").where("id", "=", hash).execute();
  await db.destroy();
}
