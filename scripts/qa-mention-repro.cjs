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
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention QA 文档' });
    const p = await ctx.newPage();
    const errors = [], lookups = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    p.on('request', (r) => { if (r.url().includes('/users/lookup')) lookups.push(r.url()); });
    p.on('response', async (r) => {
      if (r.url().includes('/users/lookup')) {
        let body = '';
        try { body = JSON.stringify(await r.json()); } catch {}
        console.log('LOOKUP RESPONSE', r.status(), body.slice(0, 300));
      }
    });
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    console.log('editor mounted');
    // wait for sync ready (editable)
    await p.waitForTimeout(2500);
    await editor.click();
    await p.waitForTimeout(300);
    await p.keyboard.press('End');
    await p.keyboard.press('Enter');
    await p.keyboard.type('hello ');
    await p.waitForTimeout(300);
    await p.keyboard.type('@');
    await p.waitForTimeout(800);
    const menuCount1 = await p.locator('.document-mention-menu').count();
    console.log('after typing @, menu count =', menuCount1, 'lookups =', lookups);
    await p.keyboard.type('qa');
    await p.waitForTimeout(900);
    const menuCount2 = await p.locator('.document-mention-menu').count();
    const options = await p.locator('.document-mention-menu [role="option"]').allTextContents();
    console.log('after typing @qa, menu count =', menuCount2, 'options =', options, 'lookups =', lookups);
    if (menuCount2 && options.length) {
      await p.keyboard.press('ArrowDown');
      await p.waitForTimeout(150);
      const selected = await p.locator('.document-mention-menu [role="option"][aria-selected="true"]').allTextContents();
      console.log('after ArrowDown selected =', selected);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(600);
      const chips = await p.locator('.document-user-mention').allTextContents();
      console.log('after Enter, mention chips =', chips);
    }
    console.log('ERRORS', errors);
    await p.screenshot({ path: '/private/tmp/doca-mention-qa.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
