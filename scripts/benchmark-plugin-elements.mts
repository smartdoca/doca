// Run: node --import tsx scripts/benchmark-plugin-elements.mts
// CPU microbenchmarks, not a claim about third-party renderers or browser paint.
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { YjsDocument } from "@smartdoca/slate/yjs";
import {
  DocaYjsDocument,
  referenceCodec,
  mentionCodec,
} from "../packages/core/src/modules/documents/codecs/rich-runtime.js";
import { validateSheetPluginElements } from "../packages/core/src/modules/documents/codecs/surfaces.js";
import {
  createPluginElementPayload,
  pluginElementState,
} from "../packages/web-plugin-registry/src/editor-elements.js";
import example from "../examples/plugin-elements/web/index.js";

function median(values: number[]) {
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
function sample(run: () => void, count = 101) {
  for (let i = 0; i < 20; i++) run();
  return median(
    Array.from({ length: count }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }),
  );
}
const plain = Array.from({ length: 1000 }, (_, index) => ({
  id: randomUUID(),
  type: "paragraph",
  children: [{ text: `Paragraph ${index}: ${"sample text ".repeat(10)}` }],
}));
const docBefore = new Y.Doc(),
  before = new YjsDocument(docBefore, {
    inlineCodecs: [referenceCodec, mentionCodec],
  });
const docAfter = new Y.Doc(),
  after = new DocaYjsDocument(docAfter);
before.initialize(plain as any);
after.initialize(plain as any);
const pairs: { before: number; after: number }[] = [];
for (let round = 0; round < 21; round++) {
  const measureBefore = () =>
    sample(() => {
      before.getValue();
    }, 11);
  const measureAfter = () =>
    sample(() => {
      after.getValue();
    }, 11);
  // Alternate order to reduce warmup/CPU-frequency bias.
  if (round % 2) {
    const a = measureAfter();
    pairs.push({ before: measureBefore(), after: a });
  } else {
    const b = measureBefore();
    pairs.push({ before: b, after: measureAfter() });
  }
}
const elements = example({ React: {} } as any).elements;
const countdown = elements[0]!;
const payload = createPluginElementPayload(
  countdown,
  { label: "Launch", targetAt: "2026-10-04T00:00:00.000Z" },
  "en",
);
const cells: Record<string, Record<string, any>> = {};
for (let r = 0; r < 1000; r++) {
  cells[r] = {};
  for (let c = 0; c < 10; c++) cells[r]![c] = { v: r * 10 + c, t: 2 };
}
const workbook = { sheets: { sheet: { cellData: cells } } };
const plainValidation = sample(() => validateSheetPluginElements(workbook));
for (let r = 0; r < 100; r++)
  cells[r]![0] = { v: payload.text, custom: { docaElement: payload } };
const populatedValidation = sample(() => validateSheetPluginElements(workbook));
const canvas = { fillStyle: "", font: "", textBaseline: "", fillText() {} };
const context = {
  documentId: "benchmark",
  format: "spreadsheet" as const,
  locale: "en" as const,
  readOnly: false,
  signal: new AbortController().signal,
  canvas: canvas as unknown as CanvasRenderingContext2D,
  rect: { x: 0, y: 0, width: 250, height: 40 },
};
const firstValidation100 = sample(() => {
  for (let i = 0; i < 100; i++)
    pluginElementState(payload, countdown, "spreadsheet");
});
const callbacks100 = sample(() => {
  for (let i = 0; i < 100; i++)
    countdown.renderCell!({ ...context, payload: structuredClone(payload) });
});
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      rich1000ParagraphProjectionMs: {
        before: median(pairs.map((pair) => pair.before)),
        after: median(pairs.map((pair) => pair.after)),
        pairedMedianDelta: median(
          pairs.map((pair) => pair.after - pair.before),
        ),
      },
      sheetExtraValidation10000OccupiedCellsMs: {
        noElements: plainValidation,
        with100Elements: populatedValidation,
      },
      elements100Ms: {
        firstValidation: firstValidation100,
        cloneAndExampleDrawCallbacks: callbacks100,
      },
      limits:
        "CPU microbenchmarks; canvas mock excludes native painting. No universal third-party renderer guarantee.",
    },
    null,
    2,
  ),
);
before.destroy();
after.destroy();
docBefore.destroy();
docAfter.destroy();
