// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTranslator } from "@doca/i18n";
import { BrowserClipperSettings } from "@web/features/browser-clipper/browser-clipper-settings.js";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@web/shared/api.js", () => ({ api }));
vi.mock("@web/shared/i18n.js", () => ({
  useI18n: () => ({ t: createTranslator("zh"), locale: "zh" }),
}));
vi.mock("@web/features/browser-clipper/clipper-destination-tree.js", () => ({
  ClipperDestinationTree: () => null,
}));
vi.mock("@web/features/documents/dialogs.js", () => ({ Dialog: () => null }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const release = {
  version: "0.2.10",
  filename: "doca-browser-assistant-0.2.10.zip",
};
const flush = async () => {
  for (let index = 0; index < 3; index++)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "/browser-clipper/release" ? release : { items: [] },
    );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("displays the site's package version and downloads using the response's actual versioned filename", async () => {
  const downloads: string[] = [];
  const createObjectURL = vi.fn(() => "blob:fixture");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      headers: new Headers({
        "Content-Disposition":
          'attachment; filename="doca-browser-assistant-0.2.11.zip"',
      }),
      blob: async () => new Blob(["package"]),
    })),
  );
  await act(() => root.render(createElement(BrowserClipperSettings)));
  await flush();
  expect(host.querySelector(".clipper-download strong")?.textContent).toBe(
    "Doca 浏览器助手 v0.2.10",
  );
  expect(host.querySelector(".clipper-package-filename")?.textContent).toBe(
    release.filename,
  );
  const button = host.querySelector<HTMLButtonElement>(
    ".clipper-download .primary",
  )!;
  expect(button.textContent).toContain("下载扩展 v0.2.10");
  await act(() => button.click());
  await flush();
  expect(downloads).toEqual(["doca-browser-assistant-0.2.11.zip"]);
  expect(host.querySelector(".clipper-package-filename")?.textContent).toBe(
    "doca-browser-assistant-0.2.11.zip",
  );
});

it("keeps downloads disabled when the package version cannot be verified, and offers a retry", async () => {
  api.mockImplementation(async (path: string) => {
    if (path === "/browser-clipper/release") throw Error("offline");
    return { items: [] };
  });
  await act(() => root.render(createElement(BrowserClipperSettings)));
  await flush();
  expect(
    host.querySelector<HTMLButtonElement>(".clipper-download .primary")!
      .disabled,
  ).toBe(true);
  expect(
    host.querySelector(".clipper-download [role=alert]")?.textContent,
  ).toContain("无法读取插件包版本");
  api.mockImplementation(async (path: string) =>
    path === "/browser-clipper/release" ? release : { items: [] },
  );
  await act(() =>
    host
      .querySelector<HTMLButtonElement>(
        ".clipper-download [role=alert] button",
      )!
      .click(),
  );
  await flush();
  expect(
    host.querySelector<HTMLButtonElement>(".clipper-download .primary")!
      .disabled,
  ).toBe(false);
  expect(host.querySelector(".clipper-package-filename")?.textContent).toBe(
    release.filename,
  );
});
