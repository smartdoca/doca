import { describe, expect, it } from "vitest";
import {
  navigateBackOr,
  type BackNavigationTarget,
} from "@web/shared/utils/back-navigation.js";

function target(hash = "#/r/document-id") {
  const value: BackNavigationTarget = {
    location: { hash },
  };
  return value;
}

describe("page back navigation", () => {
  it("returns a document to the document list instead of the previous entry", () => {
    const browser = target();

    navigateBackOr("/documents", browser);

    expect(browser.location.hash).toBe("/documents");
  });

  it("returns a knowledge base to the library list", () => {
    const browser = target("#/r/library-document");

    navigateBackOr("/libraries", browser);

    expect(browser.location.hash).toBe("/libraries");
  });

  it("returns a folder, assistant, or profile to its own list", () => {
    const folder = target("#/files?path=nested");
    const assistant = target("#/knowledge-assistants?bot=1");
    const profile = target("#/account");

    navigateBackOr("/files", folder);
    navigateBackOr("/knowledge-assistants", assistant);
    navigateBackOr("/home", profile);

    expect(folder.location.hash).toBe("/files");
    expect(assistant.location.hash).toBe("/knowledge-assistants");
    expect(profile.location.hash).toBe("/home");
  });
});
