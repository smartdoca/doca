// Actual Doca UI; all accounts, documents, storage and database are disposable.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { createEditor } from 'slate';
import * as Y from 'yjs';
import { CanvasModel } from '@smartdoca/canvas/model';
import { createPresentation, createTextElement, readDocument } from '@smartdoca/slides/core';
import { restoreExlsxDocument, createExlsxCollaborationSession } from '@smartdoca/sheet/yjs';
import { createMarkdownTextAnchor } from '@smartdoca/markdown';
import { openDatabase } from '../packages/db/src/index.js';
import { createUser } from '../packages/core/src/modules/identity/passwords.js';
import { createContent } from '../packages/core/src/workflows/resources.js';
import { restoreDocument } from '../packages/core/src/modules/collaboration/documents.js';
import { restoreSurface } from '../packages/core/src/modules/documents/codecs/surfaces.js';
import { restoreMarkdown } from '../packages/core/src/modules/documents/codecs/markdown.js';
import { encodeMarkdownAnchor } from '../packages/core/src/modules/documents/codecs/markdown-anchor.js';
import { captureRichSelection } from '../apps/web/src/features/comments/rich-selection-anchor.js';
import { captureRuntimeFingerprint } from './qa-runtime-fingerprint.js';
const temporary=await mkdtemp(join(tmpdir(),'doca-comments-v2-'));
const output=resolve(process.env.DOCA_QA_OUTPUT??'artifacts/verification/comments-v2-browser');await mkdir(output,{recursive:true});
const builtWeb=process.env.DOCA_QA_BUILT_WEB==='1';
const port=Number(process.env.DOCA_QA_PORT??39817),origin=`http://127.0.0.1:${port}`;
process.env.DOCA_CREDENTIAL_MASTER_KEY=randomBytes(32).toString('hex');process.env.DOCA_FILE_STORE_ID='local';process.env.DOCA_FILE_STORES_JSON=JSON.stringify({version:1,stores:{local:{provider:'local',root:temporary}}});
const editorPackages=['@smartdoca/canvas','@smartdoca/sheet','@smartdoca/slate','@smartdoca/markdown','@smartdoca/slides'];
const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const packageAudit=async()=>{const pins=JSON.parse(await readFile('package.json','utf8')).dependencies;return Object.fromEntries(await Promise.all(editorPackages.map(async name=>{const directory=resolve('node_modules',name),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));const hash=createHash('sha256');let files=0;const walk=async(relative='')=>{for(const entry of (await readdir(join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='node_modules')continue;const file=join(relative,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()){hash.update(file);hash.update(await readFile(join(directory,file)));files++;}}};await walk();return[name,{version:manifest.version,pin:pins[name],files,sha256:hash.digest('hex')}];})));};
const packages=await packageAudit();
const sourceFiles=['apps/web/src/features/comments/resolved-comments.tsx','packages/i18n/src/catalogs/zh.ts','packages/i18n/src/catalogs/en.ts','apps/web/src/features/comments/rich-comments.tsx','apps/web/src/features/comments/rich-comments.css','apps/web/src/features/comments/region-comments.tsx','apps/web/src/features/comments/comment-layout.tsx','apps/web/src/features/comments/comment-sidebar.tsx','apps/web/src/features/comments/region-comment-interaction.ts','apps/web/src/features/comments/comment-scroll.ts','apps/web/src/features/comments/use-comment-pages.ts','apps/web/src/features/documents/canvas-editor.tsx','apps/web/src/features/documents/surface.css','apps/web/src/features/documents/editor.css','apps/web/src/features/documents/markdown.css','apps/web/src/features/documents/document-page-width.css','apps/web/src/features/documents/document-editor.tsx'];
const sourceAudit=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,await digest(path)])));
const sources=await sourceAudit();
const runtimeFingerprint=await captureRuntimeFingerprint(builtWeb);
let runtimeFingerprintAfter:Awaited<ReturnType<typeof captureRuntimeFingerprint>>|undefined;let fingerprintError:string|undefined;
const receiptScope={scope:'isolated synthetic Doca website only',productionAccepted:false,webMode:builtWeb?'production-build':'development-server',scriptSha256:await digest('scripts/qa-comments-v2-2026-10-22.mts'),fingerprintScriptSha256:await digest('scripts/qa-runtime-fingerprint.ts'),packages,sources,runtimeFingerprint,candidateSheetArtifact:runtimeFingerprint.packages['@smartdoca/sheet'].pin.startsWith('file:'),candidateCanvasArtifact:runtimeFingerprint.packages['@smartdoca/canvas'].pin.startsWith('file:'),...(builtWeb?{builtIndexSha256:await digest('apps/web/dist/index.html')}:{})};
const {createApp}=await import('../apps/server/src/app/create-app.js');const {storageRuntime}=await import('../apps/server/src/adapters/storage.js');
const db=await openDatabase({driver:'sqlite',path:':memory:'});const owner={...await createUser(db,{login:'commentsv2',displayName:'Comments QA',password:'isolated-comments-v2-2026'},{bootstrap:true}),admin:1};
const content=createContent(db);const app=await createApp(db,{origin,...(builtWeb?{staticDirectory:resolve('apps/web/dist')}:{}),storage:storageRuntime(),ai:{memory:{driver:'sqlite',url:':memory:'}}});await app.listen({host:'127.0.0.1',port:builtWeb?port:0});const address=app.server.address();assert(address&&typeof address!=='string');
const web=builtWeb?undefined:await createServer({optimizeDeps:{force:process.env.DOCA_QA_FRESH_DEPS==='1'},plugins:process.env.DOCA_QA_REPRO_KEYBOARD==='1'?[{name:'qa-restore-comment-keyboard-bubbling',enforce:'pre',transform(source,id){if(id.split('?')[0]?.endsWith('/features/comments/rich-comments.tsx'))return source.replace('onKeyDown={event => event.stopPropagation()}','').replace('onKeyUp={event => event.stopPropagation()}','');}}]:[],configFile:resolve('apps/web/vite.config.ts'),cacheDir:resolve('artifacts/verification/comments-v2-vite-cache'+(process.env.DOCA_QA_REPRO_KEYBOARD==='1'?'-red':process.env.DOCA_QA_CANVAS_HOST_ONLY==='1'?'-host-only':'')),server:{host:'127.0.0.1',port,strictPort:true,hmr:false,proxy:{'/api':{target:`http://127.0.0.1:${address.port}`,ws:true}}}});await web?.listen();
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});const context=await browser.newContext({viewport:{width:1600,height:1000},permissions:['clipboard-read','clipboard-write']});
const errors:string[]=[],errorDetails:{format:string;message:string;stack?:string;url:string}[]=[],checks:any[]=[],observed:any[]=[];let current:Page|undefined;
const request=async(path:string,data?:unknown,method='GET')=>{const r=await context.request.fetch(origin+'/api/v1'+path,{method,headers:{origin},data});assert.equal(r.status(),200,await r.text());return r.json();};
const until=async(fn:()=>Promise<boolean>,label:string)=>{for(let n=0;n<200;n++){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);};
const body=(text:string)=>({version:1 as const,blocks:[{type:'paragraph' as const,children:[{type:'text' as const,text}]}]});
const documentState=(id:string)=>db.selectFrom('document_states').select(['seq','checkpoint']).where('resource_id','=',id).executeTakeFirstOrThrow();
const shot=async(p:Page,name:string)=>p.screenshot({path:join(output,name+'.png'),animations:'disabled'});
async function verifyThreadControls(p: Page, resourceId: string, rootId: string, format: string) {
 const panel=p.locator('aside.content-comments');
 const close=panel.getByRole('button',{name:'关闭输入',exact:true});
 if(await close.isVisible())await close.click();
 const thread=panel.locator(`[data-thread-id="${rootId}"]`);
 const spacing=await thread.evaluate(el=>{
  const messages=el.querySelectorAll('.comment-message');
  const body=messages[0]!.querySelector('.rich-comment-body')!.getBoundingClientRect();
  const next=messages[1]!.querySelector('.comment-byline')!.getBoundingClientRect();
  return next.top-body.bottom;
 });
 assert(spacing>=0&&spacing<=16,JSON.stringify({format,replyGap:spacing}));
 const reply=await db.selectFrom('comments').selectAll().where('resource_id','=',resourceId).where('parent_id','=',rootId).where('body','=',`Reply 1 ${format}`).executeTakeFirstOrThrow();
 const message=panel.locator(`[data-comment-id="${reply.id}"]`);
 await message.hover();
 await message.getByRole('button',{name:'删除评论',exact:true}).click();
 const confirmation=p.locator('.ant-popconfirm');
 await confirmation.getByText('确认删除这条评论？',{exact:true}).waitFor();
 assert.equal((await db.selectFrom('comments').select('deleted_at').where('id','=',reply.id).executeTakeFirstOrThrow()).deleted_at,null);
 await until(async()=>confirmation.evaluate(el=>Number(getComputedStyle(el).opacity)>=.99&&
  !/(?:enter|appear)(?:-|\s|$)/.test(el.className)),'delete confirmation animation completed '+format);
 await shot(p,format+'-delete-confirmation');
 await confirmation.getByRole('button',{name:/取\s*消/}).click();
 await confirmation.waitFor({state:'hidden'});
 assert.deepEqual(await db.selectFrom('comments').selectAll().where('id','=',reply.id).executeTakeFirstOrThrow(),reply);
 await message.hover();await message.getByRole('button',{name:'删除评论',exact:true}).click();
 await confirmation.getByText('确认删除这条评论？',{exact:true}).waitFor();
 await p.keyboard.press('Escape');await confirmation.waitFor({state:'hidden'});
 assert(await panel.isVisible(),'Escape cancels the bubble without closing comments');
 assert.deepEqual(await db.selectFrom('comments').selectAll().where('id','=',reply.id).executeTakeFirstOrThrow(),reply);
 await message.hover();await message.getByRole('button',{name:'删除评论',exact:true}).click();
 await confirmation.getByRole('button',{name:/删\s*除/}).click();
 await until(async()=>!!(await db.selectFrom('comments').select('deleted_at').where('id','=',reply.id).executeTakeFirstOrThrow()).deleted_at,'confirmed deletion '+format);
 await message.getByText('评论已删除',{exact:true}).waitFor();
 const rootMessage=panel.locator(`[data-comment-id="${rootId}"]`);
 await rootMessage.hover();await rootMessage.getByRole('button',{name:'解决评论',exact:true}).click();
 await thread.waitFor({state:'hidden'});
 assert.equal((await db.selectFrom('comments').select('resolved').where('id','=',rootId).executeTakeFirstOrThrow()).resolved,1);
 await panel.getByRole('button',{name:'已解决的评论',exact:true}).click();
 const dialog=p.getByRole('dialog',{name:'已解决的评论',exact:true});
 const resolved=dialog.locator(`[data-thread-id="${rootId}"]`);
 await resolved.getByText('Existing '+format+' thread',{exact:true}).waitFor();
 await resolved.getByText('Reply 22 '+format,{exact:true}).waitFor({state:'attached'});
 await until(async()=>dialog.evaluate(el=>{
  const root=el.closest('.ant-modal-root');
  return !!root&&Array.from(root.querySelectorAll<HTMLElement>('.ant-modal,.ant-modal-mask')).every(node=>
   Number(getComputedStyle(node).opacity)>=.99&&!/(?:enter|appear)(?:-|\s|$)/.test(node.className));
 }),'resolved dialog animation completed '+format);
 await shot(p,format+'-resolved-history');
 await p.setViewportSize({width:390,height:1000});
 const dialogBox=await dialog.boundingBox();
 assert(dialogBox&&dialogBox.x>=0&&dialogBox.x+dialogBox.width<=390,JSON.stringify({format,dialogBox}));
 await shot(p,format+'-resolved-history-390');
 await p.setViewportSize({width:1600,height:1000});
 let failRestore=true;
 const path=`**/api/v1/resources/${resourceId}/comments/${rootId}`;
 await p.route(path,async route=>{
  if(failRestore&&route.request().method()==='PATCH'&&route.request().postDataJSON().resolved===false){
   failRestore=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Restore temporarily unavailable'})});
  }else await route.continue();
 });
 await resolved.getByRole('button',{name:'恢复为未解决',exact:true}).click();
 await p.getByRole('alert').filter({hasText:'Restore temporarily unavailable'}).waitFor();
 assert.equal((await db.selectFrom('comments').select('resolved').where('id','=',rootId).executeTakeFirstOrThrow()).resolved,1);
 await resolved.getByRole('button',{name:'恢复为未解决',exact:true}).click();
 await resolved.waitFor({state:'hidden'});
 await dialog.getByText('暂无已解决的评论',{exact:true}).waitFor();
 assert.equal((await db.selectFrom('comments').select('resolved').where('id','=',rootId).executeTakeFirstOrThrow()).resolved,0);
 await p.unroute(path);
 await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await thread.waitFor();
 await shot(p,format+'-restored-thread');
}
try{
 await request('/auth/login',{login:'commentsv2',password:'isolated-comments-v2-2026'},'POST');
 for(const format of (process.env.DOCA_QA_FORMATS??'canvas,spreadsheet,presentation,markdown,rich_text').split(',')){
  let initialContent:any,markdown:string|undefined;
  if(format==='rich_text')initialContent={schemaVersion:2,children:[{id:'comment-title',type:'paragraph',children:[{text:'Synthetic comments title'}]},...Array.from({length:35},(_,i)=>({id:'p-'+i,type:'paragraph',children:[{text:`Synthetic paragraph ${i+1} for keyboard and comments.`}]}))]};
  if(format==='spreadsheet')initialContent={id:'fixture-workbook',name:'Comment workbook',appVersion:'0.25.1',locale:'zhCN',styles:{},sheetOrder:['qa-sheet'],sheets:{'qa-sheet':{id:'qa-sheet',name:'Sheet1',rowCount:50,columnCount:10,defaultRowHeight:19.8,defaultColumnWidth:79.2,cellData:{0:{0:{v:'Must preserve this cell'}}}}}};
  if(format==='canvas')initialContent={version:1,scene:{children:[{id:'qa-comment-rect',tag:'Rect',x:280,y:180,width:240,height:160,fill:'#c8dfff',stroke:'#5576b1'}]}};
  if(format==='presentation'){initialContent=createPresentation();const s=initialContent.slides[initialContent.slideOrder[0]];s.elements={};s.elementOrder=[];const el=createTextElement('Synthetic text to preserve');s.elements[el.id]=el;s.elementOrder.push(el.id);}
  if(format==='markdown')markdown='# Synthetic comments\n\n'+Array.from({length:35},(_,i)=>`Paragraph ${i+1} for keyboard and comment testing.\n\n`).join('');
  const doc=await content.create(owner,{kind:'document',format:format as any,title:'Comments '+format,...(initialContent?{initialContent}:{}),...(markdown?{markdown}:{})});
  let anchor:any;
  if(format==='rich_text'){const loaded=await restoreDocument(db,doc.id);try{const editor=createEditor();editor.children=loaded.runtime.getValue();anchor=captureRichSelection(editor,loaded.runtime,{anchor:{path:[1,0],offset:0},focus:{path:[1,0],offset:9}});}finally{loaded.destroy();}}
  else if(format==='markdown'){const loaded=await restoreMarkdown(db,doc.id);try{anchor=encodeMarkdownAnchor(createMarkdownTextAnchor(loaded.doc.getText('markdown'),25,34),loaded.epochId,'Paragraph');}finally{loaded.destroy();}}
  else{const loaded=await restoreSurface(db,doc.id,format);if(format==='canvas'){const model=CanvasModel.restore({codec:'aidcanvas-yjs',schemaVersion:1,epochId:loaded.epochId,update:loaded.update});try{anchor=model.captureAnchor(['qa-comment-rect']);}finally{model.dispose();}}
   if(format==='spreadsheet'){const model=await restoreExlsxDocument({baseline:loaded.baseline!,update:loaded.update,checkpointSeq:0});const session=await createExlsxCollaborationSession({doc:model,baseline:loaded.baseline!,sessionId:'qa-capture'});try{anchor=session.captureCellAnchor!({sheetId:loaded.baseline!.snapshot.sheetOrder[0]!,startRow:0,endRow:0,startColumn:0,endColumn:0});}finally{session.dispose();model.destroy();}}
   if(format==='presentation'){const model=new Y.Doc();try{Y.applyUpdate(model,loaded.update);const value=readDocument(model),slideId=value.slideOrder[0]!;anchor={type:'elements',epochId:loaded.epochId,slideId,elementIds:[value.slides[slideId]!.elementOrder.at(-1)!]};}finally{model.destroy();}}
  }
  assert(anchor,format+' fixture anchor');
  if(format==='canvas')for(let i=0;i<205;i++)await content.comment(owner,doc.id,body('Earlier anchored comment '+i),null,JSON.stringify(anchor));
  const root=await content.comment(owner,doc.id,body('Existing '+format+' thread'),null,JSON.stringify(anchor));
  for(let i=0;i<22;i++)await content.comment(owner,doc.id,body('Reply '+(i+1)+' '+format),root.id);
  const p=await context.newPage();current=p;p.setDefaultTimeout(25000);p.on('pageerror',e=>{errors.push(e.message);const detail={format,message:e.message,stack:e.stack,url:p.url()};errorDetails.push(detail);console.error('BROWSER ERROR '+JSON.stringify(detail));});const updates:any[]=[];p.on('websocket',s=>s.on('framesent',({payload})=>{try{const v=JSON.parse(String(payload));if(v.type==='update')updates.push(v);}catch{}}));
  await p.goto(origin+'/#/r/'+doc.id);await p.locator(format==='rich_text'?'.sk-editable':format==='markdown'?'.cm-content':format==='canvas'?'.canvas-host':format==='spreadsheet'?'.uos-editor__select-all':'.eppt-workspace').waitFor();
  await p.getByText(/(?:^| · |：|:)已保存到云端$/).last().waitFor({state:'attached'});
  const baseline=await documentState(doc.id);const nativeSelector=format==='canvas'?'.canvas-app':format==='spreadsheet'?'.uos-editor':format==='presentation'?'.eppt-workspace':format==='markdown'?'.cm-editor':'.sk-editable';const nativeIdentity=await p.locator(nativeSelector).first().evaluateHandle(el=>el);observed.push({p,id:doc.id,baseline,updates,nativeIdentity,nativeSelector});
  // Region annotations follow the drawer, including comments after page 200.
  if(['canvas','spreadsheet','presentation'].includes(format)){
   assert.equal(await p.locator('.region-comment-controls button').count(),1,'only the comment button remains');
   assert.equal(await p.locator('.anchor-decoration-marker,.eppt-comment-marker').count(),0,'annotations are hidden initially');
   assert.equal(await p.locator('.region-comments-drawer').count(),0);
   await p.getByRole('button',{name:'展开内容评论',exact:true}).click();
   if(format==='canvas'){
    await p.locator(`[data-anchor-id="${root.id}"] .anchor-decoration-marker`).waitFor();
    const box=await p.locator('.anchor-decoration-box').first().boundingBox();assert(box);await p.mouse.click(box.x+box.width/2,box.y+box.height/2);
   }
   if(format==='presentation')await p.locator('.eppt-comment-marker').waitFor();
   const markerPixels=async()=>{const image=(await import('sharp')).default(await p.locator('.uos-editor').screenshot({animations:'disabled'}));const {data}=await image.ensureAlpha().raw().toBuffer({resolveWithObject:true});let pixels=0;for(let i=0;i<data.length;i+=4)if(data[i]===242&&data[i+1]===201&&data[i+2]===76)pixels++;return pixels;};
   let shown=0;if(format==='spreadsheet')await until(async()=>(shown=await markerPixels())>=10,'Sheet markers shown with comments');
   await shot(p,format+'-marks-with-drawer');
   await p.getByRole('button',{name:'收起内容评论',exact:true}).click();
   await until(async()=>await p.locator('.anchor-decoration-marker,.eppt-comment-marker').count()===0,'annotations hidden with drawer');
   if(format==='spreadsheet')await until(async()=>(await markerPixels())<=shown-10,'Sheet markers hidden with drawer');
   await shot(p,format+'-marks-hidden');
  }
  if(format==='spreadsheet'){const nameBox=p.locator('.uos-editor').getByRole('textbox',{exact:true});await nameBox.fill('A1');await nameBox.press('Enter');}
  if(format==='presentation'){const text=await p.locator('.eppt-main').getByText('Synthetic text to preserve',{exact:true}).boundingBox();assert(text);await p.mouse.click(text.x+text.width/2,text.y+text.height/2);await p.locator('.ppt-comment-action').waitFor();}
  if(format==='markdown'){await p.locator('.cm-content').click();await p.keyboard.press('ControlOrMeta+a');}
  if(format==='rich_text'){await p.locator('.sk-editable').click();await p.keyboard.press('ControlOrMeta+a');}
  if(format==='rich_text'){const open=p.getByRole('button',{name:'展开内容评论',exact:true});if(await open.isVisible())await open.click();}
  else await p.getByRole('button',{name:'展开内容评论',exact:true}).click();
  const panel=p.locator('aside.content-comments');await panel.waitFor();await panel.getByText('Reply 22 '+format,{exact:true}).waitFor({state:'attached'});
  const last=panel.locator(`[data-thread-id="${root.id}"] .comment-message`).last();await panel.evaluate(el=>{el.scrollTop=el.scrollHeight;});await last.hover();await last.getByRole('button',{name:'回复',exact:true}).click();const input=panel.getByRole('textbox',{name:'评论内容',exact:true});await input.waitFor();
  await until(async()=>input.evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('aside')!.getBoundingClientRect();const viewport=document.querySelector('.ai-document-main .main-scroll')!.getBoundingClientRect();return r.top>=Math.max(panel.top+42,viewport.top+42)&&r.bottom<=Math.min(panel.bottom,viewport.bottom);}),'new input visible '+format);
  const keyboardVerified=!(format==='canvas'&&process.env.DOCA_QA_CANVAS_HOST_ONLY==='1');if(keyboardVerified){await input.fill('Keyboard draft');await input.press('ArrowLeft');await input.press('ArrowRight');await input.press('Home');await input.press('End');await input.press('Backspace');await input.press('Delete');await input.press('ControlOrMeta+a');await input.press('Backspace');await input.press('ControlOrMeta+z');await input.press('ControlOrMeta+Shift+z');}await input.fill('Preserved draft '+format);
  if(keyboardVerified){const clipboardDraft='Clipboard draft '+format;await input.fill(clipboardDraft);await input.press('ControlOrMeta+a');await input.press('ControlOrMeta+c');await input.press('ControlOrMeta+x');assert.equal(await input.inputValue(),'','cut affects only comment text');await input.press('ControlOrMeta+v');assert.equal(await input.inputValue(),clipboardDraft,'native comment clipboard works');await input.fill('Preserved draft '+format);}
  await delay(250);assert.deepEqual(await documentState(doc.id),baseline);assert.equal(updates.length,0);if(format==='canvas')assert(await p.locator('.canvas-comment-icon').isVisible(),'Canvas selection remains owned while commenting');
  await shot(p,format+'-composer-keyboard');
  const header=panel.locator(':scope > header');const h1=await header.boundingBox();await panel.evaluate(el=>{el.scrollTop=el.scrollHeight;});await delay(100);const h2=await header.boundingBox();const viewportTop=await panel.evaluate(el=>document.querySelector('.ai-document-main .main-scroll')!.getBoundingClientRect().top);assert(h1&&h2&&h1.y>=viewportTop-1&&h2.y>=viewportTop-1&&Math.abs(h1.y-h2.y)<2,JSON.stringify({h1,h2,viewportTop}));
  if(format==='canvas'){
   await input.scrollIntoViewIfNeeded();await panel.getByRole('button',{name:'添加图片',exact:true}).click();await p.getByRole('dialog',{name:'添加图片',exact:true}).waitFor();await shot(p,'canvas-upload-source');
   await p.getByRole('dialog',{name:'添加图片',exact:true}).getByRole('button',{name:/本地上传/}).click();assert(await input.isVisible(),'portalled picker keeps original composer');
   const png=await (await import('sharp')).default({create:{width:130,height:80,channels:4,background:'#b4a6e9'}}).png().toBuffer();let release=()=>{};const gate=new Promise<void>(r=>release=r);let held=false;
   await p.route('**/api/v1/assets?purpose=comment_image*',async route=>{held=true;await gate;await route.continue();});
   await panel.locator('input[type=file]').setInputFiles({name:'synthetic-comment.png',mimeType:'image/png',buffer:png});await until(async()=>held,'upload held');await panel.getByRole('status').filter({hasText:'上传中'}).waitFor();assert(await input.isDisabled());await shot(p,'canvas-upload-pending');release();await panel.locator('.comment-image-drafts img').waitFor();await until(async()=>input.isEnabled(),'upload finished');
   const preview=panel.locator('.comment-image-drafts img');assert(await preview.evaluate(el=>(el as HTMLImageElement).naturalWidth>0));await shot(p,'canvas-upload-draft');await p.unroute('**/api/v1/assets?purpose=comment_image*');
   let refreshRelease=()=>{};const refreshGate=new Promise<void>(r=>refreshRelease=r);let refreshHeld=false;await p.route(`**/api/v1/resources/${doc.id}`,async route=>{if(route.request().method()==='GET'){refreshHeld=true;await refreshGate;}await route.continue();});
   let sendRelease=()=>{};const sendGate=new Promise<void>(r=>sendRelease=r);let sendHeld=false;await p.route(`**/api/v1/resources/${doc.id}/comments`,async route=>{if(route.request().method()==='POST'){sendHeld=true;await sendGate;}await route.continue();});
   await panel.getByRole('button',{name:'发送评论',exact:true}).click();await until(async()=>sendHeld,'send held');await panel.getByRole('status').filter({hasText:'发送中'}).waitFor();assert(await panel.getByRole('button',{name:'发送评论',exact:true}).isDisabled());await shot(p,'canvas-send-pending');sendRelease();await until(async()=>refreshHeld,'comment refresh held');await panel.locator('.comment-publication-status').waitFor();const sendingBox=await panel.locator('.comment-publication-status').boundingBox(),panelBox=await panel.boundingBox();assert(sendingBox&&panelBox&&sendingBox.y>=panelBox.y&&sendingBox.y+sendingBox.height<=panelBox.y+panelBox.height,'send feedback remains in the visible drawer during refresh');await shot(p,'canvas-send-refresh-pending');refreshRelease();await p.unroute(`**/api/v1/resources/${doc.id}`);await until(async()=>!(await panel.locator('.rich-comment-composer').count()),'sent');await until(async()=>await panel.locator('.comment-publication-status').count()===0,'send feedback ends after refreshed message');await panel.locator('.rich-comment-body img').last().waitFor();assert(await panel.locator('.rich-comment-body img').last().evaluate(el=>(el as HTMLImageElement).naturalWidth>0));await shot(p,'canvas-image-comment-sent');
   await panel.evaluate(el=>{el.scrollTop=0;});const selectedBox=await p.locator('.anchor-decoration-box').first().boundingBox();assert(selectedBox);await p.mouse.click(selectedBox.x+selectedBox.width/2,selectedBox.y+selectedBox.height/2);await p.getByRole('button',{name:'评论选中区域',exact:true}).click();const draftInput=panel.getByRole('textbox',{name:'评论内容',exact:true});await draftInput.waitFor();await until(async()=>draftInput.evaluate(el=>{const r=el.getBoundingClientRect(),port=el.closest('aside')!.getBoundingClientRect();const viewport=document.querySelector('.ai-document-main .main-scroll')!.getBoundingClientRect();return r.top>=Math.max(port.top+42,viewport.top+42)&&r.bottom<=Math.min(port.bottom,viewport.bottom);}),'toolbar new comment revealed');await draftInput.fill('Keep after rejected upload');
   await panel.locator('input[type=file]').setInputFiles({name:'not-an-image.png',mimeType:'image/png',buffer:Buffer.from('not image data')});await p.getByRole('alert').waitFor();assert.equal(await draftInput.inputValue(),'Keep after rejected upload');assert.equal(await panel.locator('.comment-image-drafts img').count(),0);assert(await draftInput.isEnabled());await shot(p,'canvas-upload-rejected-draft-preserved');await p.getByRole('button',{name:'关闭提示',exact:true}).click();
   const fileResponse=await context.request.post(origin+'/api/v1/files/items?filename=from-doca.png',{headers:{origin,'Content-Type':'application/octet-stream'},data:png});assert.equal(fileResponse.status(),200,await fileResponse.text());
   await panel.getByRole('button',{name:'添加图片',exact:true}).click();await p.getByRole('dialog',{name:'添加图片',exact:true}).getByRole('button',{name:/Doca 文件/}).click();const picker=p.locator('.folder-file-picker');await picker.waitFor();await picker.getByText('from-doca.png',{exact:true}).click();await picker.getByRole('button',{name:'选择',exact:true}).click();await picker.waitFor({state:'hidden'});await panel.locator('.comment-image-drafts img').waitFor();assert.equal(await draftInput.inputValue(),'Keep after rejected upload');assert(await panel.locator('.comment-image-drafts img').evaluate(el=>(el as HTMLImageElement).naturalWidth>0));await shot(p,'canvas-doca-file-image-draft');await panel.getByRole('button',{name:'关闭输入',exact:true}).click();

  }
  for(const width of [1600,760,390]){await p.setViewportSize({width,height:1000});await delay(300);if(format==='rich_text'){const open=p.getByRole('button',{name:'展开内容评论',exact:true});if(await open.isVisible())await open.click();await panel.waitFor();}const geometry=await panel.evaluate(el=>{const r=el.getBoundingClientRect(),surface=el.closest('.surface-editor')??document.querySelector('.ai-document-main .main-scroll .surface-editor'),native=surface?.querySelector('.doca-canvas,.uos-editor,.eppt-workspace,.markdown-sdk-container')??el.closest('.editor-columns')?.querySelector('.editor-content');return{panel:r.toJSON(),native:native?.getBoundingClientRect().toJSON()};});assert(geometry.panel.left>=0&&geometry.panel.right<=width+1,JSON.stringify({format,width,geometry}));if(geometry.native)assert(geometry.native.right<=geometry.panel.left+1,JSON.stringify({format,width,geometry}));const headerControls=await panel.locator(':scope > header button').evaluateAll(elements=>elements.map(el=>({rect:el.getBoundingClientRect().toJSON(),label:el.getAttribute('aria-label')})));assert(headerControls.every(({rect})=>rect.left>=geometry.panel.left&&rect.right<=geometry.panel.right+1),JSON.stringify({format,width,headerControls,panel:geometry.panel}));const aiTrigger=p.getByRole('button',{name:'AI 辅助创作',exact:true});assert(await aiTrigger.isVisible(),'AI entrance must remain visible');const aiBounds=await aiTrigger.boundingBox();if(format==='rich_text'){
   const layout=await p.locator('.ai-document-layout').boundingBox();
   const scrollBounds=await p.locator('.document-scroll-buttons').boundingBox();
   assert(layout&&aiBounds&&scrollBounds,'rich-text floating controls are visible');
   const right=layout.x+layout.width;
   for(const bounds of [aiBounds,scrollBounds])assert(Math.abs(right-bounds.x-bounds.width-22)<=1,JSON.stringify({format,width,bounds,layout}));
  }else assert(aiBounds&&aiBounds.x>=0&&aiBounds.x+aiBounds.width<=geometry.panel.left+1,JSON.stringify({format,width,aiBounds,panel:geometry.panel}));await shot(p,format+'-'+width+'-sidebar');}
  await p.setViewportSize({width:1600,height:1000});await delay(250);const draftBeforeAI=await panel.locator('textarea').inputValue().catch(()=>null);await p.getByRole('button',{name:'AI 辅助创作',exact:true}).click();await p.locator('.ai-document-panel').waitFor();await p.locator('.ai-document-panel .ai-chat').waitFor({timeout:60000});await panel.waitFor();await until(async()=>p.evaluate(()=>{const comments=document.querySelector('aside.content-comments')?.getBoundingClientRect(),ai=document.querySelector('.ai-document-panel')?.getBoundingClientRect();return !!comments&&!!ai&&comments.right<=ai.left+1&&ai.left-comments.right<=24&&comments.left>=0;}),'AI and comments occupy separate columns '+format);if(draftBeforeAI!==null)assert.equal(await panel.locator('textarea').inputValue(),draftBeforeAI,'opening AI preserves comment draft');await shot(p,format+'-ai-and-comments');
  await verifyThreadControls(p,doc.id,root.id,format);
  assert.deepEqual(await documentState(doc.id),baseline);assert.equal(updates.length,0);checks.push({format,result:keyboardVerified?'passed':'partial',keyboardVerified,keyboardWrites:0,threadControls:true,commentRows:format==='canvas'?229:23,paginationBeforeDrawer:format==='canvas'});console.log(keyboardVerified?'PASS':'PARTIAL (host-only; known SDK keyboard failure remains)',format);
 }
 console.log(`Waiting 61 seconds for ${observed.length} mounted editors: no content writes`);const idleStart=Date.now();await delay(61000);for(const observedPage of observed){assert.deepEqual(await documentState(observedPage.id),observedPage.baseline);assert.equal(observedPage.updates.length,0);assert(await observedPage.nativeIdentity.evaluate((el:any,selector:string)=>el.isConnected&&el===document.querySelector(selector),observedPage.nativeSelector),'editor was remounted');}const idle={milliseconds:Date.now()-idleStart,clients:observed.length,contentWrites:0};const mobileTarget=observed.find(item=>item.nativeSelector==='.cm-editor')??observed[0];await mobileTarget.p.setViewportSize({width:390,height:900});await mobileTarget.p.goto(origin+'/#/m/r/'+mobileTarget.id);await mobileTarget.p.locator('html[data-editor-shell=mobile]').waitFor({state:'attached'});const mobileViewport=await mobileTarget.p.locator('.main-scroll').evaluate(el=>({width:el.getBoundingClientRect().width,viewport:innerWidth}));assert(mobileViewport.width>=mobileViewport.viewport-20,JSON.stringify(mobileViewport));assert.deepEqual(await documentState(mobileTarget.id),mobileTarget.baseline);checks.push({result:'passed',scope:'embedded mobile shell retains full document width while comments are hidden',mobileViewport});assert.deepEqual(await packageAudit(),packages,'installed package files changed during QA');assert.deepEqual(await sourceAudit(),sources,'comment source files changed during QA');
 runtimeFingerprintAfter=await captureRuntimeFingerprint(builtWeb);assert.deepEqual(runtimeFingerprintAfter,runtimeFingerprint,'packages, full Web build or lockfile changed during comments QA');assert.deepEqual(errors,[]);await writeFile(join(output,'results.json'),JSON.stringify({...receiptScope,runtimeFingerprintAfter,checks,errors,errorDetails,idle},null,2));
}catch(e){console.error(e);if(!runtimeFingerprintAfter)runtimeFingerprintAfter=await captureRuntimeFingerprint(builtWeb).catch(failure=>{fingerprintError=String(failure);return undefined;});if(current&&!current.isClosed()){await writeFile(join(output,'failure-geometry.json'),JSON.stringify(await current.evaluate(()=>Array.from(document.querySelectorAll('.main-scroll,.surface-editor,.eppt-workspace,.content-comments,.rich-comment-composer,.rich-comment-composer textarea,.markdown-document')).map(el=>({tag:el.className,rect:el.getBoundingClientRect().toJSON(),scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow:getComputedStyle(el).overflowY,boxSizing:getComputedStyle(el).boxSizing,cssTop:getComputedStyle(el).top,position:getComputedStyle(el).position,margin:getComputedStyle(el).margin,transform:getComputedStyle(el).transform}))),null,2)).catch(()=>{});await shot(current,'failure').catch(()=>{});await writeFile(join(output,'failure.html'),await current.content()).catch(()=>{});}await writeFile(join(output,'results.json'),JSON.stringify({...receiptScope,runtimeFingerprintAfter,fingerprintError,checks,errors,errorDetails,failure:String(e),failureStack:e instanceof Error?e.stack:undefined},null,2));process.exitCode=1;}
finally{await browser.close();await web?.close();await app.close();await db.destroy();await rm(temporary,{recursive:true,force:true});}
