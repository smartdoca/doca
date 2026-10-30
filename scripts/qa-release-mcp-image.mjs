// Verify the release image through a real HTTP MCP client and retained release data.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.env.DOCA_QA_ISOLATED !== "1")
  throw Error("Disposable release volumes only");
const arch = process.argv[2];
assert(["arm64", "amd64"].includes(arch));
const image =
  process.env.DOCA_RELEASE_QA_IMAGE ?? "smartdoca/doca:0.2.5-candidate";
const run = promisify(execFile);
const docker = async (...args) =>
  (await run("docker", args, { maxBuffer: 20_000_000 })).stdout.trim();
const name = `doca-release025-${arch}-${Date.now()}`,
  volume = `${name}-data`;
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const qaPort = probe.address().port;
await new Promise((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const publicOrigin = `http://127.0.0.1:${qaPort}`,
  host = `127.0.0.1:${qaPort}`;
const output = resolve(`artifacts/verification/release-0.2.5/${arch}-mcp`);
const fixturePath = resolve(`.cache/release-0.2.5/${arch}-mcp.json`);
await mkdir(output, { recursive: true });
await mkdir(resolve(".cache/release-0.2.5"), { recursive: true });
let base,
  lastHealth,
  succeeded = false;
const request = (path, { method = "GET", headers = {}, payload } = {}) =>
  new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = httpRequest(
      base + path,
      {
        method,
        headers: {
          host,
          origin: publicOrigin,
          ...headers,
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () =>
      req.destroy(Error("Release HTTP request timed out")),
    );
    req.end(body);
  });
async function ready() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await request("/health");
      lastHealth = { status: response.status, body: response.body };
      if (
        response.status === 200 &&
        JSON.parse(response.body).version === "0.2.5"
      )
        return;
    } catch (error) {
      lastHealth = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error("Release image startup timed out: " + JSON.stringify(lastHealth));
}
async function roundtrip(selected, mode) {
  const raw = await docker(
    "run",
    "--rm",
    "--platform",
    `linux/${arch}`,
    "-v",
    `${volume}:/data`,
    "-v",
    `${resolve("scripts/qa-mcp-upgrade.mjs")}:/qa/upgrade.mjs:ro`,
    "-e",
    "DOCA_QA_ISOLATED=1",
    "-e",
    "DOCA_MCP_SOURCE_ROOT=/app",
    "-e",
    "DOCA_MCP_UPGRADE_ROOT=/data/mcp",
    "--entrypoint",
    "node",
    selected,
    "--import",
    "tsx",
    "/qa/upgrade.mjs",
    mode,
  );
  return JSON.parse(raw.split("\n").at(-1));
}
try {
  await docker("volume", "create", volume);
  const released = await roundtrip("smartdoca/doca:0.2.4", "seed");
  assert.equal(released.releasedVersion, "0.2.4");
  const upgrade = await roundtrip(image, "check");
  assert(
    upgrade.passed &&
      upgrade.newTablesEmpty &&
      upgrade.legacyRecordPreservedAndCredentialRejected,
  );
  const extra = JSON.parse(
    await docker(
      "run",
      "--rm",
      "--platform",
      `linux/${arch}`,
      "-v",
      `${volume}:/data`,
      "--entrypoint",
      "node",
      image,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs';
import {openDatabase} from '/app/packages/db/src/connection.ts';
import {createUser} from '/app/packages/core/src/modules/identity/passwords.ts';
const fixture=JSON.parse(fs.readFileSync('/data/mcp/before.json'));
const db=await openDatabase({driver:'sqlite',path:'/data/mcp/released.db'});
try { const owner=await db.selectFrom('users').selectAll().where('id','=',fixture.userId).executeTakeFirstOrThrow();
const target=await createUser(db,{login:'image-reporter',displayName:'Image report target',password:'isolated-image-report-password'},{actor:owner});
console.log(JSON.stringify({adminId:owner.id,userId:target.id})); } finally {await db.destroy();}
`,
    ),
  );
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--platform",
    `linux/${arch}`,
    "-p",
    `127.0.0.1:${qaPort}:39120`,
    "-v",
    `${volume}:/data`,
    ...[
      `DOCA_ORIGIN=${publicOrigin}`,
      `DOCA_CREDENTIAL_MASTER_KEY=${randomBytes(32).toString("hex")}`,
      "DOCA_SQLITE_PATH=/data/mcp/released.db",
    ].flatMap((value) => ["-e", value]),
    image,
  );
  base = "http://" + (await docker("port", name, "39120"));
  await ready();
  const login = await request("/api/v1/auth/login", {
    method: "POST",
    payload: { login: "mcpupgrade", password: "isolated-mcp-upgrade-2026" },
  });
  assert.equal(login.status, 200, login.body);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  async function api(path, method, payload) {
    const response = await request("/api/v1" + path, {
      method,
      payload,
      headers: { cookie },
    });
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body);
  }
  await api("/me/mcp", "PUT", { enabled: true, revision: 0 });
  const serviceInput = {
    name: "Release image acceptance",
    enabled: true,
    grantMode: "all",
    toolIds: [],
    skillIds: [],
    expiresAt: null,
  };
  const personal = await api("/me/mcp-services", "POST", serviceInput);
  const company = await api("/admin/mcp-services", "POST", serviceInput);
  await writeFile(
    fixturePath,
    JSON.stringify({ origin: base, ...extra, personal, company }),
    { mode: 0o600 },
  );
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/qa-mcp-client.mts"],
    {
      env: {
        ...process.env,
        DOCA_MCP_QA_FIXTURE: fixturePath,
        DOCA_MCP_QA_HOST: host,
        DOCA_MCP_QA_OUTPUT: output,
      },
      maxBuffer: 10_000_000,
    },
  );
  const artifacts = JSON.parse(
    await readFile(resolve(output, "http-client.json"), "utf8"),
  );
  assert(artifacts.passed);
  const delegatedOwner = await docker(
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    "import Sqlite from 'better-sqlite3'; const db=new Sqlite('/data/mcp/released.db',{readonly:true}); try {console.log(db.prepare('select owner_id from resources where id=?').get(process.argv[1]).owner_id)} finally {db.close()}",
    artifacts.delegated.id,
  );
  assert.equal(delegatedOwner, extra.userId);
  await api(`/ai/sessions/${artifacts.execution.sessionId}`, "DELETE");
  assert.equal(
    (await request("/health", { headers: { host: "wrong.invalid" } })).status,
    421,
  );
  const runtime = JSON.parse(
    await docker(
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      `import fs from 'node:fs'; const pkg=n=>JSON.parse(fs.readFileSync(n)); console.log(JSON.stringify({uid:process.getuid(),version:pkg('/app/package.json').version,canvas:pkg('/app/node_modules/@smartdoca/canvas/package.json').version,sheet:pkg('/app/node_modules/@smartdoca/sheet/package.json').version}));`,
    ),
  );
  assert.deepEqual(runtime, {
    uid: 1000,
    version: "0.2.5",
    canvas: "0.5.6",
    sheet: "0.2.4",
  });
  await docker("restart", "--time", "20", name);
  base = "http://" + (await docker("port", name, "39120"));
  await ready();
  const client = new Client({ name: "release-restart-readback", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/api/v1/mcp"), {
      requestInit: {
        headers: { Host: host, Authorization: `Bearer ${personal.token}` },
      },
    }),
  );
  async function rpc(name, args) {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, JSON.stringify(response));
    return response.structuredContent.result;
  }
  const context = await rpc("doca_tools", {
    purpose:
      "Restart verification: read retained report, four saved native formats and saved file bytes.",
  });
  for (const doc of [
    { id: released.documentId, format: "markdown" },
    ...artifacts.documents,
  ]) {
    const read = await rpc("doca_call", {
      contextId: context.contextId,
      requestId: randomUUID(),
      tool: "document_read",
      input: { resourceId: doc.id, view: "content" },
    });
    assert.equal(read.resource.format, doc.format);
    assert(
      JSON.stringify(read).includes(
        doc.format === "markdown"
          ? "原始正文"
          : doc.format === "canvas"
            ? "测试平台"
            : "12",
      ),
    );
  }
  const file = await rpc("doca_call", {
    contextId: context.contextId,
    requestId: randomUUID(),
    tool: "file_content",
    input: { fileId: artifacts.file.id },
  });
  assert.equal(file.sha256, artifacts.file.sha256);
  assert(Buffer.from(file.base64, "base64").length > 0);
  await rpc("doca_context_close", { contextId: context.contextId });
  await client.close();
  await docker("stop", "--time", "20", name);
  assert.equal(
    await docker("inspect", "--format", "{{.State.ExitCode}}", name),
    "0",
  );
  const report = {
    passed: true,
    arch,
    image,
    runtime,
    releasedUpgrade: { from: "0.2.4", ...upgrade },
    realHttpMcp: true,
    nativeFormats: artifacts.documents.map((doc) => doc.format),
    transferredBytes: artifacts.file.size,
    transferSha256: artifacts.file.sha256,
    delegatedOwnership: true,
    closedSessionDeletion: true,
    restartReadback: true,
    hostValidation: true,
    gracefulStop: true,
  };
  await writeFile(
    resolve(output, "image.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  succeeded = true;
} catch (error) {
  console.error(
    await docker("logs", "--tail", "25", name).catch(
      () => "No image service logs",
    ),
  );
  throw error;
} finally {
  if (!succeeded && process.env.DOCA_RELEASE_QA_KEEP_ON_ERROR === "1") {
    console.error(
      JSON.stringify({ retainedContainer: name, retainedVolume: volume, base }),
    );
  } else {
    await docker("rm", "-f", name).catch(() => {});
    await docker("volume", "rm", volume).catch(() => {});
  }
}
