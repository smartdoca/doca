// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserClipperSettings } from "@web/features/browser-clipper/browser-clipper-settings.js";
import { FeedbackViewport } from "@web/shared/components/feedback.js";
import type { Resource } from "@web/shared/api.js";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@web/shared/api.js", () => ({
  api,
  roleRank: (role: string) =>
    ({ none: 0, reader: 1, commenter: 2, editor: 3, manager: 4, owner: 5 })[
      role
    ] ?? 0,
}));
vi.mock("@web/shared/i18n.js", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "zh" }),
}));
vi.mock("@web/features/documents/document-controls.js", () => ({
  FileIcon: () => null,
}));
vi.mock("@web/features/documents/person-picker.js", () => ({
  PersonPicker: () => null,
}));
vi.mock("@web/features/documents/permissions-panel.js", () => ({
  PermissionDialog: () => null,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function resource(id: string, changes: Partial<Resource> = {}): Resource {
  return {
    id,
    title: id,
    kind: "document",
    format: "markdown",
    owner_id: "owner",
    library_id: "library",
    parent_id: null,
    role: "editor",
    version: 1,
    access_mode: "inherit",
    visibility: "invited",
    created_at: "2026-10-24T00:00:00Z",
    updated_at: "2026-10-24T00:00:00Z",
    deleted_at: null,
    ...changes,
  };
}
const library = resource("library", { kind: "library", library_id: null });
const parent = resource("parent");
const child = resource("child", { parent_id: parent.id });
let profile: any,
  libraryPages: Resource[][],
  documents: Record<string, Resource[]>,
  failTree: boolean,
  failSave: boolean;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const flush = async () => {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
};
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (node) => node.textContent === label,
  )!;
const title = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(".ant-tree-title")).find(
    (node) => node.textContent === label,
  )!;
async function clickTitle(label: string) {
  await act(() =>
    title(label)
      .closest<HTMLElement>(".ant-tree-node-content-wrapper")!
      .click(),
  );
  await flush();
}
async function open() {
  await act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(BrowserClipperSettings),
        createElement(FeedbackViewport),
      ),
    ),
  );
  await flush();
  await act(() => button("clipper.edit").click());
  await flush();
}
async function save() {
  await act(() =>
    document
      .querySelector(".clipper-form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await flush();
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  profile = {
    id: "profile",
    revision: 1,
    name: "Capture",
    enabled: true,
    isDefault: true,
    strategy: "create",
    libraryId: null,
    parentId: null,
    targetId: null,
    titleTemplate: "{title}",
    aiInstruction: "",
    destinationTitle: null,
  };
  libraryPages = [[library]];
  documents = { library: [parent, child] };
  failTree = failSave = false;
  api.mockImplementation(
    async (path: string, method = "GET", body?: unknown) => {
      if (path === "/me/browser-clipper/profiles") return { items: [profile] };
      if (path === "/me/browser-clipper/connections") return { items: [] };
      if (path === "/me/browser-clipper/profiles/profile" && method === "PUT") {
        if (failSave) throw Error("clipper_profile_changed");
        profile = {
          ...profile,
          ...(body as object),
          revision: profile.revision + 1,
        };
        return profile;
      }
      const [route, query] = path.split("?");
      const params = new URLSearchParams(query);
      if (route === "/resources" && params.get("kind") === "library") {
        const index = Number(params.get("cursor") ?? 0);
        return {
          items: libraryPages[index],
          nextCursor:
            index + 1 < libraryPages.length ? String(index + 1) : null,
          total: libraryPages.flat().length,
        };
      }
      if (route === "/resources" && params.get("tree") === "true") {
        if (failTree) throw Error("Directory request failed");
        return {
          items: documents[params.get("libraryId")!],
          nextCursor: null,
          truncated: false,
        };
      }
      if (path === "/resources/library")
        return { resource: { ...library, knowledgeBook: false } };
      if (
        path === "/me/browser-clipper/destinations?kind=document" ||
        (route === "/me/browser-clipper/destinations" &&
          params.get("kind") === "document")
      )
        return {
          items: [
            {
              id: child.id,
              title: child.title,
              kind: child.kind,
              format: child.format,
              libraryId: child.library_id,
              parentId: child.parent_id,
            },
          ],
          nextCursor: null,
        };
      throw Error("Unexpected API: " + path);
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("loads libraries separately, selects a nested editable document and saves the exact location", async () => {
  await open();
  expect(
    api.mock.calls.some(
      ([path]) => path === "/resources?scope=all&kind=library",
    ),
  ).toBe(true);
  expect(
    api.mock.calls.some(
      ([path]) => path === "/me/browser-clipper/destinations",
    ),
  ).toBe(false);
  await clickTitle("library");
  await clickTitle("parent");
  await clickTitle("child");
  await save();
  expect(profile).toMatchObject({
    libraryId: "library",
    parentId: "child",
    targetId: null,
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("can save a library root and then return to personal documents without retaining a parent", async () => {
  await open();
  await clickTitle("library");
  await save();
  expect(profile).toMatchObject({ libraryId: "library", parentId: null });
  await act(() => button("clipper.edit").click());
  await flush();
  await clickTitle("clipper.personal");
  await save();
  expect(profile).toMatchObject({ libraryId: null, parentId: null });
});

it("restores and expands a saved deep location even when its library is beyond the first page", async () => {
  libraryPages = [[]];
  profile.libraryId = "library";
  profile.parentId = "child";
  await open();
  expect(
    title("child")
      .closest(".ant-tree-treenode")
      ?.querySelector(".ant-tree-node-selected"),
  ).not.toBeNull();
  expect(button("clipper.save").disabled).toBe(false);
  expect(profile.parentId).toBe("child");
});

it("keeps library pagination independent and loads the newly selected library's outline", async () => {
  libraryPages = [[], [library]];
  await open();
  await act(() => button("clipper.moreLibraries").click());
  await flush();
  await clickTitle("library");
  expect(title("parent")).toBeTruthy();
  expect(
    api.mock.calls.some(([path]) =>
      String(path).includes("kind=library&cursor=1"),
    ),
  ).toBe(true);
});

it("retains a saved location after a failed directory load and allows an explicit retry", async () => {
  profile.libraryId = "library";
  profile.parentId = "child";
  failTree = true;
  await open();
  expect(button("clipper.save").disabled).toBe(true);
  expect(document.body.textContent).toContain("Directory request failed");
  expect(profile.parentId).toBe("child");
  failTree = false;
  await act(() => button("clipper.retryDestinations").click());
  await flush();
  expect(button("clipper.save").disabled).toBe(false);
  expect(title("child")).toBeTruthy();
});

it("does not silently replace a read-only saved parent with personal documents", async () => {
  profile.libraryId = "library";
  profile.parentId = "child";
  documents.library = [parent, { ...child, role: "reader" }];
  await open();
  expect(button("clipper.save").disabled).toBe(true);
  expect(document.body.textContent).toContain("clipper.unavailable");
  expect(profile).toMatchObject({ libraryId: "library", parentId: "child" });
});

it("preserves the selected tree position when saving the profile fails", async () => {
  await open();
  await clickTitle("library");
  await clickTitle("parent");
  failSave = true;
  await save();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(
    title("parent")
      .closest(".ant-tree-treenode")
      ?.querySelector(".ant-tree-node-selected"),
  ).not.toBeNull();
  expect(document.body.textContent).toContain(
    "clipper.error.clipper_profile_changed",
  );
  failSave = false;
  await save();
  expect(profile).toMatchObject({ libraryId: "library", parentId: "parent" });
});

it("loads append targets when changing save strategy and clears the previous creation location", async () => {
  await open();
  await clickTitle("library");
  await clickTitle("parent");
  const strategy =
    document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  await act(() => strategy.click());
  await act(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((node) => node.textContent?.includes("clipper.append"))!
      .click(),
  );
  await flush();
  expect(document.querySelector(".clipper-destination")).toBeNull();
  const target = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
  ).at(-1)!;
  await act(() => target.click());
  await act(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((node) => node.textContent?.includes("child"))!
      .click(),
  );
  await save();
  expect(profile).toMatchObject({
    strategy: "append",
    libraryId: null,
    parentId: null,
    targetId: "child",
  });
});
