// Isolated browser regression for AI link insertion; never pass a production origin.
if (process.env.DOCA_QA_ISOLATED !== '1') throw Error('Isolated QA only');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const port = process.env.DOCA_QA_PORT || '39261'; if (!['39261'].includes(port)) throw Error('Unknown QA port');
const origin = 'http://127.0.0.1:' + port;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const request = async (path, data, method = 'GET') => {
      const r = await ctx.request.fetch(origin + '/api/v1' + path, { method, headers: { origin }, data });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await request('/auth/login', { login: 'aiqa', password: 'isolated-ai-qa-2026' }, 'POST');
    const docs = (await request('/resources')).items.filter((r) => r.kind === 'document');
    const rich = docs.find((r) => r.title === '链接验收文档');
    assert.ok(rich, 'fixture document missing');

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/#/r/' + rich.id);
    await page.locator('.sk-editor, [contenteditable="true"]').first().waitFor();

    // Open the document-scoped AI panel and ask for a link insertion.
    await page.getByRole('button', { name: 'AI 辅助创作', exact: true }).click();
    const input = page.locator('.ai-composer [contenteditable="true"]');
    await input.waitFor();
    await input.click();
    await input.fill('在文档末尾添加 Doca 官网链接 https://doca.example.com');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    // Wait for the background job to finish via the session API.
    let job;
    for (let i = 0; i < 240; i++) {
      const session = await request('/ai/sessions?resourceId=' + rich.id);
      const detail = session[0] && (await request('/ai/sessions/' + session[0].id));
      job = detail?.jobs?.find((j) => j.input?.text?.includes('Doca 官网') || j.status);
      if (job && !['queued', 'running'].includes(job.status)) break;
      await page.waitForTimeout(500);
    }
    assert.ok(job, 'AI job not found');
    assert.equal(job.status, 'completed', JSON.stringify(job.progress?.events ?? job));
    assert.equal(job.progress?.review?.verdict, 'pass', 'reviewer must verify the saved link');
    const editEvent = (job.progress?.events ?? []).find((e) => e.kind === 'tool' && e.text === '保存文档修改');
    assert.equal(editEvent?.status, 'success', 'edit tool event must report success only when saved');

    // Read-after-write through the preview API: a native link element exists.
    const preview = await request('/ai/resources/' + rich.id + '/preview');
    const serialized = JSON.stringify(preview);
    assert.ok(serialized.includes('"type":"link"'), 'preview must contain a native link element: ' + serialized.slice(-400));
    assert.ok(serialized.includes('https://doca.example.com'), 'preview must contain the link url');

    // The editor UI renders the AI-inserted link as a real clickable link.
    const link = page.locator('.sk-link-wrap, a[href="https://doca.example.com"]').first();
    await link.waitFor({ timeout: 10000 });
    assert.match(await link.innerText(), /Doca 官网/);
    await page.screenshot({ path: '/tmp/doca-ai-link-ui.png' });
    assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
    console.log('PASS AI link insertion: saved, reviewed and rendered as a real link');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
