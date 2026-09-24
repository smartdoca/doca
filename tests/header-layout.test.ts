import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LastEdited } from "../apps/web/src/features/documents/document-experience.js";
import { DocumentName } from "../apps/web/src/features/documents/document-name.js";
import type { Detail, Resource } from "../apps/web/src/shared/api.js";

it.each([
  ["editor", 0, false],
  ["reader", 1, false],
  ["reader", 0, true],
] as const)(
  "history shortcut follows %s/historyReaders=%s access without a nested user button",
  (role, history_readers, disabled) => {
    const html = renderToStaticMarkup(
      createElement(LastEdited, {
        detail: {
          resource: { role, history_readers },
          lastEditorName: "最近编辑者",
          lastEditedAt: "2026-09-14T00:00:00Z",
        } as Detail,
      }),
    );
    expect(html).toContain('aria-label="查看历史记录"');
    expect(html).toContain("lucide-history");
    expect(html).toContain("最近编辑者");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html.includes('disabled=""')).toBe(disabled);
  },
);
it("metadata titles remain ordinary text buttons until explicitly edited", () => {
  const html = renderToStaticMarkup(
    createElement(DocumentName, {
      resource: { title: "画板标题" } as Resource,
      changed() {},
    }),
  );
  expect(html).toContain("document-title-edit");
  expect(html).toContain("画板标题");
  expect(html).not.toContain("<input");
});
