// Run only against the isolated in-memory QA server, never user documents.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1 for the isolated QA server');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const origin = 'http://127.0.0.1:39140';
    const req = async (path, data, method = 'POST') => {
      const r = await ctx.request.fetch(origin + '/api/v1' + path, { method, headers: { origin }, data });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await req('/auth/login', { login: 'qatest', password: 'qa-password-2026' });
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention trigger QA' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.keyboard.press('End');
    await p.waitForTimeout(300);
    const menuOpen = async () => p.locator('.document-mention-menu').count();
    let failed = 0;
    const scenario = async (name, fn, expectMenu) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(200);
      await fn();
      await p.waitForTimeout(900);
      const open = await menuOpen();
      const pass = open === expectMenu;
      if (!pass) failed++;
      console.log(`SCENARIO ${name}: menu=${open} expect=${expectMenu} ${pass ? 'PASS' : 'FAIL'}`);
      await p.keyboard.press('Escape');
      return open;
    };
    // S1: line start
    await scenario('line-start @', () => p.keyboard.type('@'), 1);
    // S2: directly after Chinese text
    await scenario('chinese-then-@', () => p.keyboard.type('找@'), 1);
    // S3: after english + space
    await scenario('english-space-@', () => p.keyboard.type('hello @'), 1);
    // S4: directly after english word (email-like) must NOT trigger
    await scenario('english-word-@', () => p.keyboard.type('hello@'), 0);
    // S5: mid-line, text follows the caret
    await scenario('mid-line-@', async () => {
      await p.keyboard.type('中间的文字');
      await p.keyboard.press('ArrowLeft');
      await p.keyboard.press('ArrowLeft');
      await p.keyboard.type('@');
    }, 1);
    // S6: after an existing mention chip
    await p.keyboard.press('Enter');
    await p.keyboard.type('@qa');
    await p.waitForTimeout(900);
    console.log('S6 pre: menu =', await menuOpen());
    if (await menuOpen()) {
      await p.keyboard.press('Enter');
      await p.waitForTimeout(600);
      console.log('S6 chips =', await p.locator('.document-user-mention').allTextContents());
      await p.keyboard.type('@');
      await p.waitForTimeout(900);
      const open = await menuOpen();
      const pass = open === 1;
      if (!pass) failed++;
      console.log(`SCENARIO after-mention-@: menu=${open} expect=1 ${pass ? 'PASS' : 'FAIL'}`);
      await p.keyboard.press('Escape');
    } else {
      failed++;
      console.log('SCENARIO after-mention-@: FAIL (initial menu never opened)');
    }
    // Issue 2: hover card position over the mention chip
    const chip = p.locator('.document-user-mention').first();
    if (await chip.count()) {
      await chip.hover();
      await p.waitForTimeout(700);
      const card = p.locator('.user-profile-card');
      const cardCount = await card.count();
      console.log('hover: card count =', cardCount);
      if (cardCount) {
        const triggerBox = await chip.boundingBox();
        const cardBox = await card.boundingBox();
        console.log('hover: trigger box =', JSON.stringify(triggerBox));
        console.log('hover: card box =', JSON.stringify(cardBox));
        const overlap = triggerBox && cardBox &&
          cardBox.x < triggerBox.x + triggerBox.width &&
          cardBox.x + cardBox.width > triggerBox.x &&
          cardBox.y < triggerBox.y + triggerBox.height &&
          cardBox.y + cardBox.height > triggerBox.y;
        console.log('hover: card overlaps trigger =', !!overlap);
        if (overlap) failed++;
      }
      await p.screenshot({ path: '/private/tmp/doca-mention-hover.png' });
    }
    await p.screenshot({ path: '/private/tmp/doca-mention-trigger.png' });
    console.log('ERRORS', errors);
    console.log(failed ? `RESULT: ${failed} FAILURES` : 'RESULT: ALL PASS');
    if (failed) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
