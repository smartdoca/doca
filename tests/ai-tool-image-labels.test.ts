import { expect, it } from "vitest";
import sharp from "sharp";
import {
  bindToolImageFrames,
  hoistToolImages,
  transmittedToolImageFrames,
  type ToolImageSelection,
} from "../apps/server/src/services/ai/tool-media.js";
import { modelPromptImages } from "../apps/server/src/services/ai/model-image.js";
import { fitPromptToModelInput } from "../apps/server/src/services/ai/context-budget.js";

const frame = (value: Buffer) => ({
  type: "file",
  mediaType: "image/png",
  data: { type: "data", data: value },
});
const diagnostic = (
  toolCallId: string,
  source: string,
  pixels: Buffer,
  toolName = "image_candidate_view",
) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              generationOperationId: `${toolCallId}-operation`,
              referenceImageId: source,
              generatedWindow: { left: 2, top: 3, width: 4, height: 5 },
            }),
          },
          ...(toolName === "image_candidate_view"
            ? [{
                type: "text",
                text: JSON.stringify({
                  kind: "image_candidate_view_runtime",
                  frameCount: 3,
                  sceneReferenceImageId: null,
                  sceneStatus: "not-merged",
                  reason: "no-bound-adjacent-scene",
                }),
              }]
            : []),
          ...["source", "raw", "source-projection"]
            .slice(0, toolName === "image_candidate_view" ? 3 : 2)
            .flatMap((view) => [
              {
                type: "text",
                text: JSON.stringify({
                  view,
                  label: `${source} ${view}`,
                  coordinateSpace:
                    view === "raw" ? "generation-workspace" : "source",
                  sourceRect: { left: 1, top: 2, width: 3, height: 4 },
                }),
              },
              frame(pixels),
            ]),
        ],
      },
    },
  ],
});
const pairs = (prompt: any[]) =>
  prompt.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.flatMap((part: any, index: number) =>
          part.type === "file"
            ? [{ image: part, label: message.content[index - 1] }]
            : [],
        )
      : [],
  );
async function png() {
  return sharp({
    create: { width: 16, height: 12, channels: 3, background: "#274369" },
  })
    .png()
    .toBuffer();
}

it("sends a complete candidate group, no partial second candidate, and uses the remaining budget for a correctly labelled ordinary image", async () => {
  const pixels = await png(),
    selected: ToolImageSelection[] = [];
  const ordinary = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "image_view",
        toolCallId: "read-final",
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: JSON.stringify({
                images: [
                  {
                    referenceImageId: "final-c",
                    filename: "latest-page-3.png",
                  },
                ],
              }),
            },
            frame(pixels),
          ],
        },
      },
    ],
  };
  const input = [
    diagnostic("A", "page-a", pixels),
    diagnostic("B", "page-b", pixels),
    ordinary,
  ];
  const prompt = hoistToolImages(input, 4, (selection) =>
    selected.push(selection),
  );
  const normalized = await modelPromptImages(prompt);
  const actual = pairs(normalized);
  expect(actual).toHaveLength(4);
  expect(actual.map((pair) => JSON.parse(pair.label.text))).toMatchObject([
    {
      image: 1,
      toolName: "image_candidate_view",
      toolCallId: "A",
      toolImage: 1,
      view: "source",
      referenceImageId: "page-a",
    },
    {
      image: 2,
      toolName: "image_candidate_view",
      toolCallId: "A",
      toolImage: 2,
      view: "raw",
      coordinateSpace: "generation-workspace",
    },
    {
      image: 3,
      toolName: "image_candidate_view",
      toolCallId: "A",
      toolImage: 3,
      view: "source-projection",
      generatedWindow: { left: 2, top: 3, width: 4, height: 5 },
    },
    {
      image: 4,
      toolName: "image_view",
      toolCallId: "read-final",
      toolImage: 1,
      referenceImageId: "final-c",
      filename: "latest-page-3.png",
    },
  ]);
  expect(actual.every((pair) => pair.image.mediaType === "image/jpeg")).toBe(
    true,
  );
  const secondReceipt = normalized[1].content[0].output.value;
  const omitted = JSON.parse(secondReceipt.at(-1).text).visualInput;
  expect(omitted).toMatchObject({
    originalImageCount: 3,
    transmittedImageCount: 0,
    untransmitted: [
      { toolImage: 1, label: "page-b source" },
      { toolImage: 2, label: "page-b raw" },
      { toolImage: 3, label: "page-b source-projection" },
    ],
  });
  expect(omitted.instruction).toContain("单独重新调用 image_candidate_view");
  expect(omitted.instruction).toContain("generationOperationId=B-operation");
  expect(omitted.instruction).toContain("不能通过 image_view");
  const transmitted = transmittedToolImageFrames(
    normalized,
    bindToolImageFrames(selected, normalized),
  );
  expect(
    transmitted.map((value) => [
      value.toolName,
      value.frameIndex,
      value.facts.generationOperationId ??
        value.facts.images[0].referenceImageId,
    ]),
  ).toEqual([
    ["image_candidate_view", 0, "A-operation"],
    ["image_candidate_view", 1, "A-operation"],
    ["image_candidate_view", 2, "A-operation"],
    ["image_view", 0, "final-c"],
  ]);
  expect(input[1]!.content[0]!.output.value).toHaveLength(8);
});

it("maps each image_view filename and reference separately, without copying private fields into the adjacent labels", async () => {
  const pixels = await png();
  const prompt = hoistToolImages([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "image_view",
          toolCallId: "read",
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: JSON.stringify({
                  objectKey: "private-storage-path",
                  nativeUsage: { marker: "private-native-blob" },
                  images: [
                    { referenceImageId: "first", filename: "book-a.png" },
                    { referenceImageId: "second", filename: "book-b.png" },
                  ],
                }),
              },
              frame(pixels),
              frame(pixels),
            ],
          },
        },
      ],
    },
  ]);
  const captions = pairs(await modelPromptImages(prompt)).map((pair) =>
    JSON.parse(pair.label.text),
  );
  expect(captions).toMatchObject([
    { referenceImageId: "first", filename: "book-a.png" },
    { referenceImageId: "second", filename: "book-b.png" },
  ]);
  expect(JSON.stringify(captions)).not.toContain("private-");
  expect(JSON.stringify(captions)).not.toContain("objectKey");
  expect(JSON.stringify(captions)).not.toContain("nativeUsage");
});

it("removes previous runtime image labels with their old pixels while retaining the actual user text and ordinary captions", async () => {
  const pixels = await png();
  const taskText = "修改当前页，保留正文。";
  const ordinaryCaption = JSON.stringify({
    referenceImageId: "user-photo",
    filename: "family.png",
  });
  const first = await modelPromptImages(
    hoistToolImages([
      {
        role: "user",
        content: [
          { type: "text", text: taskText },
          { type: "text", text: ordinaryCaption },
          frame(pixels),
        ],
      },
      diagnostic("A", "page-a", pixels),
    ]),
  );
  const history = fitPromptToModelInput(first, 64000);
  const oldEnvelope = history.at(-1);
  expect(pairs([oldEnvelope])).toHaveLength(3);
  const next = hoistToolImages([
    ...history,
    { role: "assistant", content: [] },
    diagnostic("B", "page-b", pixels),
  ]);
  const stripped = next[history.length - 1].content;
  expect(stripped).toHaveLength(1);
  expect(stripped[0].text).toContain("较早视觉输入本轮未重复传输");
  expect(JSON.stringify(stripped)).not.toContain("page-a");
  expect(next[0].content).toContainEqual({ type: "text", text: taskText });
  expect(next[0].content).toContainEqual({
    type: "text",
    text: ordinaryCaption,
  });
  expect(pairs(next)).toHaveLength(3);
  expect(
    pairs(next).map((pair) => JSON.parse(pair.label.text).toolCallId),
  ).toEqual(["B", "B", "B"]);
  expect(pairs(history)).toHaveLength(3);
});

it.each(["file_read", "attachment_read"])(
  "labels each %s page with its registered image reference instead of the parent PDF asset",
  async (toolName) => {
    const pixels = await png();
    const prompt = hoistToolImages([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName,
            toolCallId: "read-pages",
            output: {
              type: "content",
              value: [
                {
                  type: "text",
                  text: JSON.stringify({
                    assetId: "parent-pdf",
                    filename: "book.pdf",
                    fileId: "parent-file",
                    imageReferences: [
                      { referenceImageId: "page-2", filename: "page-2.png" },
                      { referenceImageId: "page-3", filename: "page-3.png" },
                    ],
                  }),
                },
                frame(pixels),
                frame(pixels),
              ],
            },
          },
        ],
      },
    ]);
    const captions = pairs(await modelPromptImages(prompt)).map((pair) =>
      JSON.parse(pair.label.text),
    );
    expect(captions).toMatchObject([
      { referenceImageId: "page-2", filename: "page-2.png" },
      { referenceImageId: "page-3", filename: "page-3.png" },
    ]);
    expect(
      captions.every((caption) => !Object.hasOwn(caption, "assetId")),
    ).toBe(true);
  },
);

it.each(["image_candidate_view", "image_edit_preview"])(
  "does not grant %s visual proof after an adjacent source label is deleted or changed while all pixels and tool metadata survive",
  async (toolName) => {
    for (const change of ["delete", "replace", "swap"]) {
      const selected: ToolImageSelection[] = [];
      const prompt = await modelPromptImages(
        hoistToolImages(
          [diagnostic("A", "page-a", await png(), toolName)],
          4,
          (selection) => selected.push(selection),
        ),
      );
      const bound = bindToolImageFrames(selected, prompt);
      expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(
        toolName === "image_candidate_view" ? 3 : 2,
      );
      const content = prompt.at(-1).content;
      if (change === "delete") content.splice(1, 1);
      if (change === "replace")
        content[1] = {
          type: "text",
          text: JSON.stringify({ toolCallId: "B", referenceImageId: "page-b" }),
        };
      if (change === "swap")
        [content[1], content[3]] = [content[3], content[1]];
      const transmitted = transmittedToolImageFrames(prompt, bound);
      expect(transmitted.some((frame) => frame.frameIndex === 0)).toBe(false);
      expect(transmitted).toHaveLength(
        (toolName === "image_candidate_view" ? 3 : 2) -
          (change === "swap" ? 2 : 1),
      );
      expect(pairs(prompt)).toHaveLength(
        toolName === "image_candidate_view" ? 3 : 2,
      );
    }
  },
);
