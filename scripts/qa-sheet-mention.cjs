// Sheet mention popup: styling + click-insert verification (isolated QA server only).
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1');
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
    const doc = await req('/resources', { kind: 'document', format: 'spreadsheet', title: 'Sheet Mention 样式验收' });
    const p = await ctx.newPage();
    const errors = [], lookups = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE: ' + m.text()); });
    p.on('request', (r) => { if (r.url().includes('/users/lookup')) lookups.push(decodeURIComponent(r.url().split('q=')[1] || '')); });
    await p.goto(origin + '/#/r/' + doc.id);
    await p.locator('.uos-editor canvas').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    const menu = p.locator('.sheet-native-candidates');
    const options = menu.locator('[role="option"]');
    check('SH1 单元格内@弹出', (await menu.count()) === 1 && (await options.count()) >= 2, 'opts=' + (await options.count()));
    check('SH1 候选框打开时不显示用户资料卡', (await p.locator('.user-profile-card').count()) === 0);

    // 选项结构：头像 + 昵称 + (public_id)
    const html = await options.first().innerHTML();
    check('SH2 选项含头像/昵称/括号id', html.includes('user-avatar') && html.includes('mention-option-name') && html.includes('mention-option-id'));
    const text = await options.first().textContent();
    check('SH2 选项文本格式 昵称(public_id)', /\(\w+\)$/.test(text || ''), JSON.stringify(text));

    // 容器样式：fixed、padding、圆角、z-index
    const cs = await menu.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, padding: s.padding, radius: s.borderRadius, zIndex: s.zIndex, bg: s.backgroundColor };
    });
    check('SH3 容器样式', cs.position === 'fixed' && cs.padding === '6px' && cs.radius === '8px' && cs.zIndex === '10000', JSON.stringify(cs));

    // 初始选中项(index 0)高亮
    const selBg = await options.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const selAria = await options.first().getAttribute('aria-selected');
    check('SH4 初始选中项高亮', selAria === 'true' && selBg === 'rgb(237, 242, 255)', `${selAria} ${selBg}`);

    // hover 反馈（hover 第二项：非选中项 → #f2f5fc）
    const second = options.nth(1);
    const beforeBg = await second.evaluate((el) => getComputedStyle(el).backgroundColor);
    await second.hover();
    await p.waitForTimeout(250);
    const hoverBg = await second.evaluate((el) => getComputedStyle(el).backgroundColor);
    check('SH5 hover 反馈', beforeBg === 'rgba(0, 0, 0, 0)' && hoverBg === 'rgb(242, 245, 252)', `${beforeBg} -> ${hoverBg}`);

    await p.screenshot({ path: '/private/tmp/doca-sheet-mention-styled.png' });

    // 点击插入
    await options.first().click();
    await p.waitForTimeout(800);
    check('SH6 点击插入后弹层关闭', (await menu.count()) === 0);
    check('SH6 选择用户后不显示用户资料卡', (await p.locator('.user-profile-card').count()) === 0);
    const alerts = await p.getByRole('alert').allTextContents();
    check('SH6 插入无报错', alerts.filter((t) => t.includes('未成功')).length === 0, JSON.stringify(alerts));
    await p.screenshot({ path: '/private/tmp/doca-sheet-mention-inserted.png' });

    // 悬停已插入的 @ 用户：只显示用户资料卡，不再套一层候选框。
    await p.mouse.move(308, 156);
    await p.waitForTimeout(300);
    check('SH8 悬停用户时不显示候选框', (await menu.count()) === 0);
    check('SH8 悬停用户时显示资料卡', (await p.locator('.user-profile-card').count()) === 1);

    // 取消按钮
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.press('End');
    await p.keyboard.type('@');
    await p.waitForTimeout(900);
    if (await menu.count()) {
      await menu.locator('.mention-cancel').click();
      await p.waitForTimeout(300);
      check('SH7 取消按钮关闭弹层', (await menu.count()) === 0);
    } else {
      check('SH7 取消按钮关闭弹层', false, '弹层未重新打开');
    }
    console.log('LOOKUPS', JSON.stringify(lookups));
    console.log('ERRORS', errors);
    check('无页面错误', errors.length === 0, JSON.stringify(errors));
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
})().catch((e) => { console.error(e); process.exitCode = 1; });
