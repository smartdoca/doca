import { fileURLToPath } from "node:url";
import { renderProcess } from "../render-process.js";
import type { CanvasExportSource } from "@smartdoca/canvas/io";
import { AppError, fail } from "@core/shared/errors.js";

export type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CanvasRenderInput = {
  source: CanvasExportSource;
  elementIds?: string[];
  region?: CanvasRect;
  assets: Record<string, { mime: string; data: string }>;
};
export type CanvasRenderResult = {
  png: string;
  width: number;
  height: number;
  sourceRect: CanvasRect;
  bounds: CanvasRect;
  empty: boolean;
  warnings: { code: string; message: string; elementId?: string }[];
};

let active = 0;
const waiting: { start(): void }[] = [];
async function acquireRender(signal?: AbortSignal) {
  if (active < 2) {
    active++;
    return;
  }
  if (waiting.length >= 4) fail(429, "canvas_render_busy");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal!.reason);
    };
    const entry = {
      start() {
        signal?.removeEventListener("abort", abort);
        active++;
        resolve();
      },
    };
    waiting.push(entry);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function releaseRender() {
  active--;
  waiting.shift()?.start();
}
/** Disposable native export with only host-authorized assets and the installed SDK. */
export async function renderCanvas(
  input: CanvasRenderInput,
  signal?: AbortSignal,
): Promise<CanvasRenderResult> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(input)) > 48 * 1024 * 1024)
    fail(413, "canvas_render_too_large");
  await acquireRender(signal);
  try {
    const bytes = await renderProcess(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../renderers/canvas-worker.mjs", import.meta.url),
        ),
      ],
      JSON.stringify(input),
      { signal, timeout: 45_000, maxBytes: 24 * 1024 * 1024 },
    );
    return JSON.parse(bytes.toString("utf8")) as CanvasRenderResult;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message === "render_timeout")
      fail(504, "canvas_render_timeout");
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      `画板渲染失败，尚未完成视觉检查：${error instanceof Error ? error.message.slice(0, 300) : "canvas_render_failed"}`,
    );
  } finally {
    releaseRender();
  }
}
