// Probe 3: sheet mention cancel button behavior.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1');
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
    const doc = await req('/resources', { kind: 'document', format: 'spreadsheet', title: 'Sheet Cancel Probe' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await p.goto(origin + '/#/r/' + doc.id);
    await p.locator('.uos-editor canvas').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    const menu = p.locator('.sheet-native-candidates');
    console.log('open:', await menu.count());
    const cancel = menu.locator('.mention-cancel');
    console.log('cancel btn count:', await cancel.count());
    await cancel.click();
    await p.waitForTimeout(300);
    console.log('after cancel click (t+300):', await menu.count());
    await p.waitForTimeout(900);
    console.log('after cancel click (t+1200):', await menu.count());
    await p.screenshot({ path: '/private/tmp/doca-sheet-cancel.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
