import { afterEach, expect, it, vi } from "vitest";
import { config } from "@server/bootstrap/config.js";
import { renderDocumentPdf } from "@server/services/document-pdf.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["", "/old/chromium"])("rejects obsolete Chromium configuration before database startup: %s", async (value) => {
  vi.stubEnv("DOCA_PDF_CHROMIUM", value);
  expect(() => config()).toThrow("DOCA_PDF_CHROMIUM is no longer supported");
  await expect(renderDocumentPdf("<p>fixture</p>", 794)).rejects.toThrow("DOCA_PDF_CHROMIUM is no longer supported");
});
