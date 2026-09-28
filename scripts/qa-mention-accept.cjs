// Run only against the isolated in-memory QA server, never user documents.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1 for the isolated QA server');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let failed = 0;
  const check = (name, ok, extra = '') => {
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name, extra);
    if (!ok) failed++;
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const origin = 'http://127.0.0.1:39140';
    const req = async (path, data, method = 'POST') => {
      const r = await ctx.request.fetch(origin + '/api/v1' + path, { method, headers: { origin }, data });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await req('/auth/login', { login: 'qatest', password: 'qa-password-2026' });
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention 验收' });
    const p = await ctx.newPage();
    const errors = [], lookups = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE: ' + m.text()); });
    p.on('request', (r) => { if (r.url().includes('/users/lookup')) lookups.push(decodeURIComponent(r.url().split('q=')[1] || '')); });
    const menu = p.locator('.document-mention-menu');
    const options = menu.locator('[role="option"]');
    const visible = async () => {
      if (!(await menu.count())) return false;
      const box = await menu.boundingBox();
      if (!box || box.width < 50 || box.height < 30) return false;
      return await menu.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' &&
          r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      });
    };
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.waitForTimeout(300);

    // S1: 标题文字后直接跟 @（前面非空白，按设计不弹）
    await p.keyboard.press('Meta+a');
    await p.keyboard.type('标题文字@');
    await p.waitForTimeout(800);
    check('S1 标题文字后紧跟@不弹(设计语义)', !(await menu.count()));

    // S2: 空正文段落开头 @ —— 核心回归场景
    await p.keyboard.press('End');
    await p.keyboard.press('Enter');
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    check('S2 空正文段落开头@弹出', await visible(), 'opts=' + (await options.count()));
    check('S2 lookup 已发出', lookups.length > 0, JSON.stringify(lookups));

    // S3: 键盘导航 + 回车插入
    const first = await options.first().textContent();
    await p.keyboard.press('ArrowDown');
    await p.waitForTimeout(150);
    const selectedText = await menu.locator('[role="option"][aria-selected="true"]').textContent();
    check('S3 ArrowDown 切换选中', selectedText !== first, `${first} -> ${selectedText}`);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(600);
    const chips = await p.locator('.document-user-mention').allTextContents();
    check('S3 回车插入提及 chip', chips.length === 1, JSON.stringify(chips));

    // S4: chip 后空格再 @（同段落）
    await p.keyboard.type(' say ');
    await p.keyboard.type('@qa');
    await p.waitForTimeout(900);
    check('S4 chip 后 @qa 弹出并过滤', await visible() && lookups.includes('qa'), JSON.stringify(lookups));

    // S5: 鼠标点击插入
    await options.first().click();
    await p.waitForTimeout(600);
    const chips2 = await p.locator('.document-user-mention').allTextContents();
    check('S5 点击插入提及 chip', chips2.length === 2, JSON.stringify(chips2));

    // S6: Escape 关闭后保持关闭（selection 微动不重弹）
    await p.keyboard.type('@');
    await p.waitForTimeout(800);
    check('S6a @ 弹出', await visible());
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    check('S6b Escape 关闭', !(await menu.count()));
    await p.keyboard.press('ArrowLeft');
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(500);
    check('S6c Escape 后光标移动不重弹', !(await menu.count()));

    // S7: Escape 后删除重输 @ —— 应重新弹出（suppressed 修复）
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(300);
    await p.keyboard.type('@');
    await p.waitForTimeout(800);
    check('S7 Escape 后删除重输@重新弹出', await visible());
    await p.keyboard.press('Escape');
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(300);

    // S8: 引用块内行首 @
    await p.keyboard.type('/引用');
    await p.waitForTimeout(800);
    const slash = p.locator('.sk-slash-menu');
    const slashTexts = await slash.locator('[role="menuitem"], button, [class*="item"]').allTextContents().catch(() => []);
    console.log('slash menu items:', JSON.stringify(slashTexts.slice(0, 8)));
    const quoteItem = slash.getByText('引用', { exact: false }).first();
    if (await quoteItem.count()) {
      await quoteItem.click();
      await p.waitForTimeout(500);
      await p.keyboard.type('@');
      await p.waitForTimeout(900);
      check('S8 引用块内行首@弹出', await visible());
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    } else {
      check('S8 引用块内行首@弹出', false, '斜杠菜单未找到引用项');
    }

    console.log('LOOKUPS', JSON.stringify(lookups));
    console.log('ERRORS', errors);
    check('无页面错误', errors.length === 0, JSON.stringify(errors));
    await p.screenshot({ path: '/private/tmp/doca-mention-accept.png' });
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
})().catch((e) => { console.error(e); process.exitCode = 1; });
