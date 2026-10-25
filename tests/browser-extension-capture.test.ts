import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importMarkdown } from "@smartdoca/slate/conversion";
// @ts-expect-error jsdom is a runtime-only fixture dependency in this workspace.
import { JSDOM } from "jsdom";
const script = await readFile(
  new URL("../apps/browser-extension/capture.js", import.meta.url),
  "utf8",
);
function document(html: string) {
  const dom = new JSDOM(html, {
    url: "https://web.example.test/path/article",
    runScripts: "outside-only",
  });
  Object.assign(dom.window, { TextEncoder });
  dom.window.eval(script);
  return { dom, capture: (dom.window as any).DocaCapture.capture };
}
it("captures semantic page structure, links and explicit image manifests without scripts, form secrets or page styles", () => {
  const { dom, capture } = document(
    `<title>中文文章</title><article><h1>设备故障</h1><p><strong>断电</strong>后检查<a href='../guide'>说明</a></p><pre><code>const key = 'example';\nnext();</code></pre><table><tr><th>项目</th><th>状态</th></tr><tr><td>电源</td><td>正常</td></tr></table><img src='/original.png' alt='原图'></article><form><input value='secret-password'><p>private-form-data</p></form><script>secret-script()</script><style>.secret{display:none}</style>`,
  );
  const value = capture("page");
  expect(value.title).toBe("中文文章");
  expect(value.markdown).toContain("# 设备故障");
  expect(value.markdown).toContain("**断电**");
  expect(value.markdown).toContain("https://web.example.test/guide");
  expect(value.markdown).toContain("| 项目 | 状态 |");
  expect(value.images).toHaveLength(1);
  expect(value.images[0].url).toBe("https://web.example.test/original.png");
  expect(value.markdown).toContain(
    "https://clipper.invalid/images/" + value.images[0].id,
  );
  for (const secret of [
    "secret-password",
    "private-form-data",
    "secret-script",
    "display:none",
  ])
    expect(value.markdown).not.toContain(secret);
  dom.window.close();
});
it("uses the selected range and the browser's current image source rather than capturing unrelated content", () => {
  const { dom, capture } = document(
    `<title>Selection</title><p id='before'>unselected before</p><section id='selected'><h2>选区</h2><p>selected text</p><img src='/small.png'></section><p>unselected after</p>`,
  );
  const image = dom.window.document.querySelector("img")!;
  Object.defineProperty(image, "currentSrc", {
    value: "https://cdn.example.test/full.png",
  });
  const range = dom.window.document.createRange();
  range.selectNodeContents(dom.window.document.getElementById("selected")!);
  const value = capture("selection", range);
  expect(value.markdown).toContain("selected text");
  expect(value.markdown).not.toContain("unselected");
  expect(value.images[0].url).toBe("https://cdn.example.test/full.png");
  dom.window.close();
});

it("captures inline SVG with its styles as an image while excluding hidden tracking pixels", () => {
  const { dom, capture } = document(
    `<article><h1>Vector figure</h1><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><title>Chart</title><style>.bar{fill:blue}</style><rect class="bar" width="30" height="40"/></svg><img src="/pixel.gif" style="display:none"></article>`,
  );
  const result = capture("page");
  expect(result.images).toHaveLength(1);
  expect(result.images[0].name).toBe("image.svg");
  expect(decodeURIComponent(result.images[0].url)).toContain(".bar{fill:blue}");
  expect(result.markdown).toContain("![Chart](https://clipper.invalid/images/");
  expect(result.markdown).not.toContain("pixel.gif");
  dom.window.close();
});

it("imports linked sponsor images and inline SVG without conversion warnings or losing their targets", async () => {
  const { dom, capture } = document(
    `<article><h1>Linked figures</h1><a href="/publisher"><img src="/logo.png" alt="Publisher"></a><a href="/sponsor"><picture><img src="/sponsor.jpg" alt="Sponsor"></picture></a><a href="/chart"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Chart</title><style>.bar{fill:blue}</style><rect class="bar" width="20" height="20"/></svg></a><a href="/details"><strong>Figure details</strong><img src="/detail.png"></a><p>Article ending.</p></article>`,
  );
  try {
    const result = capture("page");
    const imported: string[] = [];
    let markdown = result.markdown;
    for (const image of result.images)
      markdown = markdown.replaceAll(
        "https://clipper.invalid/images/" + image.id,
        image.id,
      );
    const converted = await importMarkdown(markdown, {
      resources: {
        signal: new AbortController().signal,
        async importResource(request) {
          imported.push(request.path!);
          return "assets/" + request.path;
        },
      },
    });
    expect(converted.warnings).toEqual([]);
    expect(imported).toEqual(
      result.images.map((image: { id: string }) => image.id),
    );
    const model = JSON.stringify(converted.initialValue);
    expect(model.match(/"type":"image"/g)).toHaveLength(4);
    for (const target of ["publisher", "sponsor", "chart", "details"])
      expect(model).toContain("https://web.example.test/" + target);
    expect(model).toContain("Article ending.");
    expect(result.markdown).not.toContain("[![");
    expect(result.markdown).toContain("[Chart](https://web.example.test/chart)");
    expect(result.markdown).not.toContain(".bar{fill:blue}");
  } finally {
    dom.window.close();
  }
});
