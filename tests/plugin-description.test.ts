import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PluginDescription } from "../apps/web/src/features/admin/plugin-description.js";
import { LocaleProvider } from "../apps/web/src/shared/i18n.js";

function renderImage(src: string) {
  return renderToStaticMarkup(createElement(LocaleProvider, null,
    createElement(PluginDescription, { description: {
      format: "doca-slate", version: 1,
      nodes: [{ type: "image", src, alt: "preview", children: [{ text: "" }] }],
    } }),
  ));
}

it.each([300 * 1024, 1024 * 1024])("renders protocol images of %i bytes", (size) => {
  const src = `data:image/png;base64,${Buffer.alloc(size).toString("base64")}`;
  expect(renderImage(src)).toContain(`<img src="${src}"`);
});

it("rejects images exceeding the decoded 1 MiB limit", () => {
  const src = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`;
  expect(renderImage(src)).not.toContain("<img");
});

it.each(["https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,A"])("rejects invalid image sources: %s", (src) => {
  expect(renderImage(src)).not.toContain("<img");
});
