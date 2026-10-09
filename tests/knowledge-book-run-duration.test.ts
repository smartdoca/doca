import { expect, it } from "vitest";
import { runDuration } from "../apps/web/src/features/knowledge-books/book-run-list.js";
it("measures running and manual waits from the first start and freezes terminal duration", () => {
  const run = {
    started_at: "2026-10-10T00:00:00Z",
    updated_at: "2026-10-10T00:00:20Z",
    status: "running",
  };
  expect(runDuration(run, Date.parse("2026-10-10T00:01:10Z"))).toBe("01:10");
  expect(
    runDuration(
      { ...run, status: "awaiting_publication" },
      Date.parse("2026-10-10T01:01:10Z"),
    ),
  ).toBe("01:01:10");
  expect(
    runDuration(
      { ...run, status: "published" },
      Date.parse("2026-10-10T01:01:10Z"),
    ),
  ).toBe("00:20");
  expect(
    runDuration({ ...run, started_at: null, status: "queued" }, Date.now()),
  ).toBeNull();
});
