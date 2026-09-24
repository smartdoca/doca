// Run only against the isolated in-memory QA server, never user documents.
// Records .user-profile-card geometry on every painted frame to detect visible jumps.
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
    const peers = await req('/users/lookup?q=qapeer', undefined, 'GET');
    const peer = peers.items.find((u) => u.login === 'qapeer' || u.display_name === '协同乙');
    assert.ok(peer, 'peer user found');
    const doc = await req('/resources', { kind: 'document', format: 'rich_text', title: 'Mention jump QA' });
    // A whole-document comment containing an @mention (the conversation surface).
    await req(`/resources/${doc.id}/comments`, {
      parentId: null,
      richBody: {
        version: 1,
        blocks: [{
          type: 'paragraph',
          children: [
            { type: 'text', text: '对话里的提及 ' },
            { type: 'mention', userId: peer.id, label: peer.display_name || 'qapeer' },
          ],
        }],
      },
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    // Frame recorder injected before any app code runs.
    await p.addInitScript(() => {
      window.__cardFrames = [];
      window.__recordCard = (ms) => {
        window.__cardFrames = [];
        const t0 = performance.now();
        const tick = () => {
          const el = document.querySelector('.user-profile-card');
          if (el) {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            window.__cardFrames.push({
              t: Math.round(performance.now() - t0),
              top: Math.round(r.top * 10) / 10,
              left: Math.round(r.left * 10) / 10,
              height: Math.round(r.height * 10) / 10,
              visibility: cs.visibility,
              opacity: cs.opacity,
            });
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
    });
    await p.goto(origin + '/#/r/' + doc.id);
    const editor = p.locator('[data-slate-editor]');
    await editor.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2500);
    await editor.click();
    await p.keyboard.press('End');
    await p.keyboard.press('Enter');
    // Fill lines so the chip lands near the bottom of the (short) viewport.
    // insertText keeps the update count far below the realtime rate limit.
    for (let i = 0; i < 30; i++) {
      await p.keyboard.insertText('填充行 padding line');
      await p.keyboard.press('Enter');
    }
    await p.keyboard.insertText('@qa');
    await p.waitForTimeout(900);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(600);
    const chip = p.locator('.document-user-mention').first();
    assert.ok(await chip.count(), 'mention chip inserted');
    await p.setViewportSize({ width: 1600, height: 560 });
    await p.waitForTimeout(500);

    let bad = 0;
    const analyze = (name, frames) => {
      const visible = frames.filter((f) => f.visibility !== 'hidden' && f.opacity !== '0');
      const jumps = [];
      for (let i = 1; i < visible.length; i++)
        if (Math.abs(visible[i].top - visible[i - 1].top) > 1)
          jumps.push([visible[i - 1], visible[i]]);
      console.log(name, 'visible frames =', visible.length,
        'first =', JSON.stringify(visible[0]), 'last =', JSON.stringify(visible[visible.length - 1]));
      if (jumps.length) {
        bad += jumps.length;
        console.log(name, 'JUMPS', JSON.stringify(jumps));
      } else console.log(name, 'no visible jump');
      return visible;
    };

    // --- scenario 1: hover the document mention chip ---
    await p.evaluate(() => window.__recordCard(1500));
    await chip.hover();
    await p.waitForTimeout(1600);
    const hoverVisible = analyze('HOVER', await p.evaluate(() => window.__cardFrames));
    assert.ok(hoverVisible.length, 'hover card opens');
    const chipBox = await chip.boundingBox();
    const cardBox = hoverVisible[hoverVisible.length - 1];
    const overlap = chipBox && cardBox &&
      cardBox.left < chipBox.x + chipBox.width && cardBox.left + 280 > chipBox.x &&
      cardBox.top < chipBox.y + chipBox.height && cardBox.top + cardBox.height > chipBox.y;
    console.log('HOVER card overlaps trigger =', !!overlap, 'chip', JSON.stringify(chipBox), 'card', JSON.stringify(cardBox));
    if (overlap) bad++;
    await p.screenshot({ path: '/private/tmp/doca-mention-card-hover.png' });

    // --- scenario 2: close, then click the chip ---
    await p.keyboard.press('Escape');
    await p.mouse.move(800, 100);
    await p.waitForTimeout(600);
    await p.evaluate(() => window.__recordCard(1500));
    await chip.click();
    await p.waitForTimeout(1600);
    analyze('CLICK', await p.evaluate(() => window.__cardFrames));
    await p.screenshot({ path: '/private/tmp/doca-mention-card-click.png' });
    await p.keyboard.press('Escape');
    await p.mouse.move(800, 100);
    await p.waitForTimeout(500);

    // --- scenario 3: click the @mention inside the comment conversation ---
    const commentMention = p.locator('.discussion .comment-mention').first();
    await commentMention.scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
    const mentionBox = await commentMention.boundingBox();
    console.log('comment mention box', JSON.stringify(mentionBox), 'viewport 560');
    await p.evaluate(() => window.__recordCard(1500));
    await commentMention.click();
    await p.waitForTimeout(1600);
    const convVisible = analyze('COMMENT-CLICK', await p.evaluate(() => window.__cardFrames));
    if (convVisible.length) {
      const last = convVisible[convVisible.length - 1];
      const mb = await commentMention.boundingBox();
      const gap = mb ? Math.min(Math.abs(last.top - (mb.y + mb.height)), Math.abs(last.top + last.height - mb.y)) : null;
      console.log('COMMENT-CLICK final card', JSON.stringify(last), 'gap to trigger =', gap);
    }
    await p.screenshot({ path: '/private/tmp/doca-mention-card-comment.png' });

    console.log(bad ? `RESULT: ${bad} FAILURES` : 'RESULT: NO JUMP');
    process.exitCode = bad ? 1 : 0;
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
