// Probe: does ArrowDown during sheet mention popup commit the cell edit?
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
    const doc = await req('/resources', { kind: 'document', format: 'spreadsheet', title: 'Sheet Probe' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await p.goto(origin + '/#/r/' + doc.id);
    await p.locator('.uos-editor canvas').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    // 页面内探针：window capture 最先，document capture 次之，bubble 最后
    await p.evaluate(() => {
      (window).__keylog = [];
      const rec = (phase) => (e) => {
        if (['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key))
          (window).__keylog.push(`${phase}:${e.key}:prevented=${e.defaultPrevented}`);
      };
      window.addEventListener('keydown', rec('window-capture'), true);
      document.addEventListener('keydown', rec('document-capture'), true);
      window.addEventListener('keydown', rec('window-bubble'), false);
    });
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    console.log('menu open:', await p.locator('.sheet-native-candidates').count());
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(400);
    console.log('keylog:', JSON.stringify(await p.evaluate(() => (window).__keylog)));
    console.log('menu after ArrowDown:', await p.locator('.sheet-native-candidates').count());
    await p.screenshot({ path: '/private/tmp/doca-sheet-probe.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
