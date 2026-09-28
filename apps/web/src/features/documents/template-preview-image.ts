import { templatePreviewLines } from "@core/modules/templates/content.js";
import type { Resource } from "@web/shared/api.js";

function page(g: CanvasRenderingContext2D) {
  g.fillStyle = "#eef1f6";
  g.fillRect(0, 0, 640, 400);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.roundRect(36, 28, 568, 344, 12);
  g.fill();
  g.strokeStyle = "#e6e8ec";
  g.stroke();
}

function drawLines(g: CanvasRenderingContext2D, lines: string[], x: number, y: number) {
  g.font = "15px PingFang SC, Microsoft YaHei, sans-serif";
  g.fillStyle = "#1f2329";
  g.textBaseline = "top";
  const shown = lines.filter(Boolean).slice(0, 7);
  if (!shown.length) {
    g.fillStyle = "#e6e8ec";
    for (let i = 0; i < 5; i++) g.fillRect(x, y + i * 28, 220 + ((i * 47) % 160), 8);
    return;
  }
  shown.forEach((line, index) => {
    g.fillText(line.slice(0, 28), x, y + index * 28);
  });
}

function drawSheet(g: CanvasRenderingContext2D, content: unknown, lines: string[]) {
  page(g);
  const book = content as {
    sheetOrder?: string[];
    sheets?: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }>;
  };
  const id = book.sheetOrder?.[0];
  const cells = (id && book.sheets?.[id]?.cellData) || {};
  const originX = 64;
  const originY = 56;
  const colW = 120;
  const rowH = 36;
  g.strokeStyle = "#e6e8ec";
  g.font = "13px PingFang SC, Microsoft YaHei, sans-serif";
  g.fillStyle = "#1f2329";
  g.textBaseline = "middle";
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 4; column++) {
      const x = originX + column * colW;
      const y = originY + row * rowH;
      g.strokeRect(x, y, colW, rowH);
      const value = cells[String(row)]?.[String(column)]?.v;
      if (value !== undefined && value !== null && value !== "")
        g.fillText(String(value).slice(0, 10), x + 8, y + rowH / 2);
    }
  }
  if (!lines.length && !Object.keys(cells).length) drawLines(g, [], 72, 72);
}

function drawSlide(g: CanvasRenderingContext2D, lines: string[]) {
  g.fillStyle = "#eef1f6";
  g.fillRect(0, 0, 640, 400);
  g.fillStyle = "#202124";
  g.beginPath();
  g.roundRect(48, 46, 544, 306, 8);
  g.fill();
  g.fillStyle = "#ffffff";
  g.font = "22px PingFang SC, Microsoft YaHei, sans-serif";
  g.textBaseline = "top";
  const shown = lines.filter(Boolean).slice(0, 4);
  if (!shown.length) {
    g.fillStyle = "#5f6368";
    g.fillRect(84, 160, 180, 10);
    return;
  }
  shown.forEach((line, index) => {
    g.font = index === 0 ? "22px PingFang SC, Microsoft YaHei, sans-serif" : "15px PingFang SC, Microsoft YaHei, sans-serif";
    g.fillText(line.slice(0, 24), 84, 92 + index * 40);
  });
}

function drawCanvas(g: CanvasRenderingContext2D, content: unknown) {
  page(g);
  g.fillStyle = "#f7f8fa";
  g.fillRect(64, 56, 512, 288);
  g.strokeStyle = "#d7dbe2";
  g.strokeRect(64, 56, 512, 288);
  const children =
    (content as { scene?: { children?: Record<string, unknown>[] } })?.scene
      ?.children ?? [];
  children.slice(0, 8).forEach((child, index) => {
    const x = Number(child.x ?? 80 + (index % 3) * 140);
    const y = Number(child.y ?? 80 + Math.floor(index / 3) * 90);
    const width = Math.min(160, Math.max(48, Number(child.width ?? 96)));
    const height = Math.min(80, Math.max(28, Number(child.height ?? 48)));
    g.fillStyle = index % 2 ? "#d6e4ff" : "#e8f3ec";
    g.fillRect(64 + (x % 420), 56 + (y % 220), width, height);
  });
}

export function renderTemplatePreview(
  format: Resource["format"],
  content: unknown,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const g = canvas.getContext("2d");
  if (!g) return "";
  const lines = templatePreviewLines(format, content);
  if (format === "spreadsheet") drawSheet(g, content, lines);
  else if (format === "presentation") drawSlide(g, lines);
  else if (format === "canvas") drawCanvas(g, content);
  else {
    page(g);
    drawLines(g, lines, 64, 64);
  }
  return canvas.toDataURL("image/jpeg", 0.72);
}
