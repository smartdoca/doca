import { expect, it } from "vitest";
import { explorerTargets } from "../apps/server/src/services/ai/memory.js";

it("keeps folders the user sent so history can show them", () => {
  expect(
    explorerTargets([
      { kind: "folder", id: "folder-1", name: " 超级无敌可爱猫猫 " },
      { kind: "file", id: "file-1", name: "猫.webp" },
      { kind: "folder", id: "folder-1", name: "重复" },
      { kind: "note", id: "x" },
      { kind: "folder" },
    ]),
  ).toEqual([
    { kind: "folder", id: "folder-1", name: "超级无敌可爱猫猫" },
    { kind: "file", id: "file-1", name: "猫.webp" },
  ]);
  expect(explorerTargets(undefined)).toEqual([]);
});
