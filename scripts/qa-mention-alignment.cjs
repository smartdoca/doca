// Mention dropdown left-alignment QA: slate document + spreadsheet (isolated QA server only).
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
  const measure = async (option) => {
    const cs = await option.evaluate((el) => {
      const s = getComputedStyle(el);
      const row = el.getBoundingClientRect();
      const first = el.firstElementChild.getBoundingClientRect();
      return {
        display: s.display,
        justifyContent: s.justifyContent,
        textAlign: s.textAlign,
        paddingLeft: parseFloat(s.paddingLeft),
        rowLeft: row.left,
        childLeft: first.left,
        width: row.width,
      };
    });
    cs.offset = +(cs.childLeft - cs.rowLeft - cs.paddingLeft).toFixed(1);
    return cs;
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
    const docs = await ctx.request.fetch(origin + '/api/v1/resources?scope=all', { headers: { origin } }).then((r) => r.json());
    const rich = docs.items.find((x) => x.format === 'rich_text');
    const sheet = docs.items.find((x) => x.format === 'spreadsheet');
    const p = await ctx.newPage();

    // 1. slate rich-text document mention menu
    await p.goto(origin + '/#/r/' + rich.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.keyboard.press('End');
    await p.keyboard.press('Enter');
    await p.keyboard.type('@');
    await p.waitForTimeout(1200);
    const menu = p.locator('.document-mention-menu');
    check('DOC1 @弹出文档提及菜单', (await menu.count()) === 1);
    if (await menu.count()) {
      const options = menu.locator('[role="option"]');
      check('DOC2 有候选用户', (await options.count()) >= 1, 'opts=' + (await options.count()));
      const m = await measure(options.first());
      console.log('  doc option metrics', JSON.stringify(m));
      check('DOC3 选项 flex 左对齐', m.display === 'flex' && m.justifyContent === 'flex-start' && m.textAlign === 'left', `justify=${m.justifyContent} textAlign=${m.textAlign}`);
      check('DOC4 内容贴左（无居中偏移）', Math.abs(m.offset) < 2, `offset=${m.offset}px width=${m.width}`);
      const html = await options.first().innerHTML();
      check('DOC5 选项含头像/昵称/括号id', html.includes('user-avatar') && html.includes('mention-option-name') && html.includes('mention-option-id'));
      await p.screenshot({ path: '/private/tmp/doca-mention-align-doc.png' });
      await p.keyboard.press('Escape');
    }

    // 2. spreadsheet native candidates
    await p.goto(origin + '/#/r/' + sheet.id);
    await p.locator('.uos-editor canvas').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await p.mouse.dblclick(308, 156);
    await p.waitForTimeout(600);
    await p.keyboard.type('@');
    await p.waitForTimeout(1200);
    const smenu = p.locator('.sheet-native-candidates');
    check('SH1 单元格内@弹出', (await smenu.count()) === 1);
    if (await smenu.count()) {
      const options = smenu.locator('[role="option"]');
      check('SH2 有候选用户', (await options.count()) >= 1, 'opts=' + (await options.count()));
      const m = await measure(options.first());
      console.log('  sheet option metrics', JSON.stringify(m));
      check('SH3 选项 flex 左对齐', m.display === 'flex' && m.justifyContent === 'flex-start' && m.textAlign === 'left', `justify=${m.justifyContent} textAlign=${m.textAlign}`);
      check('SH4 内容贴左（无居中偏移）', Math.abs(m.offset) < 2, `offset=${m.offset}px width=${m.width}`);
      const html = await options.first().innerHTML();
      check('SH5 选项含头像/昵称/括号id', html.includes('user-avatar') && html.includes('mention-option-name') && html.includes('mention-option-id'));
      await p.screenshot({ path: '/private/tmp/doca-mention-align-sheet.png' });
    }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
})().catch((e) => { console.error(e); process.exitCode = 1; });
