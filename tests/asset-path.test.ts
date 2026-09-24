import { expect, it } from "vitest";
import { platformAssetId } from "../apps/web/src/shared/utils/asset-path.js";
it("resolves only persisted IDs and exact same-origin platform image paths", () => {
  const id = "10ebaa8a-6db1-497d-9d03-72e3316f7a21";
  expect(platformAssetId(id)).toBe(id);
  expect(platformAssetId(`/api/v1/assets/${id}/content`)).toBe(id);
  for (const path of [
    `https://external.test/api/v1/assets/${id}/content`,
    `//external.test/${id}`,
    `/api/v1/assets/${id}/content?audit=1`,
    "javascript:alert(1)",
    "../../private",
  ])
    expect(platformAssetId(path)).toBeNull();
});
