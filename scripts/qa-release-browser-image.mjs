// Real image acceptance with isolated in-memory databases and temporary original-image storage.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const image =
  process.env.DOCA_RELEASE_QA_IMAGE ?? `smartdoca/doca:${version}-candidate`;
const output = resolve(`artifacts/verification/release-${version}`);
await mkdir(output, { recursive: true });
const code = `
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import sharp from 'sharp';
import {unzipSync} from 'fflate';
import {JSDOM} from 'jsdom';
const root=await mkdtemp('/tmp/doca-browser-release-');
process.env.DOCA_CREDENTIAL_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DOCA_FILE_STORE_ID='local';
process.env.DOCA_FILE_STORES_JSON=JSON.stringify({version:1,stores:{local:{provider:'local',root}}});
const {openDatabase}=await import('./packages/db/src/index.ts');
const {createUser}=await import('./packages/core/src/modules/identity/passwords.ts');
const {readAIDocument}=await import('./packages/core/src/workflows/ai-documents.ts');
const {createApp}=await import('./apps/server/src/app/create-app.ts');
const {storageRuntime}=await import('./apps/server/src/adapters/storage.ts');
const db=await openDatabase({driver:'sqlite',path:':memory:'});
const user=await createUser(db,{login:'releasesmoke',displayName:'Release smoke',password:'isolated-release-smoke-password'},{bootstrap:true});
const origin='http://127.0.0.1:39627',host='127.0.0.1:39627';
const app=await createApp(db,{origin,staticDirectory:'/app/apps/web/dist',storage:storageRuntime(),ai:{memory:{driver:'sqlite',url:':memory:'}}});
let cookie='';
const call=(method,path,payload,token)=>app.inject({method,url:'/api/v1'+path,headers:{host,origin:token?'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':origin,cookie:token?'':cookie,...(token?{authorization:'Bearer '+token}:{})},payload});
const ok=response=>{assert.equal(response.statusCode,200,response.body);return response.json();};
try {
  const health=await app.inject({url:'/health',headers:{host}});assert.equal(ok(health).version,${JSON.stringify(version)});
  assert.equal((await app.inject({url:'/',headers:{host}})).statusCode,200);
  const signIn=async()=>{const result=await call('POST','/auth/login',{login:'releasesmoke',password:'isolated-release-smoke-password'});ok(result);cookie=String(result.headers['set-cookie']).split(';')[0];};
  await signIn();
  const zip=await call('POST','/me/browser-clipper/download',{});assert.equal(zip.statusCode,200,zip.body);
  const files=unzipSync(zip.rawPayload);assert.deepEqual(JSON.parse(new TextDecoder().decode(files['connection.json'])),{version:2,origin});
  for(const name of ['manifest.json','background.js','login-bridge.js','capture.js','content.js','ui.html','ui.js','icon.png']) assert(files[name]?.length>0,name);
  const verifier=randomBytes(32).toString('hex'),installationId=randomUUID(),challenge=createHash('sha256').update(verifier).digest('hex');
  const authorize=()=>call('POST','/me/browser-clipper/authorize',{version:2,installationId,challenge});
  const loginCode=ok(await authorize());
  const grant=ok(await call('POST','/browser-clipper/token',{version:2,code:loginCode.code,verifier}));
  assert(grant.token.startsWith('doca_browser_v2_'));assert(Date.parse(grant.expiresAt)-Date.now()<=600000);
  assert.equal((await call('POST','/browser-clipper/token',{version:2,code:loginCode.code,verifier})).statusCode,401);
  const profile=ok(await call('POST','/me/browser-clipper/profiles',{name:'Release original images',enabled:true,isDefault:true,strategy:'create',libraryId:null,parentId:null,targetId:null,titleTemplate:'{title}',aiInstruction:''}));
  const dom=new JSDOM('<title>Retained original</title><article><h1>Original content</h1><a href="/image-details"><img src="/original.png" alt="original"></a><p>Original article ending.</p></article>',{url:'https://source.example.test/article',runScripts:'outside-only'});
  Object.assign(dom.window,{TextEncoder});dom.window.eval(new TextDecoder().decode(files['capture.js']));
  const capture=dom.window.DocaCapture.capture('page');dom.window.close();assert.equal(capture.images.length,1);
  const requestId=randomUUID(),imageId=capture.images[0].id;
  ok(await call('POST','/browser-clipper/clips',{version:1,requestId,profileId:profile.id,profileRevision:profile.revision,...capture},grant.token));
  const bytes=await sharp({create:{width:12,height:12,channels:3,background:'#3370ff'}}).png().toBuffer();
  const uploaded=await app.inject({method:'PUT',url:'/api/v1/browser-clipper/clips/'+requestId+'/images/'+imageId,headers:{host,origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',authorization:'Bearer '+grant.token,'content-type':'application/octet-stream'},payload:bytes});ok(uploaded);
  const saved=ok(await call('POST','/browser-clipper/clips/'+requestId+'/commit',{},grant.token));
  const document=await readAIDocument(db,{actor:user},saved.resourceId),body=JSON.stringify(document.value);
  assert(body.includes('"type":"image"'));assert(body.includes('https://source.example.test/image-details'));assert(body.includes('Original article ending.'));
  const asset=await db.selectFrom('assets').select('id').where('resource_id','=',saved.resourceId).executeTakeFirstOrThrow();
  const original=await call('GET','/assets/'+asset.id+'/content');assert.equal(original.statusCode,200,original.body);assert(original.rawPayload.equals(bytes));
  ok(await call('POST','/auth/logout',{}));assert.equal((await call('GET','/browser-clipper/me',undefined,grant.token)).statusCode,401);
  await signIn();const fresh=ok(await authorize()),renewed=ok(await call('POST','/browser-clipper/token',{version:2,code:fresh.code,verifier}));assert.equal(renewed.connectionId,grant.connectionId);
  ok(await call('POST','/me/browser-clipper/revoke-all',{}));assert.equal((await call('GET','/browser-clipper/me',undefined,renewed.token)).statusCode,401);
  assert.equal((await authorize()).statusCode,403);
  assert.equal((await call('GET','/resources/'+saved.resourceId)).statusCode,200);
  console.log(JSON.stringify({passed:true,version:${JSON.stringify(version)},arch:process.arch,uid:process.getuid(),health:200,web:200,publicExtensionPackage:true,linkedImageCapture:true,singleUseWebsiteAuthorization:true,originalImageByteExact:true,websiteLogoutInvalidatesAccess:true,revokedConnectionCannotAutoRestore:true,savedContentPreserved:true}));
} finally {await app.close();await db.destroy();await rm(root,{recursive:true,force:true});}
`;
const run = promisify(execFile),
  results = [];
const selectedArch = process.env.DOCA_RELEASE_QA_ARCH;
assert(!selectedArch || ["arm64", "amd64"].includes(selectedArch));
for (const arch of selectedArch ? [selectedArch] : ["arm64", "amd64"]) {
  const { stdout } = await run(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--platform",
      `linux/${arch}`,
      "--entrypoint",
      "node",
      image,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      code,
    ],
    { timeout: 180000, maxBuffer: 2_000_000 },
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.uid, 1000);
  assert(result.passed);
  results.push(result);
}
await writeFile(
  resolve(output, "docker-smoke.json"),
  JSON.stringify({ passed: true, image, results }, null, 2) + "\n",
);
console.log(JSON.stringify(results));
