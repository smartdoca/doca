import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { DocumentAuthor } from "../apps/web/src/features/documents/document-author.js";

it("shows only 我 for the signed-in document owner", () => {
  expect(
    renderToStaticMarkup(
      createElement(DocumentAuthor, {
        id: "self",
        name: "本人姓名",
        currentUserId: "self",
      }),
    ),
  ).toBe('<span class="document-author-self">我</span>');
});
it("does not mistake another user with the same name or anonymous view for self", () => {
  for (const currentUserId of ["other", undefined]) {
    const html = renderToStaticMarkup(
      createElement(DocumentAuthor, {
        id: "self",
        name: "同名用户",
        currentUserId,
      }),
    );
    expect(html).not.toContain("document-author-self");
    expect(html).toContain("user-badge");
    expect(html).toContain("同名用户");
  }
});
