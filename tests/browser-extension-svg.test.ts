import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
// @ts-expect-error jsdom is a runtime-only fixture dependency.
import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../apps/browser-extension/svg-image.js", import.meta.url),
  "utf8",
);
function sanitize(svg: string) {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  try {
    dom.window.eval(source);
    return (dom.window as any).DocaSvgImage.sanitize(svg);
  } finally {
    dom.window.close();
  }
}
it("keeps SVG paths, embedded styles, local gradients and transparency within bounded raster dimensions", () => {
  const result = sanitize(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12000 3000"><style>.logo{fill:url(#paint)}</style><defs><linearGradient id="paint"><stop stop-color="#3370ff"/></linearGradient></defs><path class="logo" d="M0 0h100v100z"/></svg>`,
  );
  expect(result).toMatchObject({ width: 4096, height: 1024 });
  expect(result.text).toContain("fill:url(#paint)");
  expect(result.text).toContain('class="logo"');
  expect(result.text).not.toContain("background");
});
it("removes SVG scripts and event handlers without mounting source markup", () => {
  const result = sanitize(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" onclick="alert(3)"/></svg>`,
  );
  expect(result.text).not.toMatch(/script|onload|onclick|alert/);
  expect(result).toMatchObject({ width: 32, height: 20 });
});
for (const body of [
  `<image href="https://external.test/private.png"/>`,
  `<use href="https://external.test/private.svg#icon"/>`,
  `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>`,
  `<style>@import 'https://external.test/private.css';</style>`,
  `<rect style="fill:u\\72l(https://external.test/private.svg)"/>`,
  `<rect fill="url(https://external.test/private.svg)"/>`,
  `<g xml:base="https://external.test/"><use href="#icon"/></g>`,
  `<animate attributeName="x"/>`,
])
  it(`rejects SVG dependencies or unsupported visual content: ${body.slice(0, 42)}`, () => {
    expect(() =>
      sanitize(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`),
    ).toThrow("clipper_image_invalid");
  });
it("rejects entities, malformed XML and excessive input dimensions before rendering", () => {
  for (const svg of [
    `<!DOCTYPE svg [<!ENTITY x SYSTEM "https://external.test/">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><path></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>`,
    `<html/>`,
  ])
    expect(() => sanitize(svg)).toThrow("clipper_image_invalid");
});
