// Disposable website/database fixture; never opens user documents.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { openTestDatabase } from '../tests/database.js';
import { createUser } from '../packages/core/src/modules/identity/passwords.js';
import { createContent } from '../packages/core/src/workflows/resources.js';
import { restoreSurface } from '../packages/core/src/modules/documents/codecs/surfaces.js';
import { restoreExlsxDocument, createExlsxCollaborationSession } from '@smartdoca/sheet/yjs';

const output = resolve(process.env.DOCA_QA_OUTPUT ?? 'artifacts/verification/sheet-comment-freeze');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'doca-comment-freeze-'));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('hex');
process.env.DOCA_FILE_STORE_ID = 'local';
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({ version: 1, stores: { local: { provider: 'local', root: temporary } } });
const { createApp } = await import('../apps/server/src/app/create-app.js');
const { storageRuntime } = await import('../apps/server/src/adapters/storage.js');
const port = Number(process.env.DOCA_QA_PORT ?? 39827), origin = `http://127.0.0.1:${port}`;
const builtWeb = process.env.DOCA_QA_BUILT_WEB === '1';
const db = await openTestDatabase({ driver: 'sqlite', path: ':memory:' });
const password = 'isolated-freeze-comment-2026';
const owner = { ...await createUser(db, { login: 'freezeqa', displayName: 'Freeze QA', password }, { bootstrap: true }), admin: 1 };
const content = createContent(db);
const app = await createApp(db, { origin, ...(builtWeb ? { staticDirectory: resolve('apps/web/dist') } : {}), storage: storageRuntime(), ai: { memory: { driver: 'sqlite', url: ':memory:' } } });
await app.listen({ host: '127.0.0.1', port: builtWeb ? port : 0 });
const address = app.server.address(); assert(address && typeof address !== 'string');
const web = builtWeb ? undefined : await createServer({
  configFile: resolve('apps/web/vite.config.ts'),
  cacheDir: resolve('artifacts/verification/sheet-comment-freeze-vite-cache'),
  // Expose only the actual public SDK handle for geometry/selection observations.
  plugins: [{ name: 'qa-sheet-handle', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0]?.endsWith('/features/documents/spreadsheet-editor.tsx')) {
      const observed = source.replace('onReady={setHandle}', 'onReady={h => { (window as any).__qaSheet = h; setHandle(h); }}');
      return process.env.DOCA_QA_REPRO === '1'
        ? observed.replace('void revealSheetComment(handle, a).catch((error) => setError(error.message));', 'handle.revealCommentAnchor(a);')
        : observed;
    }
  } }],
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, proxy: { '/api': { target: `http://127.0.0.1:${address.port}`, ws: true } } },
});
await web?.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript('window.__name = value => value');
const page = await context.newPage();
const errors: string[] = [], updates: unknown[] = [], checks: unknown[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framesent', ({ payload }) => { try { const value = JSON.parse(String(payload)); if (value.type === 'update') updates.push(value); } catch {} }));
try {
  const login = await context.request.post(origin + '/api/v1/auth/login', { headers: { origin }, data: { login: 'freezeqa', password } });
  assert.equal(login.status(), 200, await login.text());
  for (const [name, rows, columns, row, column, zoom, hidden] of [
    ['first-row', 1, 0, 60, 2, 1, false], ['both-axes', 3, 2, 60, 15, 1, false], ['frozen-target', 3, 2, 0, 0, 1, false], ['no-freeze', 0, 0, 60, 15, 1, false],
    ['zoom-150', 1, 0, 60, 2, 1.5, false], ['zoom-50', 1, 0, 60, 2, 0.5, false], ['hidden-rows', 1, 0, 60, 2, 1, true],
    ['hidden-columns', 1, 2, 60, 15, 1, false], ['unequal-dimensions', 3, 2, 60, 15, 1.5, false],
  ] as const) {
    if (process.env.DOCA_QA_CASES && !process.env.DOCA_QA_CASES.split(',').includes(name)) continue;
    const sheetId = 'freeze-sheet';
    const initialContent = { id: 'freeze-workbook', name: 'Freeze comments', appVersion: '0.25.1', locale: 'zhCN', styles: {}, sheetOrder: [sheetId], sheets: { [sheetId]: {
      id: sheetId, name: 'Sheet1', rowCount: 200, columnCount: 35, defaultRowHeight: 30, defaultColumnWidth: 90,
      freeze: { startRow: rows, startColumn: columns, ySplit: rows, xSplit: columns },
      rowData: hidden ? { 59: { hd: 1 }, 58: { hd: 1 } }
        : name === 'unequal-dimensions' ? { 0: { h: 60 }, 1: { h: 15 }, 2: { h: 45 }, 59: { h: 12 }, 58: { h: 48 } } : {},
      columnData: name === 'hidden-columns' ? { 14: { hd: 1 }, 13: { hd: 1 } }
        : name === 'unequal-dimensions' ? { 0: { w: 150 }, 1: { w: 30 }, 14: { w: 10 } } : {},
      cellData: Object.fromEntries(Array.from({ length: 120 }, (_, r) => [r, Object.fromEntries(Array.from({ length: 25 }, (_, c) => [c, { v: `${r + 1}:${c + 1}` }]))])),
    } } };
    const doc = await content.create(owner, { kind: 'document', format: 'spreadsheet', title: 'Freeze ' + name, initialContent });
    const loaded = await restoreSurface(db, doc.id, 'spreadsheet');
    const model = await restoreExlsxDocument({ baseline: loaded.baseline!, update: loaded.update, checkpointSeq: 0 });
    const session = await createExlsxCollaborationSession({ doc: model, baseline: loaded.baseline!, sessionId: 'freeze-capture' });
    const anchor = session.captureCellAnchor!({ sheetId, startRow: row, endRow: row, startColumn: column, endColumn: column });
    session.dispose(); model.destroy();
    const comment = await content.comment(owner, doc.id, { version: 1, blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Locate ' + name }] }] }, null, JSON.stringify(anchor));
    await page.goto(origin);
    await page.evaluate(({ key, zoom }) => localStorage.setItem(key, JSON.stringify({ version: 1, zoomRatio: zoom })), { key: `doca.sheet.zoom.v1:${owner.id}:${doc.id}`, zoom });
    await page.goto(origin + '/#/r/' + doc.id);
    if (builtWeb) {
      // Observe the real host's mounted ref without changing the production
      // bundle. All assertions below use the public SDK handle, never engine internals.
      await page.waitForFunction(() => {
        const root = document.querySelector('.sheet-document .uos-editor');
        if (!root) return false;
        const key = Object.keys(root).find(key => key.startsWith('__reactFiber$'));
        let fiber = key ? (root as any)[key] : null;
        while (fiber) {
          const handle = (fiber.memoizedProps?.ref ?? fiber.ref)?.current;
          if (handle?.getRuntime) { (window as any).__qaSheet = handle; return !!handle.getRuntime()?.univerAPI.getActiveWorkbook(); }
          fiber = fiber.return;
        }
        return false;
      });
    }
    await page.waitForFunction(() => !!(window as any).__qaSheet?.getRuntime()?.univerAPI.getActiveWorkbook());
    await page.getByText(/已保存到云端$/).last().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '展开内容评论', exact: true }).click();
    const state = await db.selectFrom('document_states').select(['seq', 'checkpoint']).where('resource_id', '=', doc.id).executeTakeFirstOrThrow();
    const before = await page.evaluate(() => (window as any).__qaSheet.getSelection());
    const updateCount = updates.length;
    await page.locator(`[data-comment-id="${comment.id}"] .rich-comment-body`).click();
    await page.waitForFunction(({ row, column, sheetId }) => {
      const h = (window as any).__qaSheet;
      const rect = h.getRangeRect({ sheetId, startRow: row, endRow: row, startColumn: column, endColumn: column }, { allowOutside: true });
      return rect && Number.isFinite(rect.top);
    }, { row, column, sheetId });
    // Wait for the renderer, not a fixed scroll duration.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(({ row, column, sheetId, rows, columns }) => {
      const h = (window as any).__qaSheet;
      const rect = (r: number, c: number) => h.getRangeRect({ sheetId, startRow: r, endRow: r, startColumn: c, endColumn: c }, { allowOutside: true })?.toJSON();
      return { target: rect(row, column), frozenRow: rows ? rect(rows - 1, column) : null, frozenColumn: columns ? rect(row, columns - 1) : null, selection: h.getSelection(), scroll: h.getRuntime().univerAPI.getActiveWorkbook().getActiveSheet().getScrollState() };
    }, { row, column, sheetId, rows, columns });
    checks.push({ name, geometry });
    await page.screenshot({ path: join(output, name + '.png') });
    console.log(JSON.stringify({ name, geometry }));
    if (rows && row >= rows) assert(geometry.target.top >= geometry.frozenRow.bottom - 1, 'target hidden under frozen rows: ' + name);
    if (columns && column >= columns) assert(geometry.target.left >= geometry.frozenColumn.right - 1, 'target hidden under frozen columns: ' + name);
    assert.deepEqual(geometry.selection, before, 'comment reveal preserves cell selection');
    assert.equal(updates.length, updateCount, 'comment reveal is view only');
    assert.deepEqual(await db.selectFrom('document_states').select(['seq', 'checkpoint']).where('resource_id', '=', doc.id).executeTakeFirstOrThrow(), state);
    if (name === 'unequal-dimensions' && !builtWeb) {
      console.log('Checking 60 seconds of idle without content writes');
      await page.waitForTimeout(60000);
      assert.equal(updates.length, updateCount, 'idle does not publish content updates');
      assert.deepEqual(await db.selectFrom('document_states').select(['seq', 'checkpoint']).where('resource_id', '=', doc.id).executeTakeFirstOrThrow(), state);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ webMode: builtWeb ? 'production-build' : 'development-server', checks, errors }, null, 2));
} finally {
  await browser.close(); await web?.close(); await app.close(); await db.destroy(); await rm(temporary, { recursive: true, force: true });
}
