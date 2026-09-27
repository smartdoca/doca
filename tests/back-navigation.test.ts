import { describe, expect, it, vi } from "vitest";
import {
  hasPreviousHistory,
  navigateBackOr,
  type BackNavigationTarget,
} from "@web/shared/utils/back-navigation.js";

function target({
  length = 1,
  canGoBack,
}: {
  length?: number;
  canGoBack?: boolean;
} = {}) {
  const back = vi.fn();
  const value: BackNavigationTarget = {
    history: { length, back },
    location: { hash: "#/r/document-id" },
    ...(canGoBack === undefined ? {} : { navigation: { canGoBack } }),
  };
  return { value, back };
}

describe("page back navigation", () => {
  it("uses the browser's previous entry when one is available", () => {
    const browser = target({ canGoBack: true });

    navigateBackOr("/documents", browser.value);

    expect(browser.back).toHaveBeenCalledOnce();
    expect(browser.value.location.hash).toBe("#/r/document-id");
  });

  it("falls back to the module list when there is no previous entry", () => {
    const browser = target({ canGoBack: false, length: 5 });

    navigateBackOr("/libraries", browser.value);

    expect(browser.back).not.toHaveBeenCalled();
    expect(browser.value.location.hash).toBe("/libraries");
  });

  it("uses history length in browsers without the Navigation API", () => {
    expect(hasPreviousHistory(target({ length: 2 }).value)).toBe(true);
    expect(hasPreviousHistory(target({ length: 1 }).value)).toBe(false);
  });
});
