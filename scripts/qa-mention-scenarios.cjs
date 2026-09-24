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
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention 场景扫描' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE: ' + m.text()); });
    const menuInfo = async () => {
      const menu = p.locator('.document-mention-menu');
      if (!(await menu.count())) return { count: 0 };
      const box = await menu.boundingBox();
      const style = await menu.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { display: cs.display, visibility: cs.visibility, zIndex: cs.zIndex, opacity: cs.opacity };
      });
      const opts = await menu.locator('[role="option"]').count();
      return { count: 1, box, style, opts };
    };
    const typeAt = async (label, type) => {
      await p.keyboard.type(type);
      await p.waitForTimeout(900);
      console.log(label, JSON.stringify(await menuInfo()));
    };
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.waitForTimeout(300);

    // 场景1: 标题行(首行 H1) 输入 @
    await typeAt('S1 标题行 @', '@');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    await p.keyboard.press('Backspace'); await p.waitForTimeout(200);

    // 场景2: 正文段落 @
    await p.keyboard.press('Enter'); await p.waitForTimeout(200);
    await typeAt('S2 正文段落 @', '@');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    await p.keyboard.press('Backspace'); await p.waitForTimeout(200);

    // 场景3: Escape 后同段落再次 @ (suppressed 逻辑)
    await typeAt('S3 Escape后再次 @', '@');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    await p.keyboard.press('Backspace'); await p.waitForTimeout(300);
    await typeAt('S3b 删除后再次 @', '@');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    await p.keyboard.press('Backspace'); await p.waitForTimeout(200);

    // 场景4: 引用块中 @
    await p.keyboard.type('/quote');
    await p.waitForTimeout(600);
    const quoteItem = p.locator('[data-slate-editor]').locator('text=引用').first();
    if (await quoteItem.count()) { await quoteItem.click(); await p.waitForTimeout(400); }
    await typeAt('S4 引用块 @', '@');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);

    console.log('ERRORS', errors);
    await p.screenshot({ path: '/private/tmp/doca-mention-scenarios.png', fullPage: false });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
