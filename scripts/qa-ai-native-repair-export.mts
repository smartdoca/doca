// One authorized repair of a retained synthetic checkpoint, followed by native
// PNG delivery. Never retries the earlier model job or any image generation.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,stat,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath as fromFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {chromium} from 'playwright-core';
import {openDatabase} from '../packages/db/src/index.js';
import {aiConfig} from '../packages/core/src/modules/ai/config.js';
import {readAIDocument} from '../packages/core/src/workflows/ai-documents.js';

assert.equal(process.env.DOCA_QA_ISOLATED,'1');
const input=resolve('.local/issue-tracker-ai-native-retry-diagnostic-active-2026-10-23');
const output=resolve(process.env.DOCA_QA_OUTPUT??'artifacts/verification/issue-tracker-ai-native-metadata-repair-export-2026-10-23');
const inputResult=JSON.parse(await readFile(join(input,'results.json'),'utf8'));
assert.equal(inputResult.result,'completed');assert.equal(inputResult.retryCount,1);assert.equal(inputResult.imageProviderAttempts,0);
assert(!(await stat(join(output,'qa.db')).catch(()=>null)),'Use a new output; never resubmit this task automatically');
await mkdir(output,{recursive:true});
const sha=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const retainedPaths=[join(input,'qa.db'),resolve('.local/issue-tracker-ai-native-guidance-fixed-2026-10-23/qa.db'),resolve('.local/issue-tracker-ai-native-official-0.5.12-lifecycle-2026-10-23/qa.db')];
const retained=await Promise.all(retainedPaths.map(async file=>({file,sha256:await sha(file)})));
for(const file of ['qa.db','memory.db']){
 const source=new Database(join(input,file),{readonly:true,fileMustExist:true});
 try{if(file==='qa.db')assert.equal((source.prepare("SELECT count(*) AS n FROM ai_jobs WHERE status IN ('queued','running','awaiting_approval')").get()as any).n,0);await source.backup(join(output,file));}finally{source.close()}
}
await cp(join(input,'storage'),join(output,'storage'),{recursive:true});
await cp(join(input,'web'),join(output,'web'),{recursive:true});
await cp(join(input,'.credential-master-key'),join(output,'.credential-master-key'));await chmod(join(output,'.credential-master-key'),0o600);
process.env.DOCA_CREDENTIAL_MASTER_KEY=(await readFile(join(input,'.credential-master-key'),'utf8')).trim();
process.env.DOCA_FILE_STORE_ID='local';
process.env.DOCA_FILE_STORES_JSON=JSON.stringify({version:1,stores:{local:{provider:'local',root:join(output,'storage')}}});
const db=await openDatabase({driver:'sqlite',path:join(output,'qa.db')});
const config=await aiConfig(db);assert(!config.imageModel);assert(!config.models.some(m=>m.imageGeneration));
const secrets=[...config.vendors.map(v=>v.apiKey),process.env.DOCA_CREDENTIAL_MASTER_KEY].filter((s):s is string=>!!s);
const clean=(value:string)=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),value).replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
const sourceJob=await db.selectFrom('ai_jobs').selectAll().where('id','=',inputResult.id).executeTakeFirstOrThrow();
const originalInput=JSON.parse(sourceJob.input),boardId=originalInput.currentResourceId;
const actor={id:sourceJob.user_id,admin:1}as any;
const before=await readAIDocument(db,{actor},boardId);
const initialScenePath=resolve('.local/issue-tracker-ai-native-official-0.5.12-lifecycle-2026-10-23/native-database-canvas.json');
const initialScene=JSON.parse(await readFile(initialScenePath,'utf8'));
const flatten=(value:any)=>{const out:any[]=[];const walk=(node:any)=>{out.push(node);(node.children??[]).forEach(walk)};value.scene.children.forEach(walk);return out;};
const initialNodes=flatten(initialScene),beforeNodes=flatten(before.value),beforeIds=beforeNodes.map(n=>n.id);
assert.equal(beforeIds.length,41);assert.equal(new Set(beforeIds).size,41);assert.deepEqual([...beforeIds].sort(),initialNodes.map(n=>n.id).sort());
const originalMetadata=initialNodes.find(n=>n.id==='phone-settings').data;
const expectedMetadata={...originalMetadata,title:'合成设置·已校正'};
assert.deepEqual(beforeNodes.find(n=>n.id==='phone-settings').data,{title:'合成设置·已校正'},'This checkpoint must retain the observed title-only metadata defect');
await writeFile(join(output,'before-canvas.json'),JSON.stringify(before.value,null,2)+'\n');
await writeFile(join(output,'metadata-before-evidence.json'),JSON.stringify({source:initialScenePath,sourceSha256:await sha(initialScenePath),originalMetadata,expectedMetadata,allExistingIds:beforeIds},null,2)+'\n');
const {createApp}=await import('../apps/server/src/app/create-app.js');
const {storageRuntime}=await import('../apps/server/src/adapters/storage.js');
const port=Number(process.env.DOCA_QA_PORT??39512),origin=`http://127.0.0.1:${port}`;
const requests:any[]=[],calls=new Map<string,any>();let imageAttempts=0;
const app=await createApp(db,{origin,staticDirectory:join(output,'web'),storage:storageRuntime(),ai:{memory:{driver:'sqlite',url:join(output,'memory.db')},fetch:async(url,init)=>{
 const parsed=new URL(String(url)),record:any={index:requests.length+1,method:init?.method??'GET',host:parsed.host,path:parsed.pathname,at:new Date().toISOString()};requests.push(record);
 if(typeof init?.body==='string'){
  const body=JSON.parse(init.body);for(const message of body.messages??[])if(message.role==='assistant')for(const call of message.tool_calls??[])calls.set(call.id,{id:call.id,name:call.function?.name,arguments:call.function?.arguments});
  await writeFile(join(output,'model-tool-calls.json'),clean(JSON.stringify([...calls.values()],null,2)));
 }
 await writeFile(join(output,'provider-requests.json'),JSON.stringify(requests,null,2));
 try{const response=await fetch(url,init);record.status=response.status;record.requestId=response.headers.get('x-request-id')??response.headers.get('request-id');return response}catch(error){record.error=clean(String(error));throw error}finally{await writeFile(join(output,'provider-requests.json'),JSON.stringify(requests,null,2))}
},imageFetch:async()=>{imageAttempts++;throw Error('Native repair/export prohibits image provider calls')}}});
const modelEntry=fromFileURL(import.meta.resolve('@smartdoca/canvas/model'));
const result:any={syntheticOnly:true,source:input,scope:'One new request only for missing native phone metadata restoration and previously unexecuted PNG delivery; no repeated negative/generation/continue',retained,boardId,sessionId:sourceJob.session_id,allExistingIds:beforeIds.length,expectedMetadata,web:{mode:'immutable production-build copy',indexSha256:await sha(join(output,'web/index.html')),buildCanvasVersion:'0.5.12'},hostCanvas:{installedVersion:JSON.parse(await readFile('node_modules/@smartdoca/canvas/package.json','utf8')).version,modelEntrySha256:await sha(modelEntry)},renderer:{sha256:await sha('apps/server/dist/canvas-render/sdk.js'),buildCanvasVersion:'0.5.12'},productSources:await Promise.all(['packages/core/src/modules/ai/capabilities.ts','apps/server/src/services/ai/runner.ts'].map(async file=>({file,sha256:await sha(file)}))),plannedRequests:1,automaticNewJobRetries:0};
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 await app.listen({host:'127.0.0.1',port});browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1700,height:1100}});
 const api=async(path:string,data?:any)=>{const response=await context.request.fetch(origin+'/api/v1'+path,{method:data===undefined?'GET':'POST',headers:{origin},data});assert(response.ok(),`${path}: ${response.status()} ${clean(await response.text()).slice(0,1000)}`);return response.json()};
 await api('/auth/login',{login:'actualissue',password:'isolated-actual-issue-2026'});
 const errors:string[]=[],outgoing:any[]=[];const watch=(page:any)=>{page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('websocket',(socket:any)=>socket.on('framesent',({payload}:any)=>{try{const frame=JSON.parse(String(payload));if(frame.type==='update')outgoing.push(frame)}catch{}}));};
 const page=await context.newPage();watch(page);await page.goto(`${origin}/#/r/${boardId}?session=${sourceJob.session_id}`);await page.locator('.canvas-host canvas').first().waitFor();await page.screenshot({path:join(output,'before-native-metadata.png')});
 result.id=randomUUID();
 const text=`只补本合成验收尚未完成的事项，不重跑已通过的生成、继续修改或重复ID负例，不调用任何图片生成/修改工具。
1. 修复 phone-settings 被上次 title-only patch 丢掉的原生 metadata，保留它与所有子元素的当前 ID 和当前标题‘合成设置·已校正’。下面是从本轮修改前真实保存场景读取的完整原生 data：${JSON.stringify(originalMetadata)}。这是真实前态证据，不是缺失字段默认值；只将 title 换为已校正标题，其余字段逐字保留。最终 data 必须准确等于 ${JSON.stringify(expectedMetadata)}。不要重建容器、文字或任何其他对象。
2. 回读确认所有既有 ID、手机两张卡片及‘保存更改’按钮和#0f766e底色、Web订单256/收入2560/‘导出报表’、orders的created_at字段与320×240框体、users→orders和books→orders两条1:N关系均保留。原始完整ID清单（包含所有Text/label）：${JSON.stringify(beforeIds)}。
3. 用canvas_view实际检查手机四边、四角、刘海、侧键、Home横条和原生标题；普通Frame不算手机硬件保留。检查Web和关系图整体与细节。
4. 使用canvas_export导出当前全板一份‘合成原生全板.png’，手机、Web、关系图section各一份局部PNG并交付四个真实文件卡片。禁止用image_generate或其他图片模型，禁止拿canvas_view文字回执代替文件。如有原生字体回退警告如实说明。导出不得再写画布。`;
 await writeFile(join(output,'request.txt'),text+'\n');
 await api(`/ai/sessions/${sourceJob.session_id}/messages`,{id:result.id,modelId:sourceJob.model_id,text,scope:'all',currentResourceId:boardId,references:[],attachments:[],webSearch:false,skipApprovals:{create:true,modify:true}});
 let conversation:any,job:any,marker='',reportAt=Date.now();
 for(let n=0;n<1200;n++){
  conversation=await api(`/ai/sessions/${sourceJob.session_id}`);job=conversation.jobs.find((j:any)=>j.id===result.id);const e=job?.progress?.events?.at(-1);const current=`${job?.status}:${e?.code??e?.kind}:${e?.data?.toolName??''}`;
  if(current!==marker){console.log('native repair/export:',current);marker=current;}
  if(Date.now()-reportAt>45000){console.log(`native repair/export: original request only, provider=${requests.length}, image=${imageAttempts}`);reportAt=Date.now();}
  if(job&&!['queued','running'].includes(job.status))break;
  await delay(500);
 }
 result.job={id:job?.id,status:job?.status,error:job?.error,review:job?.progress?.review};
 await writeFile(join(output,'conversation.json'),clean(JSON.stringify(conversation,null,2)));
 assert.equal(job?.status,'completed',`Original repair job stopped: ${job?.status} ${job?.error}; no automatic resubmission`);
 assert.equal(job.progress?.review?.verdict,'pass');
 const after=await readAIDocument(db,{actor},boardId);await writeFile(join(output,'after-canvas.json'),JSON.stringify(after.value,null,2)+'\n');
 const nodes=flatten(after.value);assert.deepEqual(nodes.map(n=>n.id).sort(),[...beforeIds].sort(),'Every one of the 41 original IDs must remain');
 assert.deepEqual(nodes.find(n=>n.id==='phone-settings').data,expectedMetadata);
 const expected=structuredClone(before.value)as any;flatten(expected).find(n=>n.id==='phone-settings').data=expectedMetadata;assert.deepEqual((after.value as any).scene,expected.scene,'Only known phone metadata may change');
 const orders=nodes.find(n=>n.id==='er-orders');assert.equal(orders.width,320);assert.equal(orders.height,240);assert(orders.children.some((n:any)=>n.data?.kind==='node-label'&&n.text==='orders\n───\nid\nuser_id\nbook_id\ncreated_at'));
 const currentCalls=[...calls.values()].filter(call=>job.progress.events.some((e:any)=>e.id===call.id));const edits=currentCalls.filter(call=>call.name==='canvas_edit').flatMap(call=>JSON.parse(call.arguments).operations);
 assert(edits.length>=1&&edits.every((op:any)=>op.type==='patch'&&op.id==='phone-settings'),'Repair must not repeat creation/negative/continue or touch another object');
 assert(!job.progress.events.some((e:any)=>/^image_(generate|edit|recompose|batch|mask)/.test(e.data?.toolName??'')));
 result.native={beforeSeq:before.seq,afterSeq:after.seq,allOriginalIdsRetained:41,metadataExactlyRestored:true,allOtherSceneFieldsUnchanged:true,actualEditOperations:edits};
 const receipts=conversation.operations.filter((op:any)=>op.job_id===result.id).map((op:any)=>op.result).filter((receipt:any)=>receipt.kind==='file_item'&&receipt.mime==='image/png');assert(receipts.length>=4,'Four real native PNG file receipts are required');result.exports=[];
 for(const [i,file]of receipts.entries()){const response=await context.request.get(origin+file.downloadUrl);assert(response.ok());const bytes=await response.body();assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));const filename=`native-export-${i+1}.png`;await writeFile(join(output,filename),bytes);result.exports.push({id:file.id,name:file.name,filename,bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:createHash('sha256').update(bytes).digest('hex')});}
 await page.waitForFunction(()=>{const images=[...document.querySelectorAll<HTMLImageElement>('.ai-file-card-thumb')];return images.length>=4&&images.slice(-4).every(image=>image.naturalWidth>0)});await page.screenshot({path:join(output,'native-export-file-cards.png')});
 const state=await context.storageState();const reopened=await browser.newContext({viewport:{width:1700,height:1100},storageState:{cookies:state.cookies,origins:[]}});const final=await reopened.newPage();watch(final);
 for(const stage of ['reopen','reload']){if(stage==='reopen')await final.goto(`${origin}/#/r/${boardId}`);else await final.reload();const host=final.locator('.canvas-host');await host.locator('canvas').first().waitFor();await final.getByRole('button',{name:'手型工具 (H / Space)',exact:true}).click();await final.getByRole('button',{name:'缩放选项',exact:true}).click();await final.getByRole('menuitem',{name:'适合画布',exact:false}).click();await final.getByRole('button',{name:'选择 (V / 1)',exact:true}).click();await final.mouse.move(25,25);await final.waitForTimeout(800);await final.screenshot({path:join(output,`native-${stage}-fit.png`)});assert.equal((await readAIDocument(db,{actor},boardId)).seq,after.seq);}
 assert.deepEqual(outgoing,[],'Remote metadata render, reopen and fit must not echo native content');assert.deepEqual(errors,[]);assert.equal(imageAttempts,0);
 result.reopen={seq:after.seq,contentWrites:0,outgoingContentFrames:outgoing.length,errors};result.imageProviderAttempts=imageAttempts;result.providerRequests=requests.length;result.result='passed';result.pixelReview='Manual inspection of actual website and exported PNG artifacts is required separately';
}catch(error){result.result='failed';result.error=clean(String(error));result.imageProviderAttempts=imageAttempts;result.providerRequests=requests.length;process.exitCode=1;}
finally{await browser?.close();await app.close();await db.destroy();for(const item of retained){assert.equal(await sha(item.file),item.sha256,'Retained source DB must remain unchanged');}result.retainedDatabasesUnchanged=true;await writeFile(join(output,'results.json'),clean(JSON.stringify(result,null,2))+'\n');console.log('RESULT',output,result.result);}
