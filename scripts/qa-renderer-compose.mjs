// Exercise the single-file installer against a disposable Compose project only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const image = process.env.DOCA_RELEASE_QA_IMAGE ?? `smartdoca/doca:${version}-renderer-candidate`;
const output = resolve(process.env.DOCA_RELEASE_QA_OUTPUT ?? "artifacts/verification/chromium-alternatives/compose");
await mkdir(output, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const project = `doca-renderer-qa-${randomBytes(5).toString("hex")}`;
const file = resolve(output, "isolated-compose.yaml");
const published = resolve(process.env.DOCA_RELEASE_QA_DEPLOYMENT ?? `artifacts/verification/chromium-alternatives/deployment/doca-compose-v${version}.yaml`);
let yaml = (await readFile(published, "utf8")).replace(`docker.io/smartdoca/doca:${version}`, image);
await writeFile(resolve(output, "compose.yaml"), yaml);
yaml = yaml.replace("https://docs.example.com", origin)
  .replace("REPLACE_WITH_YOUR_64_HEX_CHARACTER_KEY", randomBytes(32).toString("hex"))
  .replace('127.0.0.1:39120:39120', `127.0.0.1:${port}:39120`);
await writeFile(file, yaml, { mode: 0o600 });
const compose = async (...args) => (await execute("docker", ["compose", "-p", project, "-f", file, ...args], { timeout: 120_000 })).stdout;
async function admin(action, password) {
  await new Promise((resolve, reject) => {
    const child = execFile("docker", ["compose", "-p", project, "-f", file,
      "exec", "-T", "doca", "bash", "docker/admin.sh", action], { timeout: 30_000 }, error => error ? reject(error) : resolve());
    child.stdin.end(`rendererqa\n${password}\n${password}\n`);
  });
}
async function login(password) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify({ login: "rendererqa", password }),
  });
  await response.arrayBuffer();
  return response.status;
}
try {
  await compose("config", "--quiet");
  await compose("up", "-d", "--pull", "never", "--no-build");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${origin}/health`)).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, "Isolated Compose application did not become ready");
  await admin("bootstrap", "isolated-renderer-bootstrap-password");
  assert.equal(await login("isolated-renderer-bootstrap-password"), 200);
  await admin("reset-password", "isolated-renderer-reset-password");
  assert.equal(await login("isolated-renderer-bootstrap-password"), 401);
  assert.equal(await login("isolated-renderer-reset-password"), 200);
  await writeFile(resolve(output, "result.json"), JSON.stringify({ passed: true, image,
    singleYaml: true, noExternalScripts: true, noSeccompFile: true,
    health: 200, administratorBootstrap: true, administratorReset: true, userDataUsed: false }, null, 2) + "\n");
  console.log("Isolated single-YAML installation, administrator bootstrap/reset and login passed.");
} finally {
  await compose("down", "-v", "--remove-orphans");
  await rm(file, { force: true });
}
