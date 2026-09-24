// Isolated browser regression for composer request cards; never pass a production origin.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Isolated QA only');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const port = process.env.DOCA_QA_PORT || '39257'; if (!['39257'].includes(port)) throw Error('Unknown QA port');
const origin = 'http://127.0.0.1:'+port;
(async () => {
 const browser = await chromium.launch({channel:'chrome',headless:true});
 try {
  const ctx = await browser.newContext({viewport:{width:1600,height:1000}});
  const request = async(path,data,method='GET') => { const r = await ctx.request.fetch(origin+'/api/v1'+path,{method,headers:{origin},data}); assert.equal(r.status(),200,await r.text()); return r.json(); };
  await request('/auth/login',{login:'aiqa',password:'isolated-ai-qa-2026'},'POST');
  const docs = (await request('/resources')).items.filter(r=>r.kind==='document');
  assert.ok(docs.length>=2,'fixture documents missing');
  const page=await ctx.newPage(), errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  const composerCard = page.locator('.ai-composer-requests');
  const sender = page.locator('.ai-composer .ant-sender');
  const aboveSender = async (locator) => {
    const card = await locator.boundingBox(), box = await sender.boundingBox();
    assert.ok(card && box,'card or sender not visible');
    assert.ok(card.y+card.height<=box.y+2,`card bottom ${card.y+card.height} must be above sender top ${box.y}`);
    assert.equal(await page.evaluate(el=>getComputedStyle(el).animationName,(await locator.elementHandle())),'ai-composer-request-in');
  };
  const assertDomOrder = async (a, b, msg) => {
    const ha = await a.elementHandle(), hb = await b.elementHandle();
    assert.ok(ha && hb, msg+' (element missing)');
    const rel = await ha.evaluate((x,y)=>x.compareDocumentPosition(y), hb);
    assert.ok(rel & 4, msg);
  };
  // Scenario 1: approval card flips out above the composer, decision lands in the flow.
  await page.goto(origin+'/#/ai');
  const input = page.locator('.ai-composer [contenteditable="true"]');
  await input.waitFor();
  await input.click(); await input.fill('创建项目计划');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const approvalCard = page.locator('.ai-composer-requests .ai-approval-card');
  await approvalCard.waitFor();
  await page.waitForTimeout(400);
  await aboveSender(approvalCard);
  assert.equal(await page.locator('.ai-bubble-list .ai-approval-card').count(),0,'approval card must leave the message flow');
  await approvalCard.getByText('创建「AI 创建的项目计划」', {exact:false}).waitFor();
  await approvalCard.getByRole('button',{name:'批准并继续',exact:true}).click();
  await approvalCard.waitFor({state:'detached'});
  const decision = page.locator('.ai-bubble-list .ai-approval-result').filter({hasText:'已批准'});
  await decision.waitFor();
  await decision.getByText('创建「AI 创建的项目计划」',{exact:false}).waitFor();
  await page.screenshot({path:'/tmp/doca-qa-approval-card.png'});
  console.log('PASS approval: card above composer, approve hides it and records 已批准 in the flow');
  // Scenario 1b: rejection follows the same contract.
  await page.getByRole('button',{name:'发送',exact:true}).waitFor();
  await input.click(); await input.fill('创建项目计划');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const rejectCard = page.locator('.ai-composer-requests .ai-approval-card');
  await rejectCard.waitFor();
  await rejectCard.getByRole('button',{name:/拒\s*绝/}).click();
  await rejectCard.waitFor({state:'detached'});
  await page.locator('.ai-bubble-list .ai-approval-result').filter({hasText:'已拒绝'}).waitFor();
  console.log('PASS approval: reject hides the card and records 已拒绝 in the flow');
  // Scenario 2: choice card flips out above the composer, answer lands as a user message.
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await input.click(); await input.fill('请做选择');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const choiceCard = page.locator('.ai-composer-requests .ai-choice-card');
  await choiceCard.waitFor();
  await page.waitForTimeout(400);
  await aboveSender(choiceCard);
  assert.equal(await page.locator('.ai-bubble-list .ai-choice-card').count(),0,'choice card must leave the message flow');
  await choiceCard.getByRole('radio',{name:'开发团队',exact:true}).check();
  await choiceCard.getByRole('button',{name:'确认并继续',exact:true}).click();
  await choiceCard.waitFor({state:'detached'});
  const answer = page.locator('.ai-user-bubble').last();
  await answer.getByText('我的选择：开发团队',{exact:false}).waitFor();
  await page.screenshot({path:'/tmp/doca-qa-choice-card.png'});
  console.log('PASS choice: card above composer, answer hides it and shows 我的选择 in the flow');
  // Scenario 3: single linked document in the full-page header jumps directly, no popover.
  const single = await request('/ai/sessions',{modelId:'mock',resourceIds:[docs[0].id]},'POST');
  await page.goto(origin+'/#/ai?session='+single.id);
  const linked = page.getByRole('button',{name:'关联文档',exact:true});
  await linked.waitFor();
  assert.match(await linked.innerText(), new RegExp(docs[0].title));
  await linked.click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.ant-popover:visible').count(),0,'single document must not open a dropdown');
  assert.ok(page.url().includes('/r/'+docs[0].id),'single document must open directly: '+page.url());
  await page.screenshot({path:'/tmp/doca-qa-single-reference.png'});
  console.log('PASS header: one linked document opens directly without dropdown');
  // Scenario 3b: two linked documents keep the dropdown.
  const pair = await request('/ai/sessions',{modelId:'mock',resourceIds:[docs[0].id,docs[1].id]},'POST');
  await page.goto(origin+'/#/ai?session='+pair.id);
  const linkedPair = page.getByRole('button',{name:'关联文档',exact:true});
  await linkedPair.waitFor();
  assert.match(await linkedPair.innerText(), /关联文档 2/);
  await linkedPair.click();
  const popover = page.locator('.ant-popover:visible');
  await popover.waitFor();
  assert.equal(await popover.getByRole('button').count(),2,'dropdown must list both documents');
  assert.ok(!page.url().includes('/r/'),'dropdown must not navigate');
  console.log('PASS header: two linked documents keep the dropdown');
  // Scenario 4: batch management entry sits above the session list.
  await page.goto(origin+'/#/ai');
  if (!(await page.locator('.ai-session-list').isVisible().catch(()=>false)))
    await page.getByRole('button',{name:'会话列表',exact:true}).click();
  const tools = page.locator('.ai-session-list .ai-session-tools');
  await tools.waitFor();
  const toolsBox = await tools.boundingBox(), listBox = await page.locator('.ai-session-list .ant-conversations').boundingBox();
  assert.ok(toolsBox && listBox,'tools or list not visible');
  assert.ok(toolsBox.y+toolsBox.height<=listBox.y+2,`tools bottom ${toolsBox.y+toolsBox.height} must be above list top ${listBox.y}`);
  await tools.getByRole('button',{name:'批量管理',exact:true}).click();
  await page.locator('.ai-session-check').first().waitFor();
  await page.locator('.ai-selection-bar').waitFor();
  await page.getByRole('button',{name:'全选',exact:true}).click();
  await page.locator('.ai-selection-bar').getByText(/已选择 [1-9]/).waitFor();
  await page.screenshot({path:'/tmp/doca-qa-batch-tools.png'});
  console.log('PASS sessions: 批量管理 entry above the list and batch mode works');
  // Scenario 5: same approval contract inside the embedded document panel.
  await page.goto(origin+'/#/r/'+docs[0].id);
  await page.reload();
  await page.waitForTimeout(800);
  const panelInput = page.locator('.ai-document-panel .ai-composer [contenteditable="true"]');
  if (!(await panelInput.isVisible().catch(()=>false))) {
    await page.locator('.ai-document-trigger').waitFor();
    await page.locator('.ai-document-trigger').click();
  }
  await panelInput.waitFor();
  await panelInput.click(); await panelInput.fill('创建项目计划');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const panelCard = page.locator('.ai-document-panel .ai-composer-requests .ai-approval-card');
  await panelCard.waitFor();
  await page.waitForTimeout(400);
  const panelBox = await panelCard.boundingBox(), panelSender = await page.locator('.ai-document-panel .ai-composer .ant-sender').boundingBox();
  assert.ok(panelBox && panelSender && panelBox.y+panelBox.height<=panelSender.y+2,'panel card must sit above the input');
  await panelCard.getByRole('button',{name:'批准并继续',exact:true}).click();
  await panelCard.waitFor({state:'detached'});
  await page.locator('.ai-document-panel .ai-approval-result').filter({hasText:'已批准'}).first().waitFor();
  await page.screenshot({path:'/tmp/doca-qa-panel-approval.png'});
  console.log('PASS panel: approval card above embedded composer, decision recorded in flow');
  assert.deepEqual(errors,[]);
  console.log('PASS no browser errors');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
