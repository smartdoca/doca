import { expect, it } from "vitest";
import { isDwgFile } from "@web/features/files/dwg-file.js";

it("recognizes DWG files by name or CAD mime type", () => {
  expect(isDwgFile("plan.dwg", "application/octet-stream")).toBe(true);
  expect(isDwgFile("PLAN.DWG", "")).toBe(true);
  expect(isDwgFile("site.dxf", "application/dxf")).toBe(false);
  expect(isDwgFile("scan.bin", "image/vnd.dwg")).toBe(true);
  expect(isDwgFile("drawing.bin", "application/acad")).toBe(true);
  expect(isDwgFile("photo.png", "image/png")).toBe(false);
});
