import { createHash } from "node:crypto";
import sharp from "sharp";
import { fail } from "@core/shared/errors.js";
import { nativeImageReviewPrompt } from "./image-review-views.js";

/** Lossy transport for composition only; original canvases still supply every native tile. */
export async function imageReviewGlobalPreview(data: Buffer) {
  const rendered = await sharp(data, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#fff" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
    sha256: createHash("sha256").update(rendered.data).digest("hex"),
  };
}

/** Host-bound first-pair JPEG preview only. Every other review frame retains the PNG gate. */
export function globalImageReviewPrompt(
  approvedJPEGPreviews: ReadonlySet<string>,
) {
  return async (prompt: any[]) => {
    let imageIndex = 0;
    for (const message of prompt)
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        if (part.type !== "file" || !part.mediaType?.startsWith("image/"))
          continue;
        const index = imageIndex++;
        if (part.mediaType === "image/png") {
          await nativeImageReviewPrompt([{ ...message, content: [part] }]);
          continue;
        }
        if (
          index >= 2 ||
          part.mediaType !== "image/jpeg" ||
          part.data?.type !== "data"
        )
          fail(422, "全局有损预览仅允许宿主绑定的原图和成品前两帧");
        const data =
          typeof part.data.data === "string"
            ? Buffer.from(part.data.data, "base64")
            : Buffer.from(part.data.data);
        if (
          !approvedJPEGPreviews.has(
            createHash("sha256").update(data).digest("hex"),
          )
        )
          fail(422, "全局有损预览字节与当前宿主绑定不一致");
        try {
          const image = sharp(data, {
            limitInputPixels: 25_000_000,
            failOn: "warning",
          });
          const metadata = await image.metadata();
          if (
            metadata.format !== "jpeg" ||
            !metadata.width ||
            !metadata.height ||
            Math.max(metadata.width, metadata.height) > 1600 ||
            (metadata.pages ?? 1) !== 1 ||
            metadata.exif !== undefined ||
            metadata.orientation !== undefined
          )
            fail(422, "全局有损预览必须为无EXIF的1600边内单帧JPEG");
          await image.raw().toBuffer();
        } catch {
          fail(422, "全局有损预览格式、尺寸或完整像素无效");
        }
      }
    return prompt;
  };
}
