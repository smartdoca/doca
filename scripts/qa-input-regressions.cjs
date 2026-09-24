// Run only against the isolated in-memory QA server, never user documents.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1 for the isolated QA server');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const ctx=await browser.newContext({viewport:{width:1600,height:1000}}),origin='http://127.0.0.1:39140';
 const req=async(path,data,method='POST')=>{const r=await ctx.request.fetch(origin+'/api/v1'+path,{method,headers:{origin},data});assert.equal(r.status(),200,await r.text());return r.json()};
 await req('/auth/login',{login:'qatest',password:'qa-password-2026'});
 const doc=await req('/resources',{kind:'document',format:process.env.SHEET?'spreadsheet':'markdown',title:'Isolated input regression',...(!process.env.SHEET?{markdown:'# 标题\n'+('正文测试\n'.repeat(100))}:{})});
 const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(origin+'/#/r/'+doc.id);
 if(process.env.SHEET){
  await p.locator('.uos-editor canvas').first().waitFor();await p.waitForTimeout(1800);
  await p.mouse.click(308,156);await p.keyboard.type('first');await p.keyboard.press('Enter');await p.waitForTimeout(900);
  console.log('AFTER FIRST',await p.getByRole('alert').allTextContents());
  await p.mouse.click(308,156);
  if(!await p.locator('button[data-u-command="doca.comment"]').isVisible()) await p.getByRole('button',{name:'更多',exact:true}).click();
  await p.locator('button[data-u-command="doca.comment"]:visible').click();
  await p.getByLabel('内容评论抽屉').getByLabel('评论内容',{exact:true}).fill('comment');await p.getByLabel('内容评论抽屉').getByLabel('评论内容',{exact:true}).press('Enter');await p.waitForTimeout(800);
  await p.getByLabel('收起内容评论').click();await p.mouse.dblclick(308,156);await p.keyboard.press('Meta+a');await p.keyboard.type('second');await p.keyboard.press('Enter');await p.waitForTimeout(1000);
  console.log('SHEET ALERTS',await p.getByRole('alert').allTextContents(),errors);
 }else{
  const content=p.locator('.cm-content[contenteditable=true]');await content.waitFor();
  const peer=await ctx.newPage();await peer.goto(origin+'/#/r/'+doc.id);await peer.locator('.cm-content[contenteditable=true]').waitFor();await peer.locator('.cm-content').click();await peer.keyboard.press('Meta+Home');await peer.waitForTimeout(250);
  await content.click();await p.keyboard.press('Meta+a');await p.keyboard.press('Backspace');
  const cdp=await ctx.newCDPSession(p);
  await cdp.send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await p.waitForTimeout(100);
  await cdp.send('Input.imeSetComposition',{text:'nihao',selectionStart:5,selectionEnd:5});await p.waitForTimeout(100);
  await cdp.send('Input.insertText',{text:'你好'});await p.waitForTimeout(800);
  const text=await content.evaluate(el=>{const clone=el.cloneNode(true);clone.querySelectorAll('.exmd-remote-caret').forEach(c=>c.remove());return clone.textContent});
  console.log('MD COMPOSITION',text,errors);assert.equal(text.trim(),'你好');
 }
 await p.screenshot({path:'/private/tmp/doca-input-'+(process.env.SHEET?'sheet':'md')+'.png'});
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
