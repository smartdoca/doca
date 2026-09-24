// Probe 2: register window-capture keydown preventDefault BEFORE app scripts load.
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
    const doc = await req('/resources', { kind: 'document', format: 'spreadsheet', title: 'Sheet Probe2' });
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.addEventListener('keydown', (e) => {
        if (['ArrowDown', 'ArrowUp'].includes(e.key) && document.querySelector('.sheet-native-candidates')) {
          e.preventDefault();
          e.stopPropagation();
          (window).__preempted = ((window).__preempted || 0) + 1;
        }
      }, true);
    });
    await p.goto(origin + '/#/r/' + doc.id);
    await p.locator('.uos-editor canvas').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    console.log('menu open:', await p.locator('.sheet-native-candidates').count());
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(500);
    console.log('preempted:', await p.evaluate(() => (window).__preempted || 0));
    console.log('menu after ArrowDown:', await p.locator('.sheet-native-candidates').count());
    // 若菜单还在，说明 univer 尊重更早的 preventDefault → 宿主可把监听移到 window capture 修复
    await p.screenshot({ path: '/private/tmp/doca-sheet-probe2.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
