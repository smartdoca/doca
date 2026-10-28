import { afterEach, expect, it, vi } from "vitest";
import {
  isDocumentLocation,
  rememberLoginDocument,
  takeLoginDocument,
} from "../apps/web/src/features/auth/login-return.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps the exact desktop or mobile document link, including its comment target", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  for (const prefix of ["#/r/", "#/m/r/"]) {
    const target =
      prefix + "d470fbbe-6064-489f-a798-d8df8bfce20c?comment=thread-1";
    rememberLoginDocument(target);
    expect(takeLoginDocument()).toBe(target);
    expect(takeLoginDocument()).toBeNull();
  }
});

it("rejects external destinations and login callbacks", () => {
  for (const target of [
    "https://example.com",
    "//example.com",
    "#/auth/complete",
    "#/home",
    "#/r/invalid",
  ])
    expect(isDocumentLocation(target)).toBe(false);
});

it("does not prevent local sign-in when session storage is unavailable", () => {
  vi.stubGlobal("sessionStorage", {
    getItem() {
      throw new Error("disabled");
    },
    setItem() {
      throw new Error("disabled");
    },
  });
  expect(() =>
    rememberLoginDocument("#/r/d470fbbe-6064-489f-a798-d8df8bfce20c"),
  ).not.toThrow();
  expect(takeLoginDocument()).toBeNull();
});
