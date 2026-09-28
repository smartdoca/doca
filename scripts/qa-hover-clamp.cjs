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
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Hover clamp QA' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.keyboard.press('End');
    await p.keyboard.press('Enter');
    // Fill enough lines so the chip line lands near the bottom of the viewport.
    for (let i = 0; i < 30; i++) {
      await p.keyboard.type('填充行 padding line');
      await p.keyboard.press('Enter');
    }
    await p.keyboard.type('@qa');
    await p.waitForTimeout(900);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(600);
    console.log('chips =', await p.locator('.document-user-mention').allTextContents());
    const chip = p.locator('.document-user-mention').first();
    await p.setViewportSize({ width: 1600, height: Number(process.env.QA_HEIGHT || 560) });
    await p.waitForTimeout(500);
    await chip.hover();
    await p.waitForTimeout(700);
    const card = p.locator('.user-profile-card');
    console.log('card count =', await card.count());
    if (await card.count()) {
      const triggerBox = await chip.boundingBox();
      const cardBox = await card.boundingBox();
      console.log('trigger box =', JSON.stringify(triggerBox));
      console.log('card box =', JSON.stringify(cardBox));
      const overlap = triggerBox && cardBox &&
        cardBox.x < triggerBox.x + triggerBox.width &&
        cardBox.x + cardBox.width > triggerBox.x &&
        cardBox.y < triggerBox.y + triggerBox.height &&
        cardBox.y + cardBox.height > triggerBox.y;
      console.log('card overlaps trigger =', !!overlap);
    }
    await p.screenshot({ path: '/private/tmp/doca-hover-clamp.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
