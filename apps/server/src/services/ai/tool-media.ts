import { createHash } from "node:crypto";

const isImage = (part: any) =>
  part?.type === "file" && part.mediaType?.startsWith("image/") && part.data;
const pixels = (part: any): Buffer | undefined => {
  const data = part?.data?.type === "data" ? part.data.data : part?.data;
  if (typeof data === "string") return Buffer.from(data, "base64");
  if (Buffer.isBuffer(data) || data instanceof Uint8Array)
    return Buffer.from(data);
};
const frameDigest = (part: any) => {
  const bytes = pixels(part);
  return bytes
    ? createHash("sha256").update(part.mediaType).update(bytes).digest("hex")
    : undefined;
};

export function inspectionFrameDigests(output: any): string[] {
  return (
    output?.type === "content" && Array.isArray(output.value)
      ? output.value
      : []
  )
    .filter((part: any) => part.type === "media" || isImage(part))
    .map(frameDigest)
    .filter((value: string | undefined): value is string => !!value);
}
export type ToolImageSelection = {
  toolName: string;
  toolCallId: string;
  frameIndex: number;
  output: any;
  part: any;
  labelText: string;
};
export type TransmittedToolImage = {
  toolName: string;
  frameIndex: number;
  facts: any;
  sourceDigest: string;
};
type BoundToolImage = TransmittedToolImage & {
  toolCallId: string;
  metadataDigest: string;
  labelText: string;
  data: object;
  digest: string;
};

const toolResults = (prompt: any[]) =>
  prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? message.content.filter((part: any) => part.type === "tool-result")
      : [],
  );
const metadataDigest = (part: any): string | undefined => {
  if (
    part.output?.type !== "content" ||
    !Array.isArray(part.output.value) ||
    part.output.value.some(isImage)
  )
    return;
  return createHash("sha256")
    .update(JSON.stringify(part.output.value))
    .digest("hex");
};

const boundedText = (value: unknown, max = 128): string | undefined =>
  typeof value === "string" && value.length ? value.slice(0, max) : undefined;
const safeCoordinates = (value: any) => {
  if (!value || typeof value !== "object") return;
  const coordinates = Object.fromEntries(
    ["left", "top", "x", "y", "width", "height"].flatMap((key) =>
      typeof value[key] === "number" && Number.isFinite(value[key])
        ? [[key, value[key]]]
        : [],
    ),
  );
  return Object.keys(coordinates).length ? coordinates : undefined;
};
const parseFacts = (values: any[]) => {
  try {
    return JSON.parse(values.find((value) => value.type === "text")?.text);
  } catch {
    return undefined;
  }
};
const savedRevisionPreflight = (part: any, facts: any) =>
  part.toolName === "image_edit_saved" &&
  facts?.code === "image_revision_view_required" &&
  facts.paid === false;
const savedLocalPreview = (part: any, facts: any) =>
  part.toolName === "image_edit_saved_local_preview" &&
  facts?.kind === "image_revision_local_preview" &&
  facts.version === 1 &&
  facts.paid === false;

/** Only this render's explicit group declaration authorizes current candidate media. */
function candidateViewFrameCount(values: any[]): 3 | 4 | undefined {
  const declarations = values.flatMap((value) => {
    if (value?.type !== "text") return [];
    try {
      const parsed = JSON.parse(value.text);
      return parsed?.kind === "image_candidate_view_runtime" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (declarations.length !== 1) return;
  const declaration = declarations[0];
  if (
    declaration.frameCount === 3 &&
    declaration.sceneReferenceImageId === null &&
    declaration.sceneStatus === "not-merged" &&
    ["multiple-adjacent-scenes", "no-bound-adjacent-scene"].includes(
      declaration.reason,
    )
  )
    return 3;
  if (
    declaration.frameCount === 4 &&
    declaration.sceneStatus === "included" &&
    declaration.reason === null &&
    typeof declaration.sceneReferenceImageId === "string" &&
    declaration.sceneReferenceImageId.length === 36
  )
    return 4;
}

/** Public, bounded source facts travel next to each image; private receipt fields do not. */
function describeImages(part: any, values: any[]) {
  const facts = parseFacts(values);
  const localPreview = savedLocalPreview(part, facts);
  const firstText = values.find((value) => value.type === "text");
  let annotation: any;
  const images: { part: any; label: string; facts: any }[] = [];
  for (const value of values) {
    if (value.type === "text" && value !== firstText) {
      try {
        annotation = JSON.parse(value.text);
      } catch {
        annotation = { label: value.text };
      }
    }
    if (!isImage(value)) continue;
    const index = images.length;
    const sceneFrame =
      part.toolName === "image_candidate_view" &&
      annotation?.view === "scene-context";
    const source = sceneFrame
      ? annotation
      : part.toolName === "image_view" ||
          part.toolName === "image_revision_view" ||
          localPreview ||
          savedRevisionPreflight(part, facts) ||
          (part.toolName === "image_batch" &&
            facts?.code === "image_review_requires_fresh_view")
        ? facts?.images?.[index]
        : part.toolName === "file_read" || part.toolName === "attachment_read"
          ? facts?.imageReferences?.[index]
          : facts;
    const filename = boundedText(source?.filename ?? value.filename, 255);
    const label =
      boundedText(annotation?.label ?? annotation?.view, 384) ??
      (filename ? `读取图片：${filename}` : `工具内第${index + 1}张图像`);
    images.push({
      part: value,
      label,
      facts: {
        toolName: boundedText(part.toolName),
        toolCallId: boundedText(part.toolCallId),
        toolImage: index + 1,
        label,
        kind: boundedText(facts?.kind),
        state: boundedText(facts?.state),
        view: boundedText(annotation?.view),
        coordinateSpace: boundedText(
          annotation?.coordinateSpace ??
            (localPreview ? source?.coordinateSpace : undefined),
        ),
        selectionCoordinateSpace: localPreview
          ? source?.selectionCoordinateSpace === null
            ? null
            : boundedText(source?.selectionCoordinateSpace)
          : undefined,
        role: boundedText(
          annotation?.role ?? (localPreview ? source?.role : undefined),
        ),
        nonCitable: annotation?.nonCitable === true ? true : undefined,
        currentReferenceImageId: boundedText(
          annotation?.currentReferenceImageId,
        ),
        physicalPage: Number.isSafeInteger(annotation?.physicalPage)
          ? annotation.physicalPage
          : undefined,
        currentPhysicalPage: Number.isSafeInteger(
          annotation?.currentPhysicalPage,
        )
          ? annotation.currentPhysicalPage
          : undefined,
        sourceObjectId: boundedText(annotation?.sourceObjectId),
        sourceSha256: boundedText(annotation?.sourceSha256),
        sceneSha256: boundedText(annotation?.sceneSha256),
        referenceImageId: boundedText(source?.referenceImageId),
        generationOperationId: boundedText(facts?.generationOperationId),
        assetId: boundedText(source?.assetId),
        filename,
        sourceFilename: boundedText(annotation?.sourceFilename, 255),
        sourceSize: localPreview
          ? safeCoordinates(source?.sourceSize)
          : sceneFrame
            ? safeCoordinates({
                width: annotation?.sourceRect?.width,
                height: annotation?.sourceRect?.height,
              })
            : safeCoordinates(facts?.source),
        displaySize: localPreview
          ? safeCoordinates(source?.displaySize)
          : sceneFrame
            ? undefined
            : safeCoordinates(facts?.raw?.displaySize),
        generatedWindow: sceneFrame
          ? undefined
          : safeCoordinates(facts?.generatedWindow),
        sourceRect: safeCoordinates(
          annotation?.sourceRect ??
            (localPreview ? source?.sourceRect : undefined),
        ),
        contentRect: safeCoordinates(
          annotation?.contentRect ??
            (localPreview ? source?.contentRect : undefined),
        ),
        nativeRect: localPreview
          ? safeCoordinates(source?.nativeRect)
          : undefined,
        workspace: localPreview
          ? safeCoordinates({
              width: source?.workspace?.width,
              height: source?.workspace?.height,
            })
          : undefined,
      },
    });
    annotation = undefined;
  }
  return images;
}

const userFrames = (prompt: any[]) =>
  prompt.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.flatMap((part: any, index: number) =>
          isImage(part) ? [{ part, label: message.content[index - 1] }] : [],
        )
      : [],
  );

function olderVisualText(content: any[]) {
  const envelope =
    content[0]?.type === "text" &&
    content[0].text?.startsWith("以下是刚刚读取工具返回的") &&
    content[0].text.includes("每张图前的标签绑定其来源、工具调用和坐标");
  const removed = new Set<number>();
  if (envelope) {
    removed.add(0);
    content.forEach((part, index) => {
      if (!isImage(part) || content[index - 1]?.type !== "text") return;
      try {
        const label = JSON.parse(content[index - 1].text);
        if (
          Number.isSafeInteger(label.image) &&
          Number.isSafeInteger(label.toolImage) &&
          typeof label.label === "string" &&
          typeof label.toolCallId === "string"
        )
          removed.add(index - 1);
      } catch {
        // Ordinary user captions are not runtime source labels.
      }
    });
  }
  return content.filter((part, index) => !isImage(part) && !removed.has(index));
}

/** Private runtime provenance follows normalization without entering a provider part. */
export function bindToolImageFrames(
  selected: ToolImageSelection[],
  normalized: any[],
): BoundToolImage[] {
  const frames = userFrames(normalized);
  if (frames.length !== selected.length) return [];
  const receipts = toolResults(normalized);
  return selected.flatMap((selection, index) => {
    const sourceDigest = frameDigest(selection.part),
      digest = frameDigest(frames[index]?.part);
    let facts: any;
    try {
      const metadata = selection.output?.value?.find(
        (part: any) => part.type === "text",
      );
      facts = JSON.parse(metadata?.text);
    } catch {
      return [];
    }
    const matchingReceipts = receipts.filter(
      (part) =>
        part.toolName === selection.toolName &&
        part.toolCallId === selection.toolCallId,
    );
    const receiptDigest =
      matchingReceipts.length === 1
        ? metadataDigest(matchingReceipts[0])
        : undefined;
    if (
      !sourceDigest ||
      !digest ||
      typeof selection.toolCallId !== "string" ||
      !selection.toolCallId ||
      !receiptDigest ||
      frames[index]?.label?.type !== "text" ||
      frames[index].label.text !== selection.labelText ||
      !frames[index]?.part.data ||
      typeof frames[index].part.data !== "object"
    )
      return [];
    return [
      {
        toolName: selection.toolName,
        toolCallId: selection.toolCallId,
        metadataDigest: receiptDigest,
        labelText: selection.labelText,
        frameIndex: selection.frameIndex,
        facts,
        sourceDigest,
        digest,
        data: frames[index].part.data,
      },
    ];
  });
}

/** A diagnostic needs both its unchanged pixels and its complete, same-tool receipt. */
export function transmittedToolImageFrames(
  prompt: any[],
  bound: BoundToolImage[],
): TransmittedToolImage[] {
  const receipts = toolResults(prompt);
  const remaining = bound.filter((frame) => {
    const matches = receipts.filter(
      (part) =>
        part.toolName === frame.toolName &&
        part.toolCallId === frame.toolCallId,
    );
    return (
      matches.length === 1 &&
      metadataDigest(matches[0]) === frame.metadataDigest
    );
  });
  return userFrames(prompt).flatMap(({ part, label }) => {
    const index = remaining.findIndex(
      (frame) =>
        frame.data === part.data &&
        frame.digest === frameDigest(part) &&
        label?.type === "text" &&
        label.text === frame.labelText,
    );
    if (index < 0) return [];
    const [frame] = remaining.splice(index, 1);
    const { toolName, frameIndex, facts, sourceDigest } = frame!;
    return [{ toolName, frameIndex, facts, sourceDigest }];
  });
}

/** Image tool outputs must be actual model image parts, not base64 inside tool JSON.
 * The installed AI SDK's chat transport serializes tool content as text. Doca
 * keeps textual tool receipts, and presents the latest visual exchange as user
 * file parts. Older pixels remain in durable storage and can be read again.
 */
export function hoistToolImages(
  prompt: any[],
  maxImages = 4,
  selectedFrame?: (frame: ToolImageSelection) => void,
) {
  const visualIndexes = prompt.flatMap((message, index) =>
    message.role === "tool" &&
    message.content?.some(
      (part: any) =>
        part.output?.type === "content" && part.output.value?.some(isImage),
    )
      ? [index]
      : [],
  );
  if (!visualIndexes.length) return prompt;
  let exchangeStart = visualIndexes.at(-1)!;
  while (exchangeStart > 0 && prompt[exchangeStart - 1]?.role === "tool")
    exchangeStart--;
  const images: any[] = [];
  let omitted = 0;
  const result = prompt.map((message, index) => {
    if (
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some(isImage)
    )
      return {
        ...message,
        content: [
          ...olderVisualText(message.content),
          {
            type: "text",
            text: "较早视觉输入本轮未重复传输，来源与参考ID仍有效，需要查看时用 image_view/attachment_read 分批读取。",
          },
        ],
      };
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part: any) => {
        if (part.output?.type !== "content") return part;
        const values = part.output.value;
        if (!values.some(isImage)) return part;
        let metadata = values.filter((value: any) => !isImage(value));
        if (index >= exchangeStart) {
          const candidates = describeImages(part, values);
          const capacity = Math.max(0, maxImages - images.length);
          // A partial candidate diagnostic can look like a different source or
          // final image. Present its complete source/raw/projection group only.
          const selected =
            part.toolName === "image_candidate_view" ||
            part.toolName === "image_revision_view" ||
            part.toolName === "image_candidate_region_view" ||
            part.toolName === "image_mask_region_view" ||
            part.toolName === "image_mask_prepare" ||
            part.toolName === "image_mask_view" ||
            part.toolName === "image_mask_refine" ||
            part.toolName === "image_mask_segment" ||
            part.toolName === "image_mask_segment_view" ||
            savedLocalPreview(part, parseFacts(values)) ||
            savedRevisionPreflight(part, parseFacts(values)) ||
            (part.toolName === "image_batch" &&
              parseFacts(values)?.code === "image_review_requires_fresh_view")
              ? candidates.length ===
                  (part.toolName === "image_candidate_view"
                    ? candidateViewFrameCount(values)
                    : [
                          "image_mask_region_view",
                          "image_revision_view",
                        ].includes(part.toolName) ||
                        savedLocalPreview(part, parseFacts(values))
                      ? 3
                      : 2) && capacity >= candidates.length
                ? candidates
                : []
              : candidates.slice(0, capacity);
          selected.forEach((image, frameIndex) => {
            const labelText = JSON.stringify({
              image: images.length + 1,
              ...image.facts,
            });
            images.push({ part: image.part, labelText });
            selectedFrame?.({
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              frameIndex,
              output: part.output,
              part: image.part,
              labelText,
            });
          });
          const missing = candidates.length - selected.length;
          omitted += missing;
          metadata = [
            ...metadata,
            {
              type: "text",
              text: JSON.stringify({
                visualInput: {
                  originalImageCount: candidates.length,
                  transmittedImageCount: selected.length,
                  transmitted: selected.map((image, index) => ({
                    toolImage: index + 1,
                    label: image.label,
                    referenceImageId: image.facts.referenceImageId,
                    assetId: image.facts.assetId,
                    generationOperationId: image.facts.generationOperationId,
                    filename: image.facts.filename,
                  })),
                  untransmitted: candidates
                    .slice(selected.length)
                    .map((image, index) => ({
                      toolImage: selected.length + index + 1,
                      label: image.label,
                      referenceImageId: image.facts.referenceImageId,
                      assetId: image.facts.assetId,
                      generationOperationId: image.facts.generationOperationId,
                      filename: image.facts.filename,
                    })),
                  instruction: missing
                    ? savedLocalPreview(part, parseFacts(values))
                      ? `本工具的${missing}张原页、当前底图与局部覆盖预览未完整送达，尚未建立局部续改选区证明，也未调用图片服务。请单独重新调用 image_edit_saved_local_preview，保持同一originalReferenceImageId、baseAssetId、region及contextPaddingPixels；三个实际视图完整送达且响应成功结束后，后续轮次才可付费局部续改。image_view不能代替本选区预览证明。`
                      : savedRevisionPreflight(part, parseFacts(values))
                        ? `本工具的原页和当前底图两帧未完整送达，尚未建立续改查看证明，也未调用图片服务。请先单独 image_view 查看原页 referenceImageId=${boundedText(parseFacts(values)?.images?.[0]?.referenceImageId)} 与当前底图 baseAssetId=${boundedText(parseFacts(values)?.images?.[1]?.referenceImageId)}；两帧全部送达且模型响应成功结束后，后续轮次才可续改。`
                        : part.toolName === "image_candidate_view"
                          ? `本工具的${missing}张诊断图尚未传入本轮视觉输入，不能宣称已经看过。必须单独重新调用 image_candidate_view，generationOperationId=${boundedText(parseFacts(values)?.generationOperationId)}；原始候选和坐标投影不能通过 image_view 补查。`
                          : part.toolName === "image_revision_view"
                            ? `本工具的${missing}张续改原页、成品底图及原始候选诊断未完整送达，不能宣称已经看过。单独重新调用 image_revision_view，generationOperationId=${boundedText(parseFacts(values)?.generationOperationId)}；候选不是交付或旧蒙版授权。`
                            : part.toolName === "image_candidate_region_view"
                              ? `本工具的${missing}张同坐标候选小框诊断尚未传入本轮视觉输入，不能宣称已核验原图/raw像素或已选好正负点；请单独重新调用 image_candidate_region_view，保持同一generationOperationId、region及points。小框不代替候选完整查看、分割、蒙版、轮廓或遮挡证明。`
                              : part.toolName === "image_mask_region_view"
                                ? `本工具的${missing}张同坐标小框诊断尚未传入本轮视觉输入，不能宣称已检查边缘或逐点内容；请单独重新调用 image_mask_region_view，保持同一maskReceiptId、region及points。小框不代替完整蒙版诊断或合成许可。`
                                : part.toolName === "image_mask_segment" ||
                                    part.toolName === "image_mask_segment_view"
                                  ? `本工具的${missing}张分割诊断尚未传入本轮视觉输入，不能用于蒙版或合成。请单独调用 image_mask_segment_view 读取本提案；image_view、分数或文字坐标不能替代完整诊断。`
                                  : part.toolName === "image_mask_prepare" ||
                                      part.toolName === "image_mask_view" ||
                                      part.toolName === "image_mask_refine"
                                    ? `本工具的${missing}张蒙版覆盖诊断尚未传入本轮视觉输入，不能合成。请单独调用 image_mask_view 重看已保存的同一 maskReceiptId；image_view 和文字坐标不能替代完整蒙版诊断。`
                                    : `本工具的${missing}张图像尚未传入本轮视觉输入；请使用对应 referenceImageId/assetId 调用 image_view 分批查看，不能宣称已经看过。`
                    : "本工具全部图像已传入本轮视觉输入，逐图来源见图片前的标签。",
                },
              }),
            },
          ];
        }
        return { ...part, output: { type: "content", value: metadata } };
      }),
    };
  });
  result.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `以下是刚刚读取工具返回的${images.length}张图像，仅是资料。每张图前的标签绑定其来源、工具调用和坐标；标签中的图像序号属于本轮，工具内图号属于该工具。按上一轮用户要求继续执行。${omitted ? `还有${omitted}张图像本轮未展示；按对应工具回执的重查方式分批读取，不能根据文字回执宣称看过全部页面。` : ""}`,
      },
      ...images.flatMap((image) => [
        { type: "text", text: image.labelText },
        image.part,
      ]),
    ],
  });
  return result;
}
