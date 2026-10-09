import { it, expect } from "vitest";
import {
  bindToolImageFrames,
  hoistToolImages,
  transmittedToolImageFrames,
} from "../apps/server/src/services/ai/tool-media.js";
const image = (data: string) => ({
  type: "file",
  mediaType: "image/png",
  data: { type: "data", data },
});
const tool = (id: string, data: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      output: {
        type: "content",
        value: [{ type: "text", text: id }, image(data)],
      },
    },
  ],
});
const candidateGroup = (count: 3 | 4, declared = true) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "candidate",
      toolName: "image_candidate_view",
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "image_candidate_view",
              referenceImageId: "current-page",
              generationOperationId: "operation",
              source: { width: 1510, height: 2000 },
              raw: { displaySize: { width: 1166, height: 1555 } },
              generatedWindow: {
                left: 310,
                top: 473,
                width: 1166,
                height: 1338,
              },
            }),
          },
          ...(declared
            ? [
                {
                  type: "text",
                  text: JSON.stringify({
                    kind: "image_candidate_view_runtime",
                    frameCount: count,
                    sceneReferenceImageId:
                      count === 4
                        ? "11111111-1111-4111-8111-111111111111"
                        : null,
                    sceneStatus: count === 4 ? "included" : "not-merged",
                    reason: count === 4 ? null : "no-bound-adjacent-scene",
                  }),
                },
              ]
            : []),
          ...Array.from({ length: count }, (_, index) => [
            {
              type: "text",
              text: JSON.stringify(
                index === 3
                  ? {
                      label: "Scene original page",
                      view: "scene-context",
                      role: "scene-context",
                      coordinateSpace: "scene-source-page",
                      nonCitable: true,
                      referenceImageId: "11111111-1111-4111-8111-111111111111",
                      currentReferenceImageId: "current-page",
                      sourceRect: { left: 0, top: 0, width: 600, height: 900 },
                    }
                  : {
                      label: `Candidate base ${index}`,
                      view: ["source", "raw", "source-projection"][index],
                    },
              ),
            },
            image(`candidate-pixels-${index}`),
          ]).flat(),
        ],
      },
    },
  ],
});

it("transmits a revision diagnostic only as the complete original/base/raw group", () => {
  const group = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "revision",
        toolName: "image_revision_view",
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "image_revision_view",
                version: 1,
                generationOperationId: "revision-op",
                images: [
                  { referenceImageId: "original" },
                  { referenceImageId: "base" },
                  { referenceImageId: "raw" },
                ],
              }),
            },
            ...["original", "base", "raw"].flatMap((id) => [
              {
                type: "text",
                text: JSON.stringify({ label: id, role: id, nonCitable: true }),
              },
              image(id),
            ]),
          ],
        },
      },
    ],
  };
  for (const capacity of [2, 3]) {
    const selected: any[] = [];
    hoistToolImages([group], capacity, (frame) => selected.push(frame));
    expect(selected).toHaveLength(capacity === 3 ? 3 : 0);
    if (capacity === 3)
      expect(
        selected.map((frame) => JSON.parse(frame.labelText).referenceImageId),
      ).toEqual(["original", "base", "raw"]);
  }
});

it.each([3, 4] as const)(
  "requires the entire explicitly declared %s-frame candidate group",
  (count) => {
    for (const budget of [count - 1, count]) {
      const selected: any[] = [];
      const output = hoistToolImages([candidateGroup(count)], budget, (frame) =>
        selected.push(frame),
      );
      expect(selected).toHaveLength(budget === count ? count : 0);
      const files = output
        .flatMap((message) => message.content)
        .filter((part) => part.type === "file");
      expect(files).toHaveLength(budget === count ? count : 0);
      const visual = JSON.parse(
        output[0]!.content[0]!.output.value.at(-1)!.text,
      ).visualInput;
      expect(visual.transmittedImageCount).toBe(budget === count ? count : 0);
      if (count === 4 && budget === count) {
        const scene = JSON.parse(selected[3].labelText);
        expect(scene).toMatchObject({
          role: "scene-context",
          nonCitable: true,
          referenceImageId: "11111111-1111-4111-8111-111111111111",
          currentReferenceImageId: "current-page",
          sourceSize: { width: 600, height: 900 },
          sourceRect: { left: 0, top: 0, width: 600, height: 900 },
        });
        expect(scene).not.toHaveProperty("displaySize");
        expect(scene).not.toHaveProperty("generatedWindow");
      }
    }
  },
);

it.each(["label", "pixels", "metadata"])(
  "does not preserve fourth-frame transmission proof after changing its %s",
  (change) => {
    const selected: any[] = [];
    const prompt = hoistToolImages([candidateGroup(4)], 4, (frame) =>
      selected.push(frame),
    );
    const bound = bindToolImageFrames(selected, prompt);
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(4);
    const scene = prompt.at(-1)!.content;
    if (change === "label") scene[scene.length - 2].text += " changed";
    if (change === "pixels") scene.at(-1)!.data.data = "changed-pixels";
    if (change === "metadata")
      prompt[0]!.content[0]!.output.value[1].text += " changed";
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(
      change === "metadata" ? 0 : 3,
    );
  },
);

it("keeps historical candidate facts as text without inferring a missing runtime group declaration", () => {
  const output = hoistToolImages([candidateGroup(3, false)], 4);
  expect(
    output
      .flatMap((message) => message.content)
      .filter((part) => part.type === "file"),
  ).toHaveLength(0);
  expect(JSON.stringify(output)).toContain("operation");
  expect(JSON.stringify(output)).not.toContain("candidate-pixels-");
});
const recoveryPair = () => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "current-review-recovery",
      toolName: "image_batch",
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              code: "image_review_requires_fresh_view",
              referenceImageId: "source",
              assetId: "candidate",
              images: [
                { referenceImageId: "source", filename: "source.png" },
                {
                  referenceImageId: "candidate",
                  assetId: "candidate",
                  filename: "candidate.png",
                },
              ],
            }),
          },
          { type: "text", text: JSON.stringify({ label: "Current original" }) },
          image("source-pixels"),
          {
            type: "text",
            text: JSON.stringify({ label: "Current delivered candidate" }),
          },
          image("candidate-pixels"),
        ],
      },
    },
  ],
});
const revisionSource = "11111111-1111-4111-8111-111111111111";
const revisionBase = "22222222-2222-4222-8222-222222222222";
const savedLocalPreviewGroup = () => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "local-selection-preview",
      toolName: "image_edit_saved_local_preview",
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "image_revision_local_preview",
              version: 1,
              paid: false,
              images: [
                {
                  referenceImageId: revisionSource,
                  filename: "original.png",
                  role: "original-context",
                  coordinateSpace: "original-page",
                  selectionCoordinateSpace: null,
                  sourceSize: { width: 1200, height: 1800 },
                  displaySize: { width: 800, height: 1200 },
                  sourceRect: { left: 0, top: 0, width: 1200, height: 1800 },
                  contentRect: { left: 0, top: 0, width: 800, height: 1200 },
                },
                {
                  referenceImageId: revisionBase,
                  assetId: revisionBase,
                  filename: "current.png",
                  role: "full-current-coverage",
                  coordinateSpace: "current-base",
                  selectionCoordinateSpace: "current-base",
                  sourceSize: { width: 1440, height: 2048 },
                  displaySize: { width: 1125, height: 1600 },
                  sourceRect: { left: 0, top: 0, width: 1440, height: 2048 },
                  nativeRect: { left: 360, top: 512, width: 216, height: 307 },
                  workspace: {
                    width: 1024,
                    height: 1536,
                    objectKey: "private-workspace",
                  },
                },
                {
                  referenceImageId: revisionBase,
                  assetId: revisionBase,
                  filename: "local-coverage.png",
                  role: "local-coverage",
                  coordinateSpace: "current-base",
                  selectionCoordinateSpace: "current-base",
                  sourceSize: { width: 1440, height: 2048 },
                  displaySize: { width: 344, height: 435 },
                  sourceRect: { left: 296, top: 448, width: 344, height: 435 },
                  nativeRect: { left: 360, top: 512, width: 216, height: 307 },
                  workspace: { width: 1024, height: 1536 },
                  objectKey: "private-source",
                  nativeUsage: { token: "private-usage" },
                  internalIdentity: "private-frame",
                  sha256: "private-hash",
                },
              ],
              next: {
                toolName: "image_edit_saved_local",
                input: {
                  originalReferenceImageId: revisionSource,
                  baseAssetId: revisionBase,
                },
              },
            }),
          },
          ...[
            "Frozen original",
            "Current complete base",
            "Current local selection",
          ].flatMap((label, index) => [
            { type: "text", text: JSON.stringify({ label }) },
            image(`local-preview-pixels-${index}`),
          ]),
        ],
      },
    },
  ],
});

it.each([0, 1, 2, 3])(
  "sends local saved-base preview only as its complete three-frame group at capacity %s",
  (capacity) => {
    const selected: any[] = [];
    const prompt = hoistToolImages(
      [savedLocalPreviewGroup()],
      capacity,
      (frame) => selected.push(frame),
    );
    const expected = capacity === 3 ? 3 : 0;
    expect(selected).toHaveLength(expected);
    expect(
      prompt.at(-1)!.content.filter((part: any) => part.type === "file"),
    ).toHaveLength(expected);
    expect(
      transmittedToolImageFrames(prompt, bindToolImageFrames(selected, prompt)),
    ).toHaveLength(expected);
    const visual = JSON.parse(
      prompt[0]!.content[0]!.output.value.at(-1)!.text,
    ).visualInput;
    expect(visual).toMatchObject({
      originalImageCount: 3,
      transmittedImageCount: expected,
    });
    if (expected === 0) {
      expect(visual.untransmitted.map((frame: any) => frame.label)).toEqual([
        "Frozen original",
        "Current complete base",
        "Current local selection",
      ]);
      expect(visual.instruction).toContain(
        "单独重新调用 image_edit_saved_local_preview",
      );
      expect(visual.instruction).toContain("image_view不能代替");
      expect(JSON.stringify(prompt)).not.toContain("local-preview-pixels-");
    } else {
      const labels = selected.map((frame) => JSON.parse(frame.labelText));
      expect(labels).toMatchObject([
        {
          toolName: "image_edit_saved_local_preview",
          toolCallId: "local-selection-preview",
          toolImage: 1,
          label: "Frozen original",
          role: "original-context",
          referenceImageId: revisionSource,
          selectionCoordinateSpace: null,
          sourceSize: { width: 1200, height: 1800 },
          sourceRect: { left: 0, top: 0, width: 1200, height: 1800 },
        },
        {
          toolImage: 2,
          label: "Current complete base",
          role: "full-current-coverage",
          referenceImageId: revisionBase,
          assetId: revisionBase,
          coordinateSpace: "current-base",
          sourceSize: { width: 1440, height: 2048 },
          nativeRect: { left: 360, top: 512, width: 216, height: 307 },
          workspace: { width: 1024, height: 1536 },
        },
        {
          toolImage: 3,
          label: "Current local selection",
          role: "local-coverage",
          referenceImageId: revisionBase,
          coordinateSpace: "current-base",
          displaySize: { width: 344, height: 435 },
          sourceRect: { left: 296, top: 448, width: 344, height: 435 },
          workspace: { width: 1024, height: 1536 },
        },
      ]);
      expect(labels[0]).not.toHaveProperty("nativeRect");
      expect(JSON.stringify(labels)).not.toContain("private-");
    }
  },
);

it.each([0, 1, 2])(
  "preserves the four-frame budget when %s ordinary images precede a local preview in the same exchange",
  (preceding) => {
    const selected: any[] = [];
    const prompt = hoistToolImages(
      [
        ...Array.from({ length: preceding }, (_, index) =>
          tool(`ordinary-${index}`, `ordinary-pixels-${index}`),
        ),
        savedLocalPreviewGroup(),
      ],
      4,
      (frame) => selected.push(frame),
    );
    const localCount = preceding <= 1 ? 3 : 0;
    expect(
      selected.filter(
        (frame) => frame.toolName === "image_edit_saved_local_preview",
      ),
    ).toHaveLength(localCount);
    expect(
      prompt.at(-1)!.content.filter((part: any) => part.type === "file"),
    ).toHaveLength(preceding + localCount);
  },
);

it.each([1, 2, 4])(
  "withholds an incorrectly sized %s-frame local preview even with enough available capacity",
  (count) => {
    const group = savedLocalPreviewGroup();
    const metadata = group.content[0]!.output.value[0]!;
    group.content[0]!.output.value = [
      metadata,
      ...Array.from({ length: count }, (_, index) =>
        image(`incomplete-${index}`),
      ),
    ];
    const selected: any[] = [];
    const prompt = hoistToolImages([group], 4, (frame) => selected.push(frame));
    expect(selected).toHaveLength(0);
    expect(
      transmittedToolImageFrames(prompt, bindToolImageFrames(selected, prompt)),
    ).toHaveLength(0);
  },
);

it.each(["tool-name", "kind", "version", "paid", "missing-paid"])(
  "does not grant a local-preview atomic group to a forged %s",
  (change) => {
    const group = savedLocalPreviewGroup(),
      part = group.content[0]!;
    const metadata = part.output.value[0]! as { type: string; text: string },
      facts = JSON.parse(metadata.text);
    if (change === "tool-name") part.toolName = "image_edit_saved_local";
    if (change === "kind") facts.kind = "image_revision";
    if (change === "version") facts.version = 2;
    if (change === "paid") facts.paid = true;
    if (change === "missing-paid") delete facts.paid;
    metadata.text = JSON.stringify(facts);
    const selected: any[] = [];
    hoistToolImages([group], 1, (frame) => selected.push(frame));
    expect(selected).toHaveLength(1);
    expect(JSON.parse(selected[0].labelText)).not.toHaveProperty(
      "referenceImageId",
    );
  },
);

it.each(["label", "frame-coordinates", "pixels", "receipt", "removed-frame"])(
  "does not confirm a complete local-preview proof after changing %s",
  (change) => {
    const selected: any[] = [];
    const prompt = hoistToolImages([savedLocalPreviewGroup()], 3, (frame) =>
      selected.push(frame),
    );
    const bound = bindToolImageFrames(selected, prompt);
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(3);
    const content = prompt.at(-1)!.content;
    if (change === "label") content[1].text += "changed";
    if (change === "frame-coordinates") {
      const label = JSON.parse(content[5].text);
      label.sourceRect.left += 1;
      content[5].text = JSON.stringify(label);
    }
    if (change === "pixels") content[6].data.data = "changed-pixels";
    if (change === "removed-frame") content.splice(5, 2);
    if (change === "receipt") {
      const metadata = prompt[0]!.content[0]!.output.value[0],
        facts = JSON.parse(metadata.text);
      facts.images[2].nativeRect.left += 1;
      metadata.text = JSON.stringify(facts);
    }
    const transmitted = transmittedToolImageFrames(prompt, bound);
    expect(transmitted).toHaveLength(change === "receipt" ? 0 : 2);
    expect(transmitted.map((frame) => frame.sourceDigest)).toEqual(
      bound
        .filter((_, index) => index !== (change === "label" ? 0 : 2))
        .slice(0, change === "receipt" ? 0 : undefined)
        .map((frame) => frame.sourceDigest),
    );
  },
);

it("keeps an ordinary paid local revision result as one image without a selection-preview group", () => {
  const group = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "paid-local-edit",
        toolName: "image_edit_saved_local",
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "image_revision",
                version: 2,
                mode: "local",
                state: "saved",
                assetId: revisionBase,
                filename: "local-delivered.png",
                paid: true,
              }),
            },
            image("paid-local-result"),
          ],
        },
      },
    ],
  };
  const selected: any[] = [];
  const prompt = hoistToolImages([group], 1, (frame) => selected.push(frame));
  expect(selected).toHaveLength(1);
  expect(JSON.parse(selected[0].labelText)).toMatchObject({
    toolName: "image_edit_saved_local",
    assetId: revisionBase,
    filename: "local-delivered.png",
  });
  expect(
    transmittedToolImageFrames(prompt, bindToolImageFrames(selected, prompt)),
  ).toHaveLength(1);
});
const savedEditPreflightPair = () => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "saved-edit-preflight",
      toolName: "image_edit_saved",
      output: {
        type: "content",
        value: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              code: "image_revision_view_required",
              paid: false,
              images: [
                { referenceImageId: revisionSource, filename: "original.png" },
                {
                  referenceImageId: revisionBase,
                  assetId: revisionBase,
                  filename: "current.png",
                },
              ],
              next: {
                toolName: "image_view",
                input: { referenceImageIds: [revisionSource, revisionBase] },
              },
            }),
          },
          {
            type: "text",
            text: JSON.stringify({ label: "Frozen original page" }),
          },
          image("preflight-original-pixels"),
          {
            type: "text",
            text: JSON.stringify({ label: "Current saved base" }),
          },
          image("preflight-base-pixels"),
        ],
      },
    },
  ],
});

it.each([0, 1, 2])(
  "sends the unpaid saved-edit preflight pair atomically at capacity %s",
  (capacity) => {
    const selected: any[] = [];
    const prompt = hoistToolImages(
      [savedEditPreflightPair()],
      capacity,
      (frame) => selected.push(frame),
    );
    const visual = JSON.parse(
      prompt[0]!.content[0]!.output.value.at(-1)!.text,
    ).visualInput;
    expect(selected).toHaveLength(capacity === 2 ? 2 : 0);
    expect(
      prompt.at(-1)!.content.filter((part: any) => part.type === "file"),
    ).toHaveLength(capacity === 2 ? 2 : 0);
    const actual = transmittedToolImageFrames(
      prompt,
      bindToolImageFrames(selected, prompt),
    );
    expect(actual).toHaveLength(capacity === 2 ? 2 : 0);
    if (capacity === 2) {
      expect(
        selected.map((frame) => JSON.parse(frame.labelText)),
      ).toMatchObject([
        {
          toolName: "image_edit_saved",
          toolImage: 1,
          label: "Frozen original page",
          referenceImageId: revisionSource,
          filename: "original.png",
        },
        {
          toolName: "image_edit_saved",
          toolImage: 2,
          label: "Current saved base",
          referenceImageId: revisionBase,
          assetId: revisionBase,
          filename: "current.png",
        },
      ]);
      expect(actual.map((frame) => frame.frameIndex)).toEqual([0, 1]);
    } else {
      expect(visual).toMatchObject({
        originalImageCount: 2,
        transmittedImageCount: 0,
      });
      expect(
        visual.untransmitted.map((frame: any) => frame.referenceImageId),
      ).toEqual([revisionSource, revisionBase]);
      expect(visual.instruction).toContain("image_view");
      expect(visual.instruction).toContain(revisionSource);
      expect(visual.instruction).toContain(revisionBase);
      expect(JSON.stringify(prompt)).not.toContain("preflight-original-pixels");
      expect(JSON.stringify(prompt)).not.toContain("preflight-base-pixels");
    }
  },
);

it.each(["metadata", "label"])(
  "loses complete saved-edit preflight transmission proof after changing %s",
  (change) => {
    const selected: any[] = [];
    const prompt = hoistToolImages([savedEditPreflightPair()], 2, (frame) =>
      selected.push(frame),
    );
    const bound = bindToolImageFrames(selected, prompt);
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(2);
    if (change === "metadata") {
      const receipt = prompt[0]!.content[0]!.output.value[0];
      const facts = JSON.parse(receipt.text);
      facts.images[0].referenceImageId = revisionBase;
      receipt.text = JSON.stringify(facts);
    } else {
      const label = prompt.at(-1)!.content[1];
      const facts = JSON.parse(label.text);
      facts.referenceImageId = revisionBase;
      label.text = JSON.stringify(facts);
    }
    expect(transmittedToolImageFrames(prompt, bound)).toHaveLength(
      change === "metadata" ? 0 : 1,
    );
  },
);

it.each(["paid", "missing-paid", "different-code"])(
  "does not classify a saved-edit %s output as a free atomic recovery pair",
  (change) => {
    const group = savedEditPreflightPair();
    const receipt = group.content[0]!.output.value[0]! as {
      type: string;
      text: string;
    };
    const facts = JSON.parse(receipt.text);
    if (change === "paid") facts.paid = true;
    if (change === "missing-paid") delete facts.paid;
    if (change === "different-code") facts.code = "image_revision_base_stale";
    receipt.text = JSON.stringify(facts);
    const selected: any[] = [];
    hoistToolImages([group], 1, (frame) => selected.push(frame));
    expect(selected).toHaveLength(1);
    expect(JSON.parse(selected[0].labelText)).not.toHaveProperty(
      "referenceImageId",
    );
  },
);

it("keeps an ordinary paid saved-edit result as one current candidate frame", () => {
  const group = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "paid-saved-edit",
        toolName: "image_edit_saved",
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "image_revision",
                state: "saved",
                assetId: revisionBase,
                filename: "delivered.png",
                ready: true,
              }),
            },
            image("actual-paid-result-pixels"),
          ],
        },
      },
    ],
  };
  const selected: any[] = [];
  const prompt = hoistToolImages([group], 1, (frame) => selected.push(frame));
  expect(selected).toHaveLength(1);
  expect(JSON.parse(selected[0].labelText)).toMatchObject({
    assetId: revisionBase,
    filename: "delivered.png",
  });
  expect(
    transmittedToolImageFrames(prompt, bindToolImageFrames(selected, prompt)),
  ).toHaveLength(1);
});

it("withholds an incomplete saved-edit preflight pair even with two available slots", () => {
  const group = savedEditPreflightPair();
  group.content[0]!.output.value = group.content[0]!.output.value.slice(0, 3);
  const selected: any[] = [];
  const prompt = hoistToolImages([group], 2, (frame) => selected.push(frame));
  expect(selected).toHaveLength(0);
  expect(
    prompt.at(-1)!.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(0);
});

it.each([0, 1, 2])(
  "requires both current recovery frames at budget %s and labels their actual distinct IDs",
  (budget) => {
    const selected: any[] = [];
    const result = hoistToolImages([recoveryPair()], budget, (frame) =>
      selected.push(frame),
    );
    const actual =
      result.at(-1)?.content.filter((part: any) => part.type === "file") ?? [];
    expect(actual).toHaveLength(budget === 2 ? 2 : 0);
    expect(selected).toHaveLength(budget === 2 ? 2 : 0);
    const visual = JSON.parse(
      result[0]!.content[0]!.output.value.at(-1)!.text,
    ).visualInput;
    expect(visual.originalImageCount).toBe(2);
    expect(visual.transmittedImageCount).toBe(budget === 2 ? 2 : 0);
    if (budget === 2) {
      expect(visual.transmitted).toEqual([
        {
          toolImage: 1,
          label: "Current original",
          referenceImageId: "source",
          filename: "source.png",
        },
        {
          toolImage: 2,
          label: "Current delivered candidate",
          referenceImageId: "candidate",
          assetId: "candidate",
          filename: "candidate.png",
        },
      ]);
      expect(selected.map((frame) => frame.frameIndex)).toEqual([0, 1]);
    } else {
      expect(visual.untransmitted).toHaveLength(2);
      expect(visual.instruction).toContain("image_view");
      expect(JSON.stringify(result)).not.toContain("source-pixels");
      expect(JSON.stringify(result)).not.toContain("candidate-pixels");
    }
  },
);

it("withholds a recovery pair when parallel tools leave only one frame, without weakening other image budgets", () => {
  const result = hoistToolImages(
    [tool("one", "a"), tool("two", "b"), tool("three", "c"), recoveryPair()],
    4,
  );
  expect(
    result.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(3);
  const visual = JSON.parse(
    result[3]!.content[0]!.output.value.at(-1)!.text,
  ).visualInput;
  expect(visual).toMatchObject({
    originalImageCount: 2,
    transmittedImageCount: 0,
  });
  expect(
    visual.untransmitted.map((frame: any) => frame.referenceImageId),
  ).toEqual(["source", "candidate"]);
});

it("does not transport an incomplete recovery output even when two slots remain", () => {
  const partial = recoveryPair();
  partial.content[0]!.output.value = partial.content[0]!.output.value.slice(
    0,
    3,
  );
  const result = hoistToolImages([partial], 4);
  expect(
    result.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain("source-pixels");
});
it("presents all images in the latest parallel tool exchange as actual user file parts and keeps textual receipts", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "original task" }] },
    { role: "assistant", content: [] },
    tool("older", "old pixels"),
    { role: "assistant", content: [] },
    tool("page1", "one"),
    tool("page2", "two"),
  ];
  const result = hoistToolImages(prompt);
  expect(
    result.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toEqual([image("one"), image("two")]);
  expect(JSON.stringify(result.slice(0, -1))).not.toContain("pixels");
  expect(JSON.stringify(result.slice(0, -1))).toContain("page1");
  expect(prompt[2]).toEqual(tool("older", "old pixels"));
});

it("stores a resumable source receipt without embedding image binaries in checkpoints", async () => {
  const { checkpointMessages } =
    await import("../apps/server/src/services/ai/checkpoint.js");
  const messages: any[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "read",
          toolName: "attachment_read",
          input: { assetId: "source" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read",
          output: {
            type: "json",
            value: {
              assetId: "source",
              imageReferences: [{ referenceImageId: "page" }],
            },
          },
          providerOptions: {
            mastra: {
              modelOutput: {
                type: "content",
                value: [
                  { type: "text", text: "receipt" },
                  {
                    type: "media",
                    data: "massive pixels",
                    mediaType: "image/png",
                  },
                ],
              },
            },
          },
        },
      ],
    },
  ];
  messages[0]!.content[0]!.providerOptions =
    messages[1]!.content[0]!.providerOptions;
  const saved = checkpointMessages(messages);
  expect(JSON.stringify(saved)).not.toContain("massive pixels");
  expect(JSON.stringify(saved)).toContain("source");
  expect(JSON.stringify(saved)).toContain("page");
  expect(JSON.stringify(messages)).toContain("massive pixels");
});

it("bounds the total images after a visual read, including upload previews, and accepts textual continuation messages", async () => {
  const prompt = [
    {
      role: "user",
      content: [
        { type: "text", text: "task with persistent source ids" },
        image("earlier preview"),
      ],
    },
    { role: "assistant", content: [] },
    tool("current", "current pixels"),
  ];
  expect(JSON.stringify(hoistToolImages(prompt))).not.toContain(
    "earlier preview",
  );
  expect(
    hoistToolImages(prompt)
      .flatMap((message) => message.content)
      .filter((part) => part.type === "file"),
  ).toHaveLength(1);
  const { checkpointMessages } =
    await import("../apps/server/src/services/ai/checkpoint.js");
  expect(checkpointMessages([{ role: "user", content: "continue" }])).toEqual([
    { role: "user", content: "continue" },
  ]);
});

it("bounds simultaneous visual inputs and explicitly reports unseen images for another read", () => {
  const prompt = [
    { role: "assistant", content: [] },
    tool("one", "a"),
    tool("two", "b"),
    tool("three", "c"),
  ];
  const result = hoistToolImages(prompt, 2);
  expect(
    result.at(-1)?.content.filter((p: any) => p.type === "file"),
  ).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('"data":"c"');
  expect(JSON.stringify(result)).toContain("尚未传入");
  expect(JSON.stringify(result)).toContain("image_view");
});

it.each([
  "image_mask_prepare",
  "image_mask_segment",
  "image_mask_segment_view",
  "image_mask_view",
])(
  "transmits both %s frames or neither after other tools consume the image budget",
  (name) => {
    const diagnostic = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "proposal",
          toolName: name,
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: JSON.stringify({
                  referenceImageId: "source",
                  proposalReceiptId: "proposal",
                }),
              },
              {
                type: "text",
                text: JSON.stringify({
                  view: "full",
                  sourceRect: { left: 0, top: 0, width: 200, height: 300 },
                }),
              },
              image("full-pixels"),
              {
                type: "text",
                text: JSON.stringify({
                  view: "local",
                  sourceRect: { left: 10, top: 20, width: 80, height: 90 },
                }),
              },
              image("local-pixels"),
            ],
          },
        },
      ],
    };
    const crowded = hoistToolImages(
      [tool("one", "a"), tool("two", "b"), tool("three", "c"), diagnostic],
      4,
    );
    expect(
      crowded.at(-1)?.content.filter((p: any) => p.type === "file"),
    ).toHaveLength(3);
    expect(JSON.stringify(crowded)).not.toContain("full-pixels");
    expect(JSON.stringify(crowded)).not.toContain("local-pixels");
    const omitted = JSON.parse(
      crowded[3]!.content[0]!.output.value.at(-1)!.text,
    ).visualInput;
    expect(omitted).toMatchObject({
      originalImageCount: 2,
      transmittedImageCount: 0,
    });
    expect(omitted.untransmitted).toHaveLength(2);
    expect(omitted.instruction).toContain(
      name === "image_mask_prepare" || name === "image_mask_view"
        ? "image_mask_view"
        : "image_mask_segment_view",
    );
    const complete = hoistToolImages([diagnostic], 4);
    expect(
      complete.at(-1)?.content.filter((p: any) => p.type === "file"),
    ).toHaveLength(2);
  },
);
it("transmits a native mask region's three frames atomically and names its own retry tool", () => {
  const diagnostic = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "native-region",
        toolName: "image_mask_region_view",
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: JSON.stringify({
                maskReceiptId: "mask",
                referenceImageId: "source",
                generationOperationId: "raw",
              }),
            },
            ...["source-region", "raw-region", "mask-region-overlay"].flatMap(
              (view) => [
                {
                  type: "text",
                  text: JSON.stringify({
                    view,
                    coordinateSpace: "source",
                    sourceRect: { left: 20, top: 30, width: 50, height: 60 },
                  }),
                },
                image(view),
              ],
            ),
          ],
        },
      },
    ],
  };
  const crowded = hoistToolImages(
    [tool("one", "a"), tool("two", "b"), diagnostic],
    4,
  );
  expect(
    crowded.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(2);
  const omitted = JSON.parse(
    crowded[2]!.content[0]!.output.value.at(-1)!.text,
  ).visualInput;
  expect(omitted).toMatchObject({
    originalImageCount: 3,
    transmittedImageCount: 0,
  });
  expect(omitted.untransmitted).toHaveLength(3);
  expect(omitted.instruction).toContain("image_mask_region_view");
  const selected: any[] = [];
  const complete = hoistToolImages([diagnostic], 4, (frame) =>
    selected.push(frame),
  );
  expect(
    complete.at(-1)?.content.filter((part: any) => part.type === "file"),
  ).toHaveLength(3);
  expect(selected.map((frame) => frame.toolName)).toEqual(
    Array(3).fill("image_mask_region_view"),
  );
  expect(selected.map((frame) => frame.frameIndex)).toEqual([0, 1, 2]);
});
