// End-to-end browser verification. Uses only synthetic accounts and an isolated database.
import assert from "node:assert/strict";
import { encodeSystemError } from "../packages/i18n/src/index.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium, type BrowserContext, type Locator } from "playwright-core";
import { openDatabase } from "../packages/db/src/index.js";
import { createUser } from "../packages/core/src/modules/identity/passwords.js";
import { createContent } from "../packages/core/src/workflows/resources.js";
import { createGroups } from "../packages/core/src/modules/groups/service.js";
import { createGroupGrants } from "../packages/core/src/modules/groups/grants.js";

const root = await mkdtemp(join(tmpdir(), "doca-groups-qa-"));
process.env.DOCA_CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
process.env.DOCA_FILE_STORE_ID = "groups-qa";
process.env.DOCA_FILE_STORES_JSON = JSON.stringify({
  version: 1,
  stores: { "groups-qa": { provider: "local", root } },
});
process.env.DOCA_PLUGINS_DIR = join(root, "plugins");
const { createApp } = await import("../apps/server/src/app/create-app.js");
const { storageRuntime } =
  await import("../apps/server/src/adapters/storage.js");
const db = await openDatabase({ driver: "sqlite", path: ":memory:" });
const password = "groups-qa-isolated-2026";
const owner = {
  ...(await createUser(
    db,
    { login: "groupqaowner", displayName: "周知远", password },
    { bootstrap: true },
  )),
  admin: 1,
};
const peer = await createUser(
  db,
  { login: "groupqapeer", displayName: "林小满", password },
  { actor: owner },
);
await createUser(
  db,
  { login: "groupqaguest", displayName: "许明澈", password },
  { actor: owner },
);
const library = await createContent(db).create(owner, {
  kind: "library",
  format: "markdown",
  title: "产品资料",
});
const doc = await createContent(db).create(owner, {
  kind: "document",
  format: "markdown",
  title: "产品协作说明",
  markdown: "# 产品协作\n用户组权限验证。",
  libraryId: library.id,
});
const webPort = Number(process.env.DOCA_QA_PORT ?? "39439");
const builtWeb = process.env.DOCA_QA_BUILT_WEB === "1";
const origin = `http://127.0.0.1:${webPort}`;
const app = await createApp(db, {
  origin,
  ...(builtWeb ? { staticDirectory: resolve("apps/web/dist") } : {}),
  storage: { ...storageRuntime(), root },
  ai: { memory: { driver: "sqlite", url: ":memory:" } },
});
await app.listen({ host: "127.0.0.1", port: builtWeb ? webPort : 0 });
const address = app.server.address();
assert(address && typeof address !== "string");
const web = builtWeb
  ? undefined
  : await createServer({
      configFile: resolve("apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: webPort,
        strictPort: true,
        proxy: {
          "/api": { target: `http://127.0.0.1:${address.port}`, ws: true },
        },
      },
    });
await web?.listen();
const output = resolve(
  process.env.DOCA_QA_OUTPUT ?? "artifacts/verification/user-groups/browser",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [],
  checks: string[] = [];
const request = async (
  context: BrowserContext,
  path: string,
  data?: unknown,
  method = "GET",
) => {
  const response = await context.request.fetch(origin + "/api/v1" + path, {
    method,
    headers: { origin },
    ...(data !== undefined ? { data } : {}),
  });
  assert.equal(
    response.status(),
    200,
    `${method} ${path}: ${await response.text()}`,
  );
  return response.json();
};
try {
  const own = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const member = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  await request(
    own,
    "/auth/login",
    { login: "groupqaowner", password },
    "POST",
  );
  await request(
    member,
    "/auth/login",
    { login: "groupqapeer", password },
    "POST",
  );
  const page = await own.newPage(),
    peerPage = await member.newPage();
  const shot = async (file: string) => {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      );
    });
    await page.screenshot({ path: join(output, file), fullPage: true });
  };
  async function setScope(control: Locator, checked: boolean) {
    if ((await control.isChecked()) !== checked) await control.click();
    await page.waitForFunction(
      ({ node, expected }) => (node as HTMLInputElement).checked === expected,
      { node: await control.elementHandle(), expected: checked },
    );
  }
  async function waitConfirmationBubble() {
    await page.locator(".permission-remove-confirm:visible").waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector(".permission-remove-confirm");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      let current: Element | null = el;
      while (current) {
        const style = getComputedStyle(current);
        if (style.visibility === "hidden" || Number(style.opacity) < 0.99)
          return false;
        current = current.parentElement;
      }
      return (
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= innerWidth &&
        rect.bottom <= innerHeight
      );
    });
  }
  const motion: { name: string; animations: number }[] = [];
  async function motionFrames(selector: string, name: string) {
    const count = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const animations = el.getAnimations();
        for (const animation of animations) animation.pause();
        return animations.length;
      });
    assert(count > 0, name + " has a browser animation");
    for (const [frame, progress] of [
      ["start", 0],
      ["mid", 0.5],
      ["end", 1],
    ] as const) {
      await page
        .locator(selector)
        .first()
        .evaluate((el, progress) => {
          for (const animation of el.getAnimations())
            animation.currentTime =
              Number(animation.effect?.getTiming().duration) * progress;
        }, progress);
      await page.screenshot({
        path: join(output, `${name}-${frame}.png`),
        fullPage: true,
      });
    }
    await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        for (const animation of el.getAnimations()) animation.finish();
      });
    motion.push({ name, animations: count });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  peerPage.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/#/groups");
  await page.locator(".groups-empty").waitFor();
  await page
    .locator(".groups-header")
    .getByRole("button", { name: "创建用户组" })
    .click();
  await page.locator(".group-name-field input").fill("产品研发组");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.locator(".group-card").filter({ hasText: "产品研发组" }).waitFor();
  await motionFrames(".group-card", "motion-entry");
  await page.locator(".groups-header button").hover();
  await motionFrames(".groups-header button", "motion-action");
  await shot("groups-list.png");
  const list = await request(own, "/groups");
  const groupId = list.items[0].id;
  await page.locator(".group-card").first().click();
  await page.locator(".group-members").waitFor();
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await page.locator(".person-picker input").fill("林小");
  await page.locator(".person-result").filter({ hasText: "林小满" }).click();
  await page.getByRole("button", { name: "发送邀请", exact: true }).click();
  await page.getByText("邀请已发送", { exact: true }).first().waitFor();
  await page.screenshot({
    path: join(output, "invite-name.png"),
    fullPage: true,
  });
  await page.locator(".modal header button").click();
  await peerPage.goto(origin + "/#/groups");
  await peerPage.getByRole("button", { name: "接受", exact: true }).click();
  await peerPage.locator(".group-card").waitFor();
  checks.push("named invitation requires member consent");
  await page.reload();
  await page
    .locator(".group-member-row")
    .filter({ hasText: "林小满" })
    .waitFor();
  await page
    .locator(".group-member-row")
    .filter({ hasText: "林小满" })
    .getByRole("button", { name: "设为管理员", exact: true })
    .click();
  await page
    .locator(".group-member-row")
    .filter({ hasText: "林小满" })
    .getByText("管理员", { exact: true })
    .waitFor();
  await shot("group-members.png");
  checks.push("owner assigns an administrator through the member UI");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await page.getByRole("button", { name: "邀请链接", exact: true }).click();
  await page.getByRole("button", { name: "生成邀请链接", exact: true }).click();
  await page.locator(".group-link input").waitFor();
  let invitationUrl = await page.locator(".group-link input").inputValue();
  await page.screenshot({
    path: join(output, "invite-link.png"),
    fullPage: true,
  });
  await page.reload();
  await page.locator(".group-members").waitFor();
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await page.getByRole("button", { name: "邀请链接", exact: true }).click();
  await page
    .getByRole("button", { name: "重新生成链接", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("invite-link-mobile.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "mobile invitation horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "撤销链接", exact: true }).click();
  await page
    .getByRole("button", { name: "生成邀请链接", exact: true })
    .waitFor();
  const revoked = await own.request.get(
    origin +
      "/api/v1/groups/join/" +
      new URL(invitationUrl).hash.split("token=")[1],
  );
  assert.equal(revoked.status(), 404);
  await page.getByRole("button", { name: "生成邀请链接", exact: true }).click();
  await page.locator(".group-link input").waitFor();
  invitationUrl = await page.locator(".group-link input").inputValue();
  checks.push(
    "an existing invitation link remains revocable after reload, and its old token stops working",
  );
  const guest = await browser.newContext();
  await request(
    guest,
    "/auth/login",
    { login: "groupqaguest", password },
    "POST",
  );
  const guestPage = await guest.newPage();
  await guestPage.goto(invitationUrl);
  await guestPage.getByRole("button", { name: "接受邀请并加入" }).click();
  await guestPage.locator(".group-members").waitFor();
  checks.push(
    "share link opens a signed-in consent page and joins as an ordinary member",
  );
  const foreign = await request(
    guest,
    "/groups",
    { name: "设计体验组", avatar: null },
    "POST",
  );
  assert.equal((await request(own, "/groups/lookup")).mode, "member");
  assert(
    !(await request(own, "/groups/lookup")).items.some(
      (item: { id: string }) => item.id === foreign.id,
    ),
  );
  const blocked = await own.request.put(
    origin + `/api/v1/resources/${doc.id}/group-grants/${foreign.id}`,
    {
      headers: { origin },
      data: { revision: 1, role: "reader", includeDescendants: false },
    },
  );
  assert.equal(blocked.status(), 403);
  assert.equal(
    (
      await member.request.get(origin + "/api/v1/admin/group-directory-policy")
    ).status(),
    403,
  );
  await page.goto(origin + "/#/admin?tab=access&access=directory");
  const directorySettings = page.locator(".group-directory-settings");
  await directorySettings
    .getByRole("button", { name: "所有有效用户组", exact: false })
    .click();
  await page.waitForFunction(
    async () =>
      (await (await fetch("/api/v1/admin/group-directory-policy")).json())
        .mode === "all",
  );
  await directorySettings
    .getByRole("combobox", { name: "林小满 的用户组搜索范围" })
    .click();
  await page
    .getByRole("option", { name: "仅自己所在的用户组", exact: true })
    .click();
  await page.waitForFunction(
    async (peerId) =>
      (
        await (
          await fetch("/api/v1/admin/group-directory-policy?ids=" + peerId)
        ).json()
      ).overrides.some((row: { mode: string }) => row.mode === "member"),
    peer.id,
  );
  await page.reload();
  await directorySettings
    .getByRole("button", { name: "所有有效用户组", exact: false })
    .waitFor();
  assert.equal((await request(own, "/groups/lookup")).mode, "all");
  assert.equal((await request(member, "/groups/lookup")).mode, "member");
  assert(
    (
      await request(own, "/groups/lookup?q=" + encodeURIComponent("设计"))
    ).items.some((item: { id: string }) => item.id === foreign.id),
  );
  assert.equal(
    (await own.request.get(origin + `/api/v1/groups/${foreign.id}`)).status(),
    404,
  );
  await directorySettings.scrollIntoViewIfNeeded();
  await shot("group-directory-settings.png");
  checks.push(
    "administrator sets and persists group search scopes with per-user overrides; out-of-scope IDs and foreign rosters are rejected",
  );
  const groupService = createGroups(db);
  for (let i = 1; i <= 4; i++) {
    const extra = await createUser(
      db,
      { login: `grouppreview${i}`, displayName: `研发成员${i}`, password },
      { actor: owner },
    );
    const revision = (
      await db
        .selectFrom("user_groups")
        .select("revision")
        .where("id", "=", groupId)
        .executeTakeFirstOrThrow()
    ).revision;
    const invitation = await groupService.invite(
      owner,
      groupId,
      extra.id,
      revision,
    );
    await groupService.respond(extra, invitation.id, true);
  }
  const personalOnly = await createUser(
    db,
    { login: "personalqa", displayName: "赵一诺", password },
    { actor: owner },
  );
  const currentLibrary = await db
    .selectFrom("resources")
    .select("authz_revision")
    .where("id", "=", library.id)
    .executeTakeFirstOrThrow();
  await createContent(db).member(owner, library.id, personalOnly.id, {
    revision: currentLibrary.authz_revision!,
    role: "reader",
    includeDescendants: true,
  });
  const personalContext = await browser.newContext();
  await request(
    personalContext,
    "/auth/login",
    { login: "personalqa", password },
    "POST",
  );
  await page.goto(origin + `/#/r/${doc.id}`);
  await page.locator("[data-permissions-trigger]").waitFor();
  await page.locator("[data-permissions-trigger]").click();
  await page.locator(".permissions-invite-entry").click();
  await page
    .locator(".group-invite-tabs")
    .getByRole("button", { name: "用户组", exact: true })
    .click();
  await motionFrames(".group-invite-tabs button.active", "motion-tab");
  const groupPanel = page.locator(".group-grants");
  await groupPanel.getByRole("textbox", { name: "搜索用户组" }).fill("产品");
  await groupPanel
    .locator(".group-result")
    .filter({ hasText: "产品研发组" })
    .click();
  await setScope(groupPanel.getByRole("checkbox"), false);
  const grantRoute = `**/resources/${doc.id}/group-grants/${groupId}`;
  await page.route(
    grantRoute,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: encodeSystemError({ code: "group_conflict" }),
        }),
      }),
    { times: 1 },
  );
  await groupPanel.getByRole("button", { name: "授权", exact: true }).click();
  await page
    .getByText("用户组成员或权限已变化，请刷新后重试。", { exact: true })
    .waitFor();
  assert.match(
    await groupPanel.locator(".person-picked").innerText(),
    /产品研发组/,
  );
  checks.push(
    "failed group authorization preserves the selected group and allows retry",
  );
  await groupPanel.getByRole("button", { name: "授权", exact: true }).click();
  await page.locator(".permissions-collaborators").click();
  const removeGroup = groupPanel.getByRole("button", {
    name: "取消产品研发组的组授权",
    exact: true,
  });
  await removeGroup.waitFor();
  assert.equal(
    await groupPanel.getByRole("textbox").count(),
    0,
    "collaborator management does not show group search",
  );
  assert.equal(
    await groupPanel.getByRole("combobox").count(),
    1,
    "collaborator management only shows the existing grant's permission selector",
  );
  const inheritedPermission = page.getByRole("combobox", {
    name: "赵一诺的权限",
    exact: true,
  });
  const inheritedRow = page
    .locator(".permission-grant-row")
    .filter({ has: inheritedPermission });
  await inheritedPermission.click();
  await inheritedPermission.press("End");
  await inheritedPermission.press("ArrowUp");
  await inheritedPermission.press("Enter");
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; personalRole: string }) =>
          m.id === user && m.personalRole === "editor",
      ),
    { id: doc.id, user: personalOnly.id },
  );
  await setScope(inheritedRow.getByRole("checkbox"), false);
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; personalIncludeDescendants: boolean }) =>
          m.id === user && !m.personalIncludeDescendants,
      ),
    { id: doc.id, user: personalOnly.id },
  );
  await inheritedRow
    .getByRole("button", { name: "移除赵一诺", exact: true })
    .click();
  await page
    .locator(".permission-remove-confirm:visible")
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await inheritedRow.waitFor({ state: "hidden" });
  assert.equal(
    (
      await personalContext.request.get(origin + `/api/v1/resources/${doc.id}`)
    ).status(),
    404,
  );
  assert.equal(
    (await request(personalContext, `/resources/${library.id}`)).resource.role,
    "reader",
  );
  checks.push(
    "inherited personal grants remain editable, support a descendant boundary and can be revoked on the document while preserving the library grant",
  );
  const permission = groupPanel.getByRole("combobox", {
    name: "产品研发组 的用户组权限",
  });
  async function choosePermission(index: number) {
    await permission.scrollIntoViewIfNeeded();
    await permission.click();
    await permission.press("Home");
    for (let i = 0; i < index; i++) await permission.press("ArrowDown");
    await permission.press("Enter");
  }
  await page.route(
    grantRoute,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: encodeSystemError({ code: "group_conflict" }),
        }),
      }),
    { times: 1 },
  );
  await choosePermission(2);
  await page
    .getByText("用户组成员或权限已变化，请刷新后重试。", { exact: true })
    .waitFor();
  assert.match(await permission.innerText(), /可阅读/);
  await choosePermission(2);
  await page.waitForFunction(
    async ({ id, group }) =>
      (
        await (await fetch(`/api/v1/resources/${id}/group-grants`)).json()
      ).items.some(
        (g: { groupId: string; role: string }) =>
          g.groupId === group && g.role === "editor",
      ),
    { id: doc.id, group: groupId },
  );
  assert.equal(
    (await request(member, `/resources/${doc.id}`)).resource.role,
    "editor",
  );
  await page.waitForFunction(() => {
    const control = document.querySelector<HTMLButtonElement>(
      ".group-grant-row .select-trigger",
    );
    return control?.textContent?.includes("可编辑") && !control.disabled;
  });
  const personalPermission = page.getByRole("combobox", {
    name: "林小满的权限",
    exact: true,
  });
  const personalRow = page
    .locator(".permission-grant-row")
    .filter({ has: personalPermission });
  await personalPermission.click();
  await personalPermission.press("Home");
  await personalPermission.press("Enter");
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; role: string; personalRole: string }) =>
          m.id === user && m.role === "editor" && m.personalRole === "reader",
      ),
    { id: doc.id, user: peer.id },
  );
  await personalRow
    .getByText("生效权限：可编辑（用户组）", { exact: true })
    .waitFor();
  const effectiveStyle = await personalRow
    .locator(".permission-effective-access strong")
    .evaluate((element) => ({
      role: element.textContent,
      color: getComputedStyle(element).color,
      weight: Number(getComputedStyle(element).fontWeight),
    }));
  assert.equal(effectiveStyle.role, "可编辑");
  assert.equal(effectiveStyle.color, "rgb(70, 95, 206)");
  assert(effectiveStyle.weight >= 600);
  await setScope(personalRow.getByRole("checkbox"), true);
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; personalIncludeDescendants: boolean }) =>
          m.id === user && m.personalIncludeDescendants,
      ),
    { id: doc.id, user: peer.id },
  );
  await setScope(personalRow.getByRole("checkbox"), false);
  await personalRow
    .getByRole("button", { name: "林小满的权限来源", exact: true })
    .click();
  await page
    .locator(".permissions-source-list")
    .getByText("来自用户组 · 产品研发组", { exact: true })
    .waitFor();
  await page
    .locator(".permissions-source-list")
    .getByText("主动授权", { exact: true })
    .waitFor();
  const directSource = page
    .locator(".permissions-source-card")
    .filter({ hasText: "主动授权" });
  const sourcePermission = directSource.getByRole("combobox");
  const sourceGeometry = await directSource.evaluate((row) => {
    const card = row.getBoundingClientRect();
    const identity = row
      .querySelector(".permission-grant-identity")!
      .getBoundingClientRect();
    const controls = row
      .querySelector(".permission-grant-controls")!
      .getBoundingClientRect();
    return {
      rightGap: card.right - controls.right,
      sameLine: controls.top < identity.bottom,
    };
  });
  assert(
    sourceGeometry.sameLine && sourceGeometry.rightGap <= 14,
    JSON.stringify(sourceGeometry),
  );
  await sourcePermission.click();
  await sourcePermission.press("Home");
  await sourcePermission.press("ArrowDown");
  await sourcePermission.press("Enter");
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; personalRole: string; role: string }) =>
          m.id === user &&
          m.personalRole === "commenter" &&
          m.role === "editor",
      ),
    { id: doc.id, user: peer.id },
  );
  await sourcePermission.click();
  await sourcePermission.press("Home");
  await sourcePermission.press("Enter");
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (
          await fetch(`/api/v1/resources/${id}/permission-overview`)
        ).json()
      ).members.some(
        (m: { id: string; personalRole: string }) =>
          m.id === user && m.personalRole === "reader",
      ),
    { id: doc.id, user: peer.id },
  );
  await directSource
    .getByRole("button", { name: "删除来源", exact: true })
    .click();
  await page
    .locator(".permission-remove-confirm:visible")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page
    .locator(".permission-remove-confirm")
    .waitFor({ state: "detached" });
  await sourcePermission.waitFor();
  checks.push(
    "source details share the right-aligned role/delete controls, persist source edits without changing group access, and cancel deletion without writing; effective group roles are bold blue",
  );
  await page.screenshot({
    path: join(output, "document-personal-sources.png"),
    fullPage: true,
  });
  await page.locator(".permissions-heading button").click();
  await personalRow
    .getByRole("button", { name: "移除林小满", exact: true })
    .click();
  const personalConfirmation = page.locator(
    ".permission-remove-confirm:visible",
  );
  await personalConfirmation
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    (
      await request(own, `/resources/${doc.id}/permission-overview`)
    ).members.find((m: { id: string }) => m.id === peer.id).personalRole,
    "reader",
  );
  await personalRow
    .getByRole("button", { name: "移除林小满", exact: true })
    .click();
  await waitConfirmationBubble();
  await shot("document-personal-remove-popover.png");
  await personalConfirmation
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await personalRow.getByText("仅用户组授权", { exact: true }).waitFor();
  assert.equal(
    (await request(member, `/resources/${doc.id}`)).resource.role,
    "editor",
  );
  assert(
    await personalRow
      .getByRole("button", { name: "移除林小满", exact: true })
      .isDisabled(),
  );
  checks.push(
    "personal rows support role and descendant edits, list independent sources, use a confirmation bubble, and retain group access after removing personal authorization",
  );
  await page.reload();
  await page.locator("[data-permissions-trigger]").click();
  await page.locator(".permissions-collaborators").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".group-grant-row .permission-grant-role .select-trigger")
      ?.textContent?.includes("可编辑"),
  );
  assert.equal(
    (await request(own, `/resources/${doc.id}/group-grants`)).items[0]
      .includeDescendants,
    false,
    "role editing preserves the grant scope",
  );
  await choosePermission(0);
  await page.waitForFunction(() =>
    document
      .querySelector(".group-grant-row .permission-grant-role .select-trigger")
      ?.textContent?.includes("可阅读"),
  );
  await setScope(groupPanel.getByRole("checkbox"), true);
  await page.waitForFunction(
    async (id) =>
      (await (await fetch(`/api/v1/resources/${id}/group-grants`)).json())
        .items[0]?.includeDescendants === true,
    doc.id,
  );
  await setScope(groupPanel.getByRole("checkbox"), false);
  await page.waitForFunction(
    async (id) =>
      (await (await fetch(`/api/v1/resources/${id}/group-grants`)).json())
        .items[0]?.includeDescendants === false,
    doc.id,
  );
  const beforeCancel = await request(own, `/resources/${doc.id}/group-grants`);
  await removeGroup.click();
  const confirmation = page.locator(".permission-remove-confirm:visible");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(
    await request(own, `/resources/${doc.id}/group-grants`),
    beforeCancel,
    "canceling deletion leaves the permission and revision unchanged",
  );
  await removeGroup.click();
  await waitConfirmationBubble();
  await shot("resource-group-remove-confirm.png");
  await page.route(
    grantRoute,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: encodeSystemError({ code: "group_conflict" }),
        }),
      }),
    { times: 1 },
  );
  await confirmation
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await page
    .getByText("用户组成员或权限已变化，请刷新后重试。", { exact: true })
    .waitFor();
  assert.deepEqual(
    await request(own, `/resources/${doc.id}/group-grants`),
    beforeCancel,
  );
  await confirmation.waitFor();
  await confirmation
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await groupPanel.getByText("尚未向用户组授权", { exact: true }).waitFor();
  assert.equal(
    (await member.request.get(origin + `/api/v1/resources/${doc.id}`)).status(),
    404,
  );
  const revokedGrant = await request(own, `/resources/${doc.id}/group-grants`);
  await request(
    own,
    `/resources/${doc.id}/group-grants/${groupId}`,
    {
      revision: revokedGrant.revision,
      role: "reader",
      includeDescendants: false,
    },
    "PUT",
  );
  await page.reload();
  await page.locator("[data-permissions-trigger]").click();
  await page.locator(".permissions-collaborators").click();
  await removeGroup.waitFor();
  checks.push(
    "document group permission edits persist after reload and preserve scope; failed edits retain the role; deletion requires confirmation, cancel preserves authorization, and confirm revokes access",
  );
  const memberPreview = groupPanel.locator(".group-grant-members");
  await memberPreview
    .getByRole("button", { name: "更多（+4）", exact: true })
    .waitFor();
  assert.equal(await memberPreview.locator(".group-grant-member").count(), 3);
  await memberPreview
    .getByRole("button", { name: "更多（+4）", exact: true })
    .click();
  await memberPreview
    .getByRole("button", { name: "收起", exact: true })
    .waitFor();
  const avatarPanel = page.locator(".group-grant-member-panel");
  await avatarPanel.waitFor();
  assert.equal(await avatarPanel.locator(".group-grant-member").count(), 7);
  assert.equal(await memberPreview.locator(".group-grant-member").count(), 3);
  await avatarPanel
    .getByRole("button", { name: "研发成员1", exact: true })
    .hover();
  const memberCard = page.getByRole("dialog", {
    name: "用户资料",
    exact: true,
  });
  await memberCard.getByText("研发成员1", { exact: true }).waitFor();
  await memberCard
    .getByRole("button", { name: "关闭用户资料", exact: true })
    .click();
  await avatarPanel.waitFor();
  await groupPanel.waitFor();
  await page.screenshot({
    path: join(output, "resource-group-members-expanded.png"),
    fullPage: true,
  });
  await memberPreview
    .getByRole("button", { name: "收起", exact: true })
    .click();
  assert.equal(await memberPreview.locator(".group-grant-member").count(), 3);
  checks.push(
    "resource group preview uses three avatars, more opens seven avatar cards without increasing the row height, and closing a profile keeps the permission panel open",
  );
  const rowGeometry = await page
    .locator(".permission-grant-row")
    .evaluateAll((rows) =>
      rows.map((row) => {
        const scope = row
          .querySelector(".permission-grant-scope")
          ?.getBoundingClientRect();
        const secondary = row
          .querySelector(".permission-grant-secondary")!
          .getBoundingClientRect();
        return {
          height: (row as HTMLElement).offsetHeight,
          scopeOnSecondLine:
            !scope ||
            (scope.top >= secondary.top &&
              scope.bottom <= secondary.bottom + 1),
        };
      }),
    );
  assert(
    rowGeometry.every((row) => row.height <= 82 && row.scopeOnSecondLine),
    JSON.stringify(rowGeometry),
  );
  assert(
    !(await memberPreview.innerText()).includes("周知远"),
    "group preview does not render member names",
  );
  await memberPreview
    .getByRole("button", { name: "林小满", exact: true })
    .hover();
  const previewCard = page.getByRole("dialog", {
    name: "用户资料",
    exact: true,
  });
  await previewCard.getByText("@groupqapeer", { exact: true }).waitFor();
  await shot("group-member-avatar-card.png");
  await previewCard
    .getByRole("button", { name: "关闭用户资料", exact: true })
    .click();
  await groupPanel.waitFor();
  checks.push(
    "all authorization rows stay within two compact lines, with scope beside metadata and working avatar profile cards",
  );
  await page.screenshot({
    path: join(output, "resource-group-permission.png"),
    fullPage: true,
  });
  assert.equal(
    (await request(member, `/resources/${doc.id}`)).resource.role,
    "reader",
  );
  checks.push(
    "resource permission UI grants the group and the peer immediately reads the document",
  );
  const folderId = randomUUID(),
    folderTime = new Date().toISOString();
  await db
    .insertInto("file_folders")
    .values({
      id: folderId,
      owner_id: owner.id,
      parent_id: "shared",
      name: "组成员预览资料",
      version: 1,
      created_at: folderTime,
      updated_at: folderTime,
      deleted_at: null,
      delete_batch: null,
    })
    .execute();
  await createGroupGrants(db).set(owner, folderId, groupId, true, {
    revision: 1,
    role: "reader",
    includeDescendants: true,
  });
  await page.goto(
    origin +
      `/#/shared-files/${folderId}?name=${encodeURIComponent("组成员预览资料")}`,
  );
  await page.locator("[data-permissions-trigger]").click();
  await page.locator(".permissions-collaborators").click();
  const folderPreview = page.locator(".group-grant-members");
  await folderPreview
    .getByRole("button", { name: "更多（+4）", exact: true })
    .waitFor();
  assert.equal(await folderPreview.locator(".group-grant-member").count(), 3);
  await choosePermission(1);
  await page.waitForFunction(() =>
    document
      .querySelector(".group-grant-row .permission-grant-role .select-trigger")
      ?.textContent?.includes("可管理"),
  );
  assert.equal(
    (await request(own, `/files/folders/${folderId}/group-grants`)).items[0]
      .role,
    "admin",
  );
  await choosePermission(0);
  await page.waitForFunction(() =>
    document
      .querySelector(".group-grant-row .permission-grant-role .select-trigger")
      ?.textContent?.includes("可阅读"),
  );
  const folderPersonal = page.getByRole("combobox", {
    name: "林小满的权限",
    exact: true,
  });
  const folderPersonalRow = page
    .locator(".permission-grant-row")
    .filter({ has: folderPersonal });
  await folderPersonal.click();
  await folderPersonal.press("End");
  await folderPersonal.press("Enter");
  await page.waitForFunction(
    async ({ id, user }) =>
      (
        await (await fetch(`/api/v1/files/folders/${id}/shares`)).json()
      ).members.some(
        (m: { user_id: string; personalRole: string }) =>
          m.user_id === user && m.personalRole === "admin",
      ),
    { id: folderId, user: peer.id },
  );
  await folderPersonalRow
    .getByRole("button", { name: "林小满的权限来源", exact: true })
    .click();
  await page
    .locator(".permissions-source-list")
    .getByText("来自用户组 · 产品研发组", { exact: true })
    .waitFor();
  await page.locator(".permissions-heading button").click();
  await folderPersonalRow
    .getByRole("button", { name: "移除林小满", exact: true })
    .click();
  await page
    .locator(".permission-remove-confirm:visible")
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await folderPersonalRow.getByText("仅用户组授权", { exact: true }).waitFor();
  const folderReaderView = await request(
    member,
    `/files/folders/${folderId}/shares`,
  );
  assert.equal(folderReaderView.role, "reader");
  assert.equal(
    folderReaderView.members.length,
    0,
    "readers cannot enumerate group-only collaborators",
  );
  checks.push(
    "shared folders use the same personal role/source/delete controls, preserve group access and keep group-only rosters hidden from readers",
  );
  await folderPreview.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, "folder-group-members-preview.png"),
    fullPage: true,
  });
  await folderPreview
    .getByRole("button", { name: "更多（+4）", exact: true })
    .click();
  await folderPreview
    .getByRole("button", { name: "收起", exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".group-grant-member-panel .group-grant-member").count(),
    7,
  );
  await page
    .locator(".permission-remove-confirm")
    .waitFor({ state: "detached" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".feedback-toast button")
    .evaluateAll((buttons) =>
      buttons.forEach((button) => (button as HTMLButtonElement).click()),
    );
  await page
    .locator(".permissions-body")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForFunction(() => {
    const popup = document.querySelector(".group-grant-member-panel");
    if (!popup) return false;
    const rect = popup.getBoundingClientRect();
    return (
      rect.left >= 0 &&
      rect.right <= innerWidth &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight
    );
  });
  await page.screenshot({
    path: join(output, "folder-group-members-mobile.png"),
    fullPage: true,
  });
  const previewWidth = await page
    .locator(".permissions-panel")
    .evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }));
  assert(
    previewWidth.scroll <= previewWidth.width,
    "expanded group members fit the narrow permission panel",
  );
  await folderPreview
    .getByRole("button", { name: "收起", exact: true })
    .click();
  await page
    .locator(".group-grant-member-panel")
    .waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await removeGroup.click();
  await confirmation
    .getByRole("button", { name: "取消授权", exact: true })
    .click();
  await groupPanel.getByText("尚未向用户组授权", { exact: true }).waitFor();
  assert.equal(
    (await request(own, `/files/folders/${folderId}/group-grants`)).items
      .length,
    0,
  );
  checks.push(
    "shared-folder group roles change inline and confirmed deletion removes the grant",
  );
  checks.push(
    "shared-folder group members support the same preview/expand interaction and fit the narrow panel",
  );
  const peerDocument = await member.newPage();
  let joined = false;
  let socketClosed = false;
  peerDocument.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "sync-response" && message.room === doc.id)
        joined = true;
    });
    socket.on("close", () => {
      socketClosed = true;
    });
  });
  await peerDocument.goto(origin + `/#/r/${doc.id}`);
  for (let attempt = 0; attempt < 100 && !joined; attempt++)
    await peerDocument.waitForTimeout(100);
  assert(joined, "peer websocket joined the group-authorized document");
  await peerPage.goto(origin + `/#/groups/${groupId}`);
  await peerPage
    .getByRole("button", { name: "退出用户组", exact: true })
    .waitFor();
  peerPage.once("dialog", (dialog) => void dialog.accept());
  await peerPage
    .getByRole("button", { name: "退出用户组", exact: true })
    .click();
  await peerPage.locator(".groups-empty").waitFor();
  const denied = await member.request.get(
    origin + `/api/v1/resources/${doc.id}`,
  );
  assert.equal(denied.status(), 404);
  checks.push("leaving the group immediately removes document access");
  for (let attempt = 0; attempt < 100 && !socketClosed; attempt++)
    await peerDocument.waitForTimeout(100);
  assert(
    socketClosed,
    "group revocation closes the peer's existing document connection",
  );
  checks.push(
    "group membership revocation closes an already joined document websocket",
  );
  await page.goto(origin + `/#/groups/${groupId}`);
  await page.locator(".group-members").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("group-members-mobile.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "mobile horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  assert(
    await page
      .locator(".group-heading h1")
      .evaluate((el) => el.clientHeight < 70),
    "zoomed group title remains readable without a vertical word stack",
  );
  await page.screenshot({
    path: join(output, "group-members-zoom.png"),
    fullPage: true,
  });
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      { passed: true, motion, checks, errors, groupId, peerId: peer.id },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (let index = 0; index < pages.length; index++)
    await pages[index]!.screenshot({
      path: join(output, `failure-${index}.png`),
      fullPage: true,
    }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await web?.close();
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
}
