// Isolated real-browser smoke/performance regression, not a cross-device benchmark.
if (process.env.DOCA_QA_ISOLATED !== "1") throw Error("Isolated QA only");
const { chromium, expect } = require(
  process.env.PLAYWRIGHT_TEST_MODULE || "@playwright/test",
);
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const origin = "http://127.0.0.1:39140";
    const ctx = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
    });
    const request = async (path, data) => {
      const r = await ctx.request.post(origin + "/api/v1" + path, {
        data,
        headers: { origin },
      });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    };
    await request("/auth/login", {
      login: "qatest",
      password: "qa-password-2026",
    });
    const cases = [],
      errors = [];
    for (const format of ["rich_text", "markdown"]) {
      const title = "Large " + format;
      const data = { kind: "document", format, title };
      if (format === "markdown")
        data.markdown =
          "# " +
          title +
          "\n" +
          Array.from(
            { length: 1000 },
            (_, i) => "第 " + i + " 行 性能协同回归测试正文。",
          ).join("\n");
      else
        data.initialContent = {
          schemaVersion: 2,
          children: Array.from({ length: 1001 }, (_, i) => ({
            id: "line-" + i,
            type: "paragraph",
            children: [
              { text: i ? "第 " + i + " 行 性能协同回归测试正文。" : title },
            ],
          })),
        };
      const doc = await request("/resources", data);
      const pages = [];
      for (let i = 0; i < 2; i++) {
        const p = await ctx.newPage(),
          state = { p, commits: 0 };
        p.on("pageerror", (e) => errors.push(e.message));
        p.on("websocket", (ws) =>
          ws.on("framesent", ({ payload }) => {
            try {
              if (JSON.parse(String(payload)).type === "update")
                state.commits++;
            } catch {}
          }),
        );
        const start = Date.now();
        await p.goto(origin + "/#/r/" + doc.id);
        const editor = p.locator(
          format === "markdown"
            ? ".cm-content[contenteditable=true]"
            : "[data-slate-editor=true][contenteditable=true]",
        );
        await editor.waitFor();
        await p
          .getByText("已保存到云端", { exact: true })
          .waitFor({ state: "attached" });
        console.log("READY", format, i, Date.now() - start, "ms");
        pages.push({ ...state, editor });
        // Share the original mutable counter, not the copied number.
        pages.at(-1).counter = state;
      }
      const [a, b] = pages;
      await a.editor.click();
      await a.p.keyboard.press("Meta+Home");
      await a.p.waitForTimeout(400);
      const peerBefore = b.counter.commits;
      const start = Date.now();
      await a.p.keyboard.type("UPGRADE-A-", { delay: 12 });
      await expect(b.editor).toContainText("UPGRADE-A-", { timeout: 15000 });
      await a.p
        .getByText("已保存到云端", { exact: true })
        .waitFor({ state: "attached" });
      assert.equal(
        b.counter.commits,
        peerBefore,
        "remote reception must not echo",
      );
      console.log("EDIT+PEER", format, Date.now() - start, "ms");
      await b.editor.click();
      await b.p.keyboard.press("Meta+Home");
      await b.p.keyboard.type("UPGRADE-B-", { delay: 12 });
      await expect(a.editor).toContainText("UPGRADE-B-", { timeout: 15000 });
      await b.p
        .getByText("已保存到云端", { exact: true })
        .waitFor({ state: "attached" });
      if (format === "markdown")
        await expect(a.p.locator(".exmd-remote-caret").first()).toBeVisible();
      await a.p.reload();
      await a.editor.waitFor();
      await expect(a.editor).toContainText("UPGRADE-A-");
      await expect(a.editor).toContainText("UPGRADE-B-");
      await a.p
        .getByText("已保存到云端", { exact: true })
        .waitFor({ state: "attached" });
      cases.push(...pages);
    }
    await new Promise((r) => setTimeout(r, 1000));
    const before = cases.map((s) => s.counter.commits);
    for (const { p } of cases) {
      await p.mouse.wheel(0, 500);
      await p.setViewportSize({ width: 1450, height: 950 });
    }
    // Keep each tool wait under a minute; caller can report progress while this script runs.
    await new Promise((r) => setTimeout(r, 61000));
    assert.deepEqual(
      cases.map((s) => s.counter.commits),
      before,
      "idle/scroll/resize must not submit",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS large rich+markdown two-page edit, no echo, reload, Markdown cursor and 61s idle",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
