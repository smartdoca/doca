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
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention 插桩' });
    const p = await ctx.newPage();
    const errors = [], lookups = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE: ' + m.text()); });
    p.on('request', (r) => { if (r.url().includes('/users/lookup')) lookups.push(r.url()); });
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    const editorText = async () => await editor.evaluate((el) => el.textContent);
    const focusInfo = async () => await p.evaluate(() => {
      const ae = document.activeElement;
      return { tag: ae?.tagName, cls: ae?.className?.toString?.().slice(0, 80), slate: ae?.closest?.('[data-slate-editor]') ? true : false };
    });
    await editor.click();
    await p.waitForTimeout(300);
    console.log('after click, focus =', JSON.stringify(await focusInfo()));
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    console.log('S1 title @: text =', JSON.stringify(await editorText()), 'menu =', await p.locator('.document-mention-menu').count(), 'lookups =', lookups.length);
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(300);
    console.log('after Backspace: text =', JSON.stringify(await editorText()));
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    console.log('after Enter: text =', JSON.stringify(await editorText()), 'focus =', JSON.stringify(await focusInfo()));
    await p.keyboard.type('hello ');
    await p.waitForTimeout(400);
    console.log('after hello: text =', JSON.stringify(await editorText()));
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    console.log('S2 body hello+@: text =', JSON.stringify(await editorText()), 'menu =', await p.locator('.document-mention-menu').count(), 'lookups =', lookups.length);
    console.log('ERRORS', errors);
    await p.screenshot({ path: '/private/tmp/doca-mention-instrument.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
