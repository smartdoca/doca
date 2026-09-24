// Run only against the isolated in-memory QA server, never user documents.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Set DOCA_QA_ISOLATED=1 for the isolated QA server');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const origin = 'http://127.0.0.1:39140';
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const req = async (path, data, method = 'POST') => {
      const r = await ctx.request.fetch(origin + '/api/v1' + path, { method, headers: { origin }, data });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    // owner finds the document; peer comments so owner gets a comment.created notification
    await req('/auth/login', { login: 'qatest', password: 'qa-password-2026' });
    const docs = await ctx.request.fetch(origin + '/api/v1/resources?scope=all', { headers: { origin } }).then((r) => r.json());
    const doc = docs.items.find((x) => x.format === 'rich_text');
    console.log('target doc', doc.id, doc.title);
    await req('/auth/login', { login: 'qapeer', password: 'qa-password-2026' });
    await req(`/resources/${doc.id}/comments`, { body: '通知跳转验收评论', parentId: null });
    // peer requests a higher role so owner gets an access.requested ticket notification (tolerate a previous run's pending request)
    const rr = await ctx.request.fetch(origin + `/api/v1/resources/${doc.id}/access-requests`, { method: 'POST', headers: { origin }, data: { role: 'manager', message: '想看' } });
    console.log('access request status', rr.status());
    // owner looks at notifications
    await req('/auth/login', { login: 'qatest', password: 'qa-password-2026' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await p.goto(origin + '/#/home');
    await p.waitForTimeout(1500);
    await p.locator('.notification-trigger').click();
    await p.waitForTimeout(800);
    const rows = await p.locator('.notification-panel .notification-row').count();
    console.log('notification rows =', rows);
    const links = p.locator('.notification-panel .notification-row a', { hasText: '查看' });
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    console.log('查看 hrefs =', hrefs);
    for (let i = 0; i < hrefs.length; i++) {
      const before = p.url();
      await links.nth(i).click();
      await p.waitForTimeout(2000);
      const after = p.url();
      const mainText = (await p.locator('.main-scroll').innerText().catch(() => '')).slice(0, 150).replace(/\n/g, '|');
      console.log(`click #${i}: ${before}  ->  ${after}  changed=${before !== after}  main=${mainText}`);
      // reopen the panel for the next row
      if (i + 1 < hrefs.length) {
        await p.locator('.notification-trigger').click();
        await p.waitForTimeout(800);
      }
    }
    console.log('ERRORS', errors);
    // scenario 2: owner is already viewing the document; a like notification links to the same hash
    await req('/auth/login', { login: 'qapeer', password: 'qa-password-2026' });
    await req(`/resources/${doc.id}/reaction`, { kind: 'like', enabled: true }, 'PUT');
    await req('/auth/login', { login: 'qatest', password: 'qa-password-2026' });
    await p.goto(origin + '/#/r/' + doc.id);
    await p.waitForTimeout(2500);
    await p.evaluate(() => {
      window.__hc = 0;
      window.addEventListener('hashchange', () => window.__hc++);
    });
    await p.locator('.notification-trigger').click();
    await p.waitForTimeout(800);
    const hrefs2 = await p.locator('.notification-panel .notification-row a', { hasText: '查看' }).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    console.log('on doc page, 查看 hrefs =', hrefs2);
    const likeIdx = hrefs2.findIndex((h) => h === '#/r/' + doc.id);
    console.log('same-hash (like) notification index =', likeIdx, 'current hash =', new URL(p.url()).hash);
    if (likeIdx >= 0) {
      await p.locator('.notification-panel .notification-row a', { hasText: '查看' }).nth(likeIdx).click();
      await p.waitForTimeout(1200);
      console.log('like same-hash click: panel open after click =', await p.locator('.notification-panel').count(), ' synthetic hashchange dispatched =', await p.evaluate(() => window.__hc));
    }
    // scenario 3: same-hash comment link re-scrolls the target comment into view
    const commentHref = hrefs2.find((h) => h.includes('?comment='));
    if (commentHref) {
      await p.goto(origin + '/' + commentHref);
      await p.waitForTimeout(2500);
      const cid = new URLSearchParams(commentHref.split('?')[1]).get('comment');
      // scroll away from the comment first
      await p.evaluate(() => document.querySelector('.main-scroll')?.scrollTo({ top: 0 }));
      await p.waitForTimeout(400);
      const visibleBefore = await p.evaluate((id) => {
        const el = document.getElementById('comment-' + id);
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top <= innerHeight && r.bottom >= 0;
      }, cid);
      await p.evaluate(() => {
        window.__hc = 0;
        window.addEventListener('hashchange', () => window.__hc++);
      });
      await p.locator('.notification-trigger').click();
      await p.waitForTimeout(800);
      const idx3 = await p.locator('.notification-panel .notification-row a', { hasText: '查看' }).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const commentIdx = idx3.indexOf(commentHref);
      console.log('comment href index on page =', commentIdx, 'hash equals href =', new URL(p.url()).hash === commentHref);
      await p.locator('.notification-panel .notification-row a', { hasText: '查看' }).nth(commentIdx).click();
      await p.waitForTimeout(1500);
      const visibleAfter = await p.evaluate((id) => {
        const el = document.getElementById('comment-' + id);
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), inView: r.bottom > 0 && r.top < innerHeight, highlighted: el.classList.contains('notification-target') || !!el.querySelector('.notification-target') };
      }, cid);
      console.log('comment visible before click =', visibleBefore, ' after click =', visibleAfter, ' hc =', await p.evaluate(() => window.__hc));
    }
    await p.screenshot({ path: '/private/tmp/doca-notification-qa.png' });
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
