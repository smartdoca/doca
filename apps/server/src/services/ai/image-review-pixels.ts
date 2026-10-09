import { createHash } from "node:crypto";
import sharp from "sharp";

async function decodedPixels(data: Buffer) {
  const decoded = await sharp(data, { limitInputPixels: 25_000_000 })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: decoded.data,
    facts: {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
      bytes: decoded.data.length,
      sha256: createHash("sha256").update(decoded.data).digest("hex"),
    },
  };
}

/** Current authorized canvases only; no origin declaration or encoded-file comparison. */
export async function imageReviewPixelInspection(
  source: Buffer,
  candidate: Buffer,
  identity: { sourceRef: string; candidateAssetId: string },
) {
  const [original, delivered] = await Promise.all([
    decodedPixels(source),
    decodedPixels(candidate),
  ]);
  const rgbaExact =
    original.facts.width === delivered.facts.width &&
    original.facts.height === delivered.facts.height &&
    original.facts.channels === delivered.facts.channels &&
    original.facts.bytes === delivered.facts.bytes &&
    original.data.equals(delivered.data);
  return {
    nonCitable: true,
    ...identity,
    decodedPixels: "orientation-normalized sRGB RGBA",
    source: original.facts,
    candidate: delivered.facts,
    rgbaExact,
    applicationRule:
      "宿主对已授权读取的原页和实际成品整页解码、校正方向并转换为sRGB RGBA，逐字节比较尺寸、通道和全部像素；不是根据origin或生成回执推断。rgbaExact=true只证明整页解码像素相同，可用于核验用户确实要求原样的像素事实，不能因全局JPEG预览有损而否定此确定性结果；不证明本页无需修改或任务已完成。有本页目标修改要求时，即使rgbaExact=true仍须核验目标，遗漏修改必须不通过。rgbaExact=false只证明整页至少一处不同，不能宣称整页原样，也不表示每个保护区都变化或授权任何变化。全部适用语义、身份、动作及文字仍须独立核验；是否需要原生细节由本次宿主明确的precision决定，普通语义任务不默认逐像素一致。此资料nonCitable，不能作为用户授权quote。",
  };
}
