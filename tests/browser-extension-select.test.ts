import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
// @ts-expect-error jsdom is a runtime-only fixture dependency in this workspace.
import { JSDOM } from "jsdom";
const source = await readFile(
  new URL("../apps/browser-extension/select.js", import.meta.url),
  "utf8",
);
function fixture(shadow = false) {
  const dom = new JSDOM("<main></main><button id='outside'>Outside</button>", {
    url: "https://fixture.test",
    runScripts: "outside-only",
  });
  const { document, KeyboardEvent, MouseEvent } = dom.window;
  const root = shadow
    ? document.querySelector("main")!.attachShadow({ mode: "closed" })
    : document.querySelector("main")!;
  root.innerHTML =
    '<label><span>Profile</span><select><option value="a">Default</option><option value="b" disabled>Unavailable</option><option value="c">Other</option></select></label><button id="inside">Inside</button>';
  dom.window.eval(source);
  const select = root.querySelector("select")!,
    controller = (dom.window as any).DocaSelect.enhance(select),
    trigger = root.querySelector("[role=combobox]")!,
    menu = root.querySelector("[role=listbox]")!;
  return {
    dom,
    root,
    select,
    controller,
    trigger,
    menu,
    key: (key: string) =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      ),
    pointer: (node: Element) =>
      node.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, composed: true }),
      ),
  };
}
it("supports keyboard selection, skips disabled options, closes on Escape, and restores trigger focus", () => {
  const f = fixture();
  let changed = 0;
  f.select.onchange = () => changed++;
  expect(f.select.hidden).toBe(true);
  f.key("ArrowDown");
  f.key("ArrowDown");
  f.key("Enter");
  expect(f.select.value).toBe("c");
  expect(changed).toBe(1);
  expect(f.menu.hidden).toBe(true);
  expect(f.dom.window.document.activeElement).toBe(f.trigger);
  f.key("Enter");
  f.key("Home");
  f.key("Escape");
  expect(f.select.value).toBe("c");
  expect(f.trigger.getAttribute("aria-expanded")).toBe("false");
  f.controller.destroy();
  f.dom.window.close();
});
it("synchronizes dynamic options and disabled state without a native browser picker", async () => {
  const f = fixture();
  f.select.innerHTML = '<option value="new">新方案 · 默认</option>';
  f.select.disabled = true;
  await Promise.resolve();
  expect(f.trigger.textContent).toContain("新方案 · 默认");
  expect(f.trigger.disabled).toBe(true);
  f.key("ArrowDown");
  expect(f.menu.hidden).toBe(true);
  f.controller.destroy();
  f.dom.window.close();
});
it("keeps shadow dropdown clicks open and closes on clicks inside or outside the isolated toolbar", () => {
  const f = fixture(true);
  f.key("Enter");
  f.pointer(f.trigger);
  expect(f.menu.hidden).toBe(false);
  expect(f.menu.parentNode).toBe(f.root);
  f.pointer(f.menu.children[2]!);
  expect(f.menu.hidden).toBe(false);
  (f.menu.children[2] as HTMLElement).click();
  expect(f.select.value).toBe("c");
  expect(f.menu.hidden).toBe(true);
  f.key("Enter");
  f.pointer(f.root.querySelector("#inside")!);
  expect(f.menu.hidden).toBe(true);
  f.key("Enter");
  f.pointer(f.dom.window.document.querySelector("#outside")!);
  expect(f.menu.hidden).toBe(true);
  f.controller.destroy();
  f.dom.window.close();
});
