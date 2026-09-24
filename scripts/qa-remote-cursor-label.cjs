// Run only against the isolated in-memory QA server, never user documents.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1 for the isolated QA server');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const origin = 'http://127.0.0.1:39140';
    const login = async (ctx, login) => {
      const r = await ctx.request.fetch(origin + '/api/v1/auth/login', {
        method: 'POST', headers: { origin }, data: { login, password: 'qa-password-2026' },
      });
      assert.equal(r.status(), 200, await r.text());
    };
    // Create a fresh rich_text document shared with the peer as editor.
    const boot = await browser.newContext();
    await login(boot, 'qatest');
    const peerLookup = await (await boot.request.fetch(origin + '/api/v1/users/lookup?q=qapeer', { headers: { origin } })).json();
    const peer = peerLookup.items[0];
    const created = await (await boot.request.fetch(origin + '/api/v1/resources', {
      method: 'POST', headers: { origin },
      data: { kind: 'document', format: 'rich_text', title: 'Cursor label QA' },
    })).json();
    const perm = await boot.request.fetch(origin + `/api/v1/resources/${created.id}/permissions`, {
      method: 'PUT', headers: { origin },
      data: { version: created.version, visibility: 'invited', accessMode: 'custom', grants: [{ userId: peer.id, role: 'editor' }] },
    });
    assert.equal(perm.status(), 200, await perm.text());
    const doc = created;
    await boot.close();

    const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await login(ctxA, 'qatest');
    await login(ctxB, 'qapeer');
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    a.on('pageerror', (e) => console.log('A PAGEERROR:', e.message));
    b.on('pageerror', (e) => console.log('B PAGEERROR:', e.message));
    await a.goto(origin + '/#/r/' + doc.id);
    await b.goto(origin + '/#/r/' + doc.id);
    const editorA = a.locator('[data-slate-editor]');
    const editorB = b.locator('[data-slate-editor]');
    await editorA.waitFor({ timeout: 30000 });
    await editorB.waitFor({ timeout: 30000 });
    await a.waitForTimeout(3000);
    await b.waitForTimeout(3000);
    // Peer B clicks into the very first line (document title) and types.
    await editorB.locator('[data-slate-string]').first().click();
    await b.keyboard.press('Home');
    await b.keyboard.type('乙在首行');
    // Give presence time to propagate to A.
    await a.waitForFunction(
      () => document.querySelectorAll('.remote-caret').length > 0,
      null,
      { timeout: 15000 },
    );
    await a.waitForTimeout(600);
    const report = await a.evaluate(() => {
      const caret = document.querySelector('.remote-caret');
      const label = caret?.querySelector('span');
      if (!caret || !label) return { error: 'no remote caret label' };
      const lb = label.getBoundingClientRect();
      const cb = caret.getBoundingClientRect();
      const scroller = document.querySelector('.main-scroll')?.getBoundingClientRect();
      const toolbar = document.querySelector('.editor-fixed-toolbar')?.getBoundingClientRect();
      const slot = document.getElementById('editor-toolbar-slot')?.getBoundingClientRect();
      // What is actually painted at the label's center point?
      const at = document.elementFromPoint(lb.left + lb.width / 2, lb.top + lb.height / 2);
      const coveredBy = at ? (at.closest('.editor-fixed-toolbar') ? 'toolbar'
        : at.closest('#editor-toolbar-slot') ? 'toolbar-slot'
        : label.contains(at) || at === label ? 'label'
        : at.className || at.tagName) : 'nothing';
      return {
        label: { top: lb.top, bottom: lb.bottom, left: lb.left, height: lb.height, text: label.textContent },
        caret: { top: cb.top, height: cb.height },
        scrollerTop: scroller?.top,
        toolbar: toolbar ? { top: toolbar.top, bottom: toolbar.bottom } : null,
        slotBottom: slot?.bottom,
        coveredBy,
        clippedAboveScroller: scroller ? lb.top < scroller.top - 0.5 : null,
        overlapsToolbar: toolbar ? lb.top < toolbar.bottom && lb.bottom > toolbar.top : null,
      };
    });
    console.log('REPORT', JSON.stringify(report, null, 2));
    await a.screenshot({ path: '/private/tmp/doca-remote-caret-a.png' });
    // Scroll A a little so the peer caret slides under the sticky toolbar zone.
    await a.evaluate(() => document.querySelector('.main-scroll')?.scrollBy(0, 60));
    await a.waitForTimeout(600);
    const report2 = await a.evaluate(() => {
      const caret = document.querySelector('.remote-caret');
      const label = caret?.querySelector('span');
      if (!caret || !label) return { error: 'no remote caret label' };
      const lb = label.getBoundingClientRect();
      const cb = caret.getBoundingClientRect();
      const scroller = document.querySelector('.main-scroll')?.getBoundingClientRect();
      return {
        label: { top: lb.top, bottom: lb.bottom, text: label.textContent },
        caretTop: cb.top,
        scrollerTop: scroller?.top,
        clippedAboveScroller: scroller ? lb.top < scroller.top - 0.5 : null,
      };
    });
    console.log('REPORT-SCROLLED', JSON.stringify(report2, null, 2));
    await a.screenshot({ path: '/private/tmp/doca-remote-caret-a-scrolled.png' });
    const occluded = report.clippedAboveScroller || report2.clippedAboveScroller;
    console.log('flip applied when scrolled under toolbar =', report2.label.top >= report2.caretTop - 0.5);
    console.log(occluded ? 'RESULT: LABEL OCCLUDED (bug reproduced)' : 'RESULT: LABEL VISIBLE');
    process.exitCode = occluded ? 1 : 0;
    await ctxA.close();
    await ctxB.close();
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
