import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DocumentModeContext, DocumentModeSwitch, resolveDocumentMode } from "../apps/web/src/features/documents/document-mode.js";

it("defaults to edit for editors and never upgrades reader permissions", () => {
  expect(resolveDocumentMode(true, "edit")).toBe("edit");
  expect(resolveDocumentMode(true, "read")).toBe("read");
  expect(resolveDocumentMode(false, "edit")).toBe("read");
  expect(resolveDocumentMode(false, "read")).toBe("read");
});
it.each([true, false])("renders only authorized mode controls (canEdit=%s)", canEdit => {
  const change = vi.fn(), reportPermission = vi.fn();
  const html = renderToStaticMarkup(createElement(DocumentModeContext.Provider, { value: { canEdit, readOnly: !canEdit, change, reportPermission } }, createElement(DocumentModeSwitch)));
  expect(html).toContain("阅读");
  if (canEdit) {
    expect(html).toContain('value="edit" selected=""');
    expect(html).toContain('aria-label="文档模式"');
  } else {
    expect(html).not.toContain("<select");
    expect(html).not.toContain("编辑");
  }
  expect(change).not.toHaveBeenCalled();
  expect(reportPermission).not.toHaveBeenCalled();
});
