// Creates every database/directory here; never connects to a deployment database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { openDatabase, type DatabaseConfig } from "@db/connection.js";
import { restoreDocument } from "@core/modules/collaboration/documents.js";

const exec = promisify(execFile),
  driver = process.argv[2] ?? "sqlite",
  image = process.argv[3] ?? "smartdoca/doca:0.1.28";
assert(["sqlite", "postgres"].includes(driver));
if (driver === "postgres" && !process.env.DOCA_TEST_POSTGRES)
  throw Error("Set DOCA_TEST_POSTGRES to an isolated test server");
const root = await mkdtemp(join(tmpdir(), "doca-editor-upgrade-"));
const key = randomBytes(32).toString("hex");
const oldSource = String.raw`
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '@db/connection.js';
import { createUser } from '@core/modules/identity/passwords.js';
import { createContent } from '@core/workflows/resources.js';
import { createDocuments, restoreDocument, b64 } from '@core/modules/collaboration/documents.js';
const db=await openDatabase(process.env.DOCA_DATABASE==='postgres'?{driver:'postgres',url:process.env.DOCA_DATABASE_URL}:{driver:'sqlite',path:'/fixture/core.db'});
try {
 const owner={...await createUser(db,{login:'released-editor-fixture',displayName:'Retained owner',password:'isolated-upgrade-password'},{bootstrap:true}),admin:1};
 const content=createContent(db),docs=createDocuments(db);
 const rich=await content.create(owner,{kind:'document',format:'rich_text',title:'Retained released rich text'});
 const protocol={codec:'slate-kit',schemaVersion:3,protocolVersion:1};
 const initial=await docs.exchange(owner,rich.id,protocol),runtime=await restoreDocument(db,rich.id);
 try {
  const update=runtime.runtime.execute({type:'insertBlock',block:{id:'retained-old-diagram',type:'mindmap',children:[{text:''}],mindData:{direction:1,nodeData:{id:'root',topic:'保留原始思维导图',children:[{id:'branch',topic:'旧分支',side:'right'}]}},previewVersion:5,previewSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="140" height="60"><text y="20">old preview</text></svg>'}});
  await docs.exchange(owner,rich.id,{...protocol,epochId:initial.epochId,messageId:randomUUID(),update:b64(update)});
 } finally {runtime.destroy()}
 const richSaved=await restoreDocument(db,rich.id);
 let richValue;try {richValue=richSaved.runtime.getValue()} finally {richSaved.destroy()}
 const tables={};
 for(const name of ['users','resources','grants','settings','schema_baseline','document_states','editor_epochs','document_updates','editor_receipts','document_versions']) tables[name]=await db.selectFrom(name).selectAll().execute();
 await writeFile('/fixture/snapshot.json',JSON.stringify({owner,richId:rich.id,richValue,tables}));
 console.log('Released 0.1.28 created a retained native mind map and checkpoint');
} finally {await db.destroy()}
`;
let admin: Pool | undefined, name: string | undefined, main: DatabaseConfig;
try {
  await writeFile(join(root, "old-fixture.ts"), oldSource);
  const env: Record<string, string> = {
    DOCA_DATABASE: driver,
    DOCA_CREDENTIAL_MASTER_KEY: key,
  };
  if (driver === "postgres") {
    const url = new URL(process.env.DOCA_TEST_POSTGRES!);
    admin = new Pool({ connectionString: url.href, max: 1 });
    name = "doca_editor_upgrade_" + randomUUID().replaceAll("-", "");
    await admin.query(`create database ${name}`);
    url.pathname = "/" + name;
    main = { driver: "postgres", url: url.href };
    const containerUrl = new URL(url);
    if (["127.0.0.1", "localhost"].includes(containerUrl.hostname))
      containerUrl.hostname = "host.docker.internal";
    env.DOCA_DATABASE_URL = containerUrl.href;
  } else main = { driver: "sqlite", path: join(root, "core.db") };
  await writeFile(
    join(root, "old.env"),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const old = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0",
      ...(process.platform === "linux"
        ? ["--add-host", "host.docker.internal:host-gateway"]
        : []),
      "--env-file",
      join(root, "old.env"),
      "-v",
      `${resolve(root)}:/fixture`,
      "-v",
      `${resolve(root, "old-fixture.ts")}:/app/editor-upgrade-old-fixture.ts:ro`,
      image,
      "node",
      "--import",
      "tsx",
      "editor-upgrade-old-fixture.ts",
    ],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  process.stdout.write(old.stdout);
  const expected = JSON.parse(
    await readFile(join(root, "snapshot.json"), "utf8"),
  );
  const db = await openDatabase(main);
  try {
    const assertRows = async () => {
      for (const [table, rows] of Object.entries(expected.tables)) {
        const actual = await db
          .selectFrom(table as any)
          .selectAll()
          .execute();
        const sorted = (value: any[]) =>
          value.map((row) => JSON.stringify(row)).sort();
        assert.deepEqual(sorted(actual), sorted(rows as any[]), table);
      }
    };
    await assertRows();
    const rich = await restoreDocument(db, expected.richId);
    try {
      assert.deepEqual(rich.runtime.getValue(), expected.richValue);
    } finally {
      rich.destroy();
    }
    await assertRows();
    const reopened = await restoreDocument(db, expected.richId);
    try {
      assert.deepEqual(reopened.runtime.getValue(), expected.richValue);
    } finally {
      reopened.destroy();
    }
    await assertRows();
    console.log(
      `${driver}: released 0.1.28 → current passed; original mind map, all retained rows and original Yjs/checkpoint bytes unchanged across repeated opens`,
    );
  } finally {
    await db.destroy();
  }
} finally {
  if (admin) {
    try {
      if (name) await admin.query(`drop database ${name} with (force)`);
    } finally {
      await admin.end();
    }
  }
  await rm(root, { recursive: true, force: true });
}
