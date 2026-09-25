import { expect, it } from "vitest";
import {
  clampPanelWidth,
  readPanelWidth,
  readSidePanel,
  sidePanelSurface,
  writePanelWidth,
  writeSidePanel,
} from "../apps/web/src/features/ai/ai-side-open.js";

const memory = new Map<string, string>();

it("remembers the side panel and its session separately for different users", () => {
  const store = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  expect(sidePanelSurface("#/mail/20117e32-13ad-4c3f-87ec-0541eb39fc97?message=a")).toBeNull();
  expect(sidePanelSurface("#/files?path=%5B%5D")).toBe("files");
  expect(sidePanelSurface("#/ai")).toBeNull();
  writeSidePanel("user-b", "files", {
    open: true,
    sessionId: "20117e32-13ad-4c3f-87ec-0541eb39fc97",
  });
  writeSidePanel("user-a", "files", { open: false, sessionId: null });
  expect(readSidePanel("user-b", "files")).toEqual({
    open: true,
    sessionId: "20117e32-13ad-4c3f-87ec-0541eb39fc97",
  });
  expect(readSidePanel("user-a", "files").open).toBe(false);
  expect(readPanelWidth(1400)).toBe(460);
  expect(clampPanelWidth(120, 1400)).toBe(300);
  expect(clampPanelWidth(2000, 1400)).toBe(960);
  expect(clampPanelWidth(520, 700)).toBe(460);
  expect(writePanelWidth(640, 1400)).toBe(640);
  expect(readPanelWidth(1400)).toBe(640);
  expect(readPanelWidth(700)).toBe(460);
});
