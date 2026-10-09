import { generateImageAsset } from "../../apps/server/src/services/ai/images.js";

/** Existing isolated fixtures express edits through references; bind their intent explicitly. */
export function generateTestImageAsset(
  ...args: Parameters<typeof generateImageAsset>
) {
  return generateImageAsset(args[0], args[1], args[2], args[3], {
    operation: args[2].referenceImageIds?.length ? "edit" : "generate",
    ...args[4],
  });
}
