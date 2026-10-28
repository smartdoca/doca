import { createHash } from "node:crypto";
import sharp from "sharp";
import { fail } from "@core/shared/errors.js";

export const SITE_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;
const maxStoredBytes = 300 * 1024;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const invalidConfig = () =>
  fail(500, "site_logo_invalid_config", { code: "site_logo_invalid_config" });

/** NULL is the approved unconfigured state. Unknown records are never repaired. */
export async function readSiteLogo(raw: string | null) {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== 1 ||
      typeof value.png !== "string" ||
      Object.keys(value).sort().join(",") !== "png,version" ||
      value.png.length > (maxStoredBytes * 4) / 3 + 4
    )
      return invalidConfig();
    const bytes = Buffer.from(value.png, "base64");
    if (
      !bytes.length ||
      bytes.length > maxStoredBytes ||
      bytes.toString("base64") !== value.png ||
      !bytes.subarray(0, 8).equals(pngSignature)
    )
      return invalidConfig();
    const image = sharp(bytes, {
      limitInputPixels: 256 * 256,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 256 ||
      metadata.height > 256 ||
      (metadata.pages ?? 1) !== 1
    )
      return invalidConfig();
    await image.raw().toBuffer();
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { bytes, hash, url: `/api/v1/site-logo?v=${hash}` };
  } catch {
    return invalidConfig();
  }
}

export async function encodeSiteLogo(input: string) {
  const invalid = () =>
    fail(400, "site_logo_invalid_image", { code: "site_logo_invalid_image" });
  const match =
    /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(input);
  if (!match) return invalid();
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length > SITE_LOGO_UPLOAD_BYTES)
    fail(413, "site_logo_too_large", { code: "site_logo_too_large" });
  if (!bytes.length || bytes.toString("base64") !== match[1]) return invalid();
  try {
    const image = sharp(bytes, {
      limitInputPixels: 16_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      (metadata.pages ?? 1) !== 1
    )
      return invalid();
    const png = await image
      .rotate()
      .resize({
        width: 256,
        height: 256,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.length > maxStoredBytes) return invalid();
    return JSON.stringify({ version: 1, png: png.toString("base64") });
  } catch {
    return invalid();
  }
}
