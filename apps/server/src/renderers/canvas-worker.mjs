import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { createCanvas, GlobalFonts, Image, Path2D } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";

const sdkDirectory = new URL("../../dist/canvas-render/", import.meta.url);
const font = fileURLToPath(new URL("NotoSansSC-Regular.ttf", sdkDirectory));
if (!GlobalFonts.registerFromPath(font, "Doca Canvas CJK"))
  throw new Error("canvas_font_unavailable");

async function render(input) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  const canvases = new WeakMap(),
    blobs = new Map();
  let nextBlob = 0;
  // The SDK's web entry needs only DOM construction, color validation, text
  // measurement and authorized image decoding. No user scripts are evaluated.
  w.HTMLCanvasElement.prototype.getContext = function (type) {
    let canvas = canvases.get(this);
    if (
      !canvas ||
      canvas.width !== this.width ||
      canvas.height !== this.height
    ) {
      canvas = createCanvas(this.width, this.height);
      canvases.set(this, canvas);
    }
    return canvas.getContext(type);
  };
  w.CanvasRenderingContext2D = createCanvas(1, 1).getContext("2d").constructor;
  w.Path2D = Path2D;
  w.PointerEvent = w.MouseEvent;
  w.DragEvent = w.MouseEvent;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.Blob = Blob;
  w.CSS = {
    supports(property, value) {
      if (property !== "color") return false;
      const style = w.document.createElement("span").style;
      style.color = value;
      return style.color !== "";
    },
  };
  Object.defineProperty(w.document, "fonts", {
    value: { ready: Promise.resolve() },
  });
  w.URL.createObjectURL = (blob) => {
    const url = `blob:doca/${++nextBlob}`;
    blobs.set(url, blob);
    return url;
  };
  w.URL.revokeObjectURL = (url) => blobs.delete(url);
  w.Image = class extends Image {
    set src(value) {
      const blob = blobs.get(value);
      if (blob) {
        blob.arrayBuffer().then(
          (bytes) => {
            super.src = Buffer.from(bytes);
          },
          (error) => this.onerror?.(error),
        );
      } else if (
        typeof value === "string" &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(value)
      ) {
        super.src = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
      } else {
        queueMicrotask(() =>
          this.onerror?.(new Error("canvas_external_image_forbidden")),
        );
      }
    }
    get src() {
      return super.src;
    }
  };
  const Serializer = w.XMLSerializer;
  w.XMLSerializer = class {
    serializeToString(node) {
      const clone = node.cloneNode(true);
      for (const element of [clone, ...clone.querySelectorAll("*")]) {
        const attribute = element.getAttributeNode?.("xmlns");
        if (attribute && attribute.namespaceURI === null) {
          const value = attribute.value;
          element.removeAttribute("xmlns");
          element.setAttributeNS(
            "http://www.w3.org/2000/xmlns/",
            "xmlns",
            value,
          );
        }
      }
      return new Serializer().serializeToString(clone);
    }
  };
  try {
    runInContext(
      await readFile(new URL("sdk.js", sdkDirectory), "utf8"),
      dom.getInternalVMContext(),
    );
    // Values enter the SDK's own realm just as they did in the browser.
    const source = w.JSON.parse(JSON.stringify(input.source));
    const result = await w.DocaCanvasSDK.exportCanvasFile(source, {
      format: "svg",
      scale: 0.1,
      scope: input.elementIds ? "selection" : "all",
      elementIds:
        input.elementIds && w.JSON.parse(JSON.stringify(input.elementIds)),
      background: "#ffffff",
      readAsset: async (path) => {
        const asset = Object.hasOwn(input.assets, path)
          ? input.assets[path]
          : undefined;
        if (!asset) throw new Error("canvas_asset_unavailable");
        return new Blob([Buffer.from(asset.data, "base64")], {
          type: asset.mime,
        });
      },
    }).catch((error) => {
      if (
        !input.elementIds &&
        ["EMPTY_CANVAS", "EMPTY_VISIBLE_CONTENT"].includes(error.code)
      )
        return null;
      throw error;
    });
    const svg = new w.DOMParser().parseFromString(
      result
        ? await result.blob.text()
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"></svg>',
      "image/svg+xml",
    ).documentElement;
    if (svg.localName !== "svg") throw new Error("canvas_svg_invalid");
    const [x, y, width, height] = svg
      .getAttribute("viewBox")
      .split(/\s+/)
      .map(Number);
    const bounds = { x, y, width, height },
      rect = input.region ?? bounds;
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      throw new Error("canvas_region_invalid");
    const scale = Math.min(2, 1600 / Math.max(rect.width, rect.height));
    const outputWidth = Math.max(1, Math.round(rect.width * scale));
    const outputHeight = Math.max(1, Math.round(rect.height * scale));
    svg.setAttribute(
      "viewBox",
      `${rect.x} ${rect.y} ${rect.width} ${rect.height}`,
    );
    svg.setAttribute("width", String(outputWidth));
    svg.setAttribute("height", String(outputHeight));
    for (const text of svg.querySelectorAll("text"))
      text.setAttribute(
        "font-family",
        `${text.getAttribute("font-family") || "Arial"}, Noto Sans SC`,
      );
    const background = w.document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    for (const [key, value] of Object.entries(rect))
      background.setAttribute(key, String(value));
    background.setAttribute("fill", "#ffffff");
    svg.insertBefore(background, svg.firstChild);
    const raster = new Resvg(new w.XMLSerializer().serializeToString(svg), {
      background: "#ffffff",
      font: {
        fontFiles: [font],
        loadSystemFonts: true,
        defaultFontFamily: "Noto Sans SC",
      },
    });
    if (raster.imagesToResolve().length)
      throw new Error("canvas_external_image_forbidden");
    return {
      png: Buffer.from(raster.render().asPng()).toString("base64"),
      width: outputWidth,
      height: outputHeight,
      sourceRect: rect,
      bounds,
      warnings: result?.warnings ?? [],
      empty: result === null,
    };
  } finally {
    blobs.clear();
    dom.window.close();
  }
}

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 48 * 1024 * 1024) throw new Error("canvas_render_too_large");
    chunks.push(chunk);
  }
  const result = await render(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error.code || error.message || "canvas_render_failed");
  process.exitCode = 1;
}
