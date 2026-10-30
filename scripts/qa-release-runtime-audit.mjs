import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const arch = process.argv[2];
assert(["arm64", "amd64"].includes(arch));
const { version, dependencies } = JSON.parse(
  await readFile("package.json", "utf8"),
);
const image =
  process.env.DOCA_RELEASE_QA_IMAGE ?? `smartdoca/doca:${version}-candidate`;
const { stdout } = await promisify(execFile)(
  "docker",
  [
    "run",
    "--rm",
    "--platform",
    `linux/${arch}`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    `
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files={};
const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','dist'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(e.name))files[p]=digest(p)}};
walk('apps/server');walk('packages');const walkExtension=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walkExtension(p);else files[p]=digest(p)}};walkExtension('apps/browser-extension');for(const p of ['package.json','tsconfig.json','apps/server/src/renderers/document-pdf.py','apps/server/dist/canvas-render/sdk.js','apps/server/dist/canvas-render/NotoSansSC-Regular.ttf','docker/admin.sh'])files[p]=digest(p);
const webAssets={};const walkWeb=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walkWeb(p);else if(!/\\.(?:gz|br)$/.test(e.name))webAssets[p]=digest(p)}};walkWeb('apps/web/dist');
const editorNames=['canvas','sheet','slate','slides','markdown'];
const editorFiles=['node_modules/@smartdoca/canvas/dist/model.js','node_modules/@smartdoca/sheet/dist/model.js','node_modules/@smartdoca/sheet/dist/yjs.js','node_modules/@smartdoca/markdown/dist/index.js',...editorNames.map(name=>'node_modules/@smartdoca/'+name+'/package.json')];
const editors=Object.fromEntries(editorNames.map(name=>[name,JSON.parse(fs.readFileSync('node_modules/@smartdoca/'+name+'/package.json')).version]));
console.log(JSON.stringify({files,webAssets,editors,editorFiles:Object.fromEntries(editorFiles.map(p=>[p,digest(p)])),uid:process.getuid()}));
`,
  ],
  { maxBuffer: 10_000_000 },
);
const result = JSON.parse(stdout);
assert.equal(result.uid, 1000);
for (const [name, selected] of Object.entries(result.editors))
  assert.equal(selected, dependencies[`@smartdoca/${name}`]);
for (const group of [result.files, result.webAssets, result.editorFiles]) {
  for (const [path, hash] of Object.entries(group))
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      hash,
      path,
    );
}
assert(Object.keys(result.files).length > 400);
assert(Object.keys(result.webAssets).length > 100);
const output = resolve(`artifacts/verification/release-${version}`);
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, `runtime-${arch}.json`),
  JSON.stringify(
    {
      passed: true,
      arch,
      image,
      matchedSourceFiles: Object.keys(result.files).length,
      matchedWebFiles: Object.keys(result.webAssets).length,
      ...result,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    passed: true,
    arch,
    matchedSourceFiles: Object.keys(result.files).length,
    matchedWebFiles: Object.keys(result.webAssets).length,
    editors: result.editors,
  }),
);
