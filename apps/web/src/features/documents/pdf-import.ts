import { translate } from "@doca/i18n";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { importPdfFile, type PdfImportResult } from "@smartdoca/markdown";
import { createTableBlock, type EditorValue, type RichElement, type RichText, type ParagraphElement } from "@smartdoca/slate/headless";
import { exportDocument } from "@smartdoca/slate/conversion";

export interface PdfTextRun { text: string; x: number; y: number; width: number; size: number; font: string; color?: string; link?: string; }
interface Line { y: number; runs: PdfTextRun[]; }
const id = () => crypto.randomUUID();
const paragraph = (children: ParagraphElement["children"], extra = {}): RichElement => ({ type: "paragraph", id: id(), children, ...extra });

function marks(run: PdfTextRun): RichText {
  const font = run.font;
  return { text: run.text, fontSize: Math.max(8, Math.min(96, Math.round(run.size * 4 / 3))),
    ...(/bold|black|heavy|semibold/i.test(font) ? { bold: true } : {}),
    ...(/italic|oblique/i.test(font) ? { italic: true } : {}),
    ...(run.color ? { color: run.color } : {}),
    ...(/courier|mono|consolas/i.test(font) ? { fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace' } : {}),
    ...(/times|georgia|songti|simsun|stsong|serif/i.test(font) && !/sans/i.test(font) ? { fontFamily: '"Songti SC", SimSun, "Times New Roman", serif' } : {}),
  };
}

function leaves(runs: PdfTextRun[]) {
  const children: ParagraphElement["children"] = [];
  for (const [index, run] of runs.entries()) {
    const previous = runs[index - 1];
    const gap = previous ? run.x - previous.x - previous.width : 0;
    if (previous && gap > Math.min(previous.size, run.size) * .15 && !/\s$/.test(previous.text) && !/^\s/.test(run.text)) children.push({ text: " " });
    children.push(run.link ? { type: "link", id: id(), url: run.link, children: [marks(run)] } : marks(run));
  }
  return children.length ? children : [{ text: "" }];
}

function textColors(operators: { fnArray: number[]; argsArray: any[] }) {
  let color = "#000000";
  const stack: string[] = [], spans: { text: string; color: string }[] = [];
  const channel = (value: number) => Math.round(Math.max(0, Math.min(255, value <= 1 ? value * 255 : value))).toString(16).padStart(2, "0");
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i];
    if (op === OPS.save) stack.push(color);
    else if (op === OPS.restore) color = stack.pop() ?? "#000000";
    else if (op === OPS.setFillRGBColor) color = typeof args[0] === "string" ? args[0] : `#${args.map(channel).join("")}`;
    else if (op === OPS.setFillGray) color = `#${channel(args[0]).repeat(3)}`;
    else if (op === OPS.showText && Array.isArray(args[0])) {
      const text = args[0].map((glyph: any) => glyph?.unicode ?? "").join("");
      if (text) spans.push({ text, color });
    }
  }
  return spans;
}

/** Coordinates/font runs stay native; no Markdown roundtrip for rich-text imports. */
export function pdfTextBlocks(runs: PdfTextRun[], pageWidth: number): { y: number; block: RichElement }[] {
  const lines: Line[] = [];
  for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (!run.text.trim()) continue;
    let line = lines.find(line => Math.abs(line.y - run.y) <= Math.max(2, run.size * .25));
    if (!line) { line = { y: run.y, runs: [] }; lines.push(line); }
    line.runs.push(run);
  }
  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  const weights = new Map<number, number>();
  for (const run of runs) weights.set(Math.round(run.size), (weights.get(Math.round(run.size)) ?? 0) + run.text.length);
  const bodySize = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const headingSizes = [...new Set(lines.filter(line => {
    const count = line.runs.reduce((sum, run) => sum + run.text.length, 0);
    return count < 160 && line.runs.filter(run => run.size >= bodySize * 1.25).reduce((sum, run) => sum + run.text.length, 0) >= count * .85;
  }).map(line => Math.round(Math.max(...line.runs.map(run => run.size)))))].sort((a, b) => b - a);
  const result: { y: number; block: RichElement }[] = [];
  // A table requires repeated column positions and visible gaps, not just two text runs.
  const cells = (line: Line) => {
    const groups: PdfTextRun[][] = [];
    for (const run of line.runs) {
      const previous = groups.at(-1)?.at(-1);
      if (!previous || run.x - previous.x - previous.width > Math.max(16, run.size * 2)) groups.push([]);
      groups.at(-1)!.push(run);
    }
    return groups;
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const columns = cells(line);
    const rows = [columns];
    if (columns.length > 1 && columns.length <= 12) {
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = cells(lines[next]!);
        if (candidate.length !== columns.length || lines[next - 1]!.y - lines[next]!.y > bodySize * 3 || !candidate.every((cell, col) => Math.abs(cell[0]!.x - columns[col]![0]!.x) < 8)) break;
        rows.push(candidate);
      }
    }
    if (rows.length >= 3) {
      const table = createTableBlock(rows.length, columns.length);
      table.columns.forEach((column, col) => { column.width = Math.max(48, (columns[col + 1]?.[0]?.x ?? pageWidth - columns[0]![0]!.x) - columns[col]![0]!.x) * 4 / 3; });
      table.children.forEach((row, r) => {
        if ("children" in row) row.children.forEach((cell, c) => {
          if ("children" in cell) cell.children = [paragraph(leaves(rows[r]![c]!))];
        });
      });
      result.push({ y: line.y, block: table }); index += rows.length; continue;
    }
    const left = line.runs[0]!.x, right = Math.max(...line.runs.map(run => run.x + run.width));
    const centered = Math.abs((left + right) / 2 - pageWidth / 2) < 8 && left > pageWidth * .15;
    const size = Math.max(...line.runs.map(run => run.size));
    const ratio = size / bodySize;
    const characters = line.runs.reduce((sum, run) => sum + run.text.length, 0);
    const headingCharacters = line.runs.filter(run => run.size >= bodySize * 1.25).reduce((sum, run) => sum + run.text.length, 0);
    const title = ratio >= 1.25 && headingCharacters >= characters * .85 && characters < 160 ? `h${Math.min(5, headingSizes.indexOf(Math.round(size)) + 1)}` : undefined;
    const bullet = /^(?:[•●▪‣◦]\s*|[0-9]+[.)]\s+|[☑☐]\s*)/.exec(line.runs[0]!.text);
    const content = bullet ? line.runs.map((run, i) => i === 0 ? { ...run, text: run.text.slice(bullet[0].length) } : run) : line.runs;
    const list = bullet ? (/^[☑☐]/.test(bullet[0]) ? "checkbox" : /^[0-9]/.test(bullet[0]) ? "ol" : "ul") : undefined;
    result.push({ y: line.y, block: paragraph(leaves(content), { ...(title ? { title } : {}), ...(centered ? { align: "center" } : {}), ...(list ? { list, ...(list === "checkbox" ? { checked: bullet![0].startsWith("☑") } : {}), ...(list === "ol" ? { listOrder: parseInt(bullet![0]) } : {}) } : {}) }) });
    index++;
  }
  return result;
}

export async function importEditablePdf(file: File, signal?: AbortSignal, locale = "zh"): Promise<PdfImportResult & { initialValue: EditorValue }> {
  // The shipped parser supplies format/size/password/page limits, links, assets and warnings.
  const extracted = await importPdfFile(file, { signal, locale });
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  bounded.throwIfAborted();
  const loading = getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true });
  const abort = () => { void loading.destroy(); };
  bounded.addEventListener("abort", abort, { once: true });
  const blocks: RichElement[] = [];
  try {
    const document = await loading.promise;
    for (let number = 1; number <= document.numPages; number++) {
      bounded.throwIfAborted();
      const page = await document.getPage(number);
      try {
        const text = await page.getTextContent();
        const operators = await page.getOperatorList(); // populates font names in commonObjs
        const colors = textColors(operators);
        if (operators.fnArray.some(op => [OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(op))) extracted.warnings.push({ code: "COMPLEX_LAYOUT", page: number, message: translate(locale === "zh" ? "zh" : "en", "pdf.importLayoutApproximate") });
        let colorIndex = 0;
        const runs: PdfTextRun[] = text.items.flatMap(item => {
          if (!("str" in item) || !item.str) return [];
          const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null;
          const match = colors.findIndex((span, index) => index >= colorIndex && span.text.includes(item.str));
          if (match >= 0) colorIndex = match;
          return [{ text: item.str, x: item.transform[4]!, y: item.transform[5]!, width: item.width, size: Math.hypot(item.transform[2]!, item.transform[3]!) || item.height, font: font?.name ?? text.styles[item.fontName]?.fontFamily ?? "", ...(match >= 0 ? { color: colors[match]!.color } : {}) }];
        });
        for (const annotation of await page.getAnnotations()) {
          if (typeof annotation.url !== "string" || !/^(https?:|mailto:)/i.test(annotation.url)) continue;
          const rect = annotation.rect as number[];
          for (const run of runs) if (run.y >= rect[1]! - 4 && run.y <= rect[3]! + 4 && run.x >= rect[0]! - 3 && run.x + run.width <= rect[2]! + 3) run.link = annotation.url;
        }
        if (!runs.some(run => run.text.trim()) && extracted.resources.some(resource => resource.key.startsWith(`pdf-resource/${number}-`))) extracted.warnings.push({ code: "NO_TEXT_EXTRACTED", page: number, message: translate(locale === "zh" ? "zh" : "en", "pdf.importScanImage") });
        const ordered = pdfTextBlocks(runs, page.getViewport({ scale: 1 }).width);
        // Keep each successfully extracted image, including scans, in its page's reading order.
        // Rendering matrices place images between paragraphs rather than at the end of the document.
        let matrix = [1, 0, 0, 1, 0, 0], imageIndex = 0;
        const stack: number[][] = [];
        for (let i = 0; i < operators.fnArray.length; i++) {
          const op = operators.fnArray[i], args = operators.argsArray[i];
          if (op === OPS.save) stack.push([...matrix]);
          else if (op === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
          else if (op === OPS.transform) {
            const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
            matrix = [a * args[0] + c * args[1], b * args[0] + d * args[1], a * args[2] + c * args[3], b * args[2] + d * args[3], a * args[4] + c * args[5] + e, b * args[4] + d * args[5] + f];
          } else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op!) && args?.[0]) {
            imageIndex++;
            const resource = extracted.resources.find(resource => resource.key === `pdf-resource/${number}-${imageIndex}.png`);
            if (resource) ordered.push({ y: matrix[5]! + Math.abs(matrix[3]!), block: { type: "image", id: id(), path: resource.key, alt: resource.alt ?? resource.filename, width: Math.max(32, Math.min(900, Math.hypot(matrix[0]!, matrix[1]!) * 4 / 3)), children: [{ text: "" }] } });
          }
        }
        blocks.push(...ordered.sort((a, b) => b.y - a.y).map(entry => entry.block));
      } finally { page.cleanup(); }
    }
    const initialValue: EditorValue = blocks.length ? blocks : [paragraph([{ text: "" }])];
    const resourceMap = new Map(extracted.resources.map(resource => [resource.key, resource]));
    const converted = await exportDocument(initialValue, { format: "markdown", signal: bounded, resources: { signal: bounded, resolveResource: async resource => {
      const asset = resourceMap.get(resource.path);
      if (!asset) throw Error("PDF 图片资源未找到");
      return { bytes: asset.bytes, mimeType: asset.mimeType, filename: asset.filename };
    } } });
    return { ...extracted, markdown: await converted.blob.text(), initialValue };
  } finally { bounded.removeEventListener("abort", abort); await loading.destroy(); }
}
