/* Local SVG decoding only: never mount source markup in the page. */
(() => {
  const invalid = () => {
    throw Error("clipper_image_invalid");
  };
  function sanitize(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid();
    const xml = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = xml.documentElement;
    if (
      svg.localName !== "svg" ||
      svg.namespaceURI !== "http://www.w3.org/2000/svg" ||
      xml.querySelector("parsererror")
    )
      invalid();
    for (const node of [svg, ...svg.querySelectorAll("*")]) {
      if (node.localName === "script") {
        node.remove();
        continue;
      }
      if (
        node.namespaceURI !== svg.namespaceURI ||
        [
          "foreignObject",
          "image",
          "feImage",
          "animate",
          "animateMotion",
          "animateTransform",
          "set",
        ].includes(node.localName)
      )
        invalid();
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.localName))
          node.removeAttributeNode(attribute);
        else if (
          attribute.localName === "href" &&
          !/^#[\w:.-]+$/.test(attribute.value)
        )
          invalid();
        else if (
          attribute.localName === "base" ||
          /\\/.test(attribute.value) ||
          /url\s*\(/i.test(
            attribute.value.replace(
              /url\s*\(\s*["']?#[\w:.-]+["']?\s*\)/gi,
              "",
            ),
          ) ||
          (attribute.localName === "style" && /[@\\]/.test(attribute.value))
        )
          invalid();
      }
      if (
        node.localName === "style" &&
        /@|\\|url\s*\(/i.test(
          node.textContent.replace(/url\s*\(\s*["']?#[\w:.-]+["']?\s*\)/gi, ""),
        )
      )
        invalid();
    }
    const viewBox = (svg.getAttribute("viewBox") || "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const length = (name) => {
      const value = svg.getAttribute(name) || "";
      return /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : null;
    };
    const ratio =
      viewBox.length === 4 &&
      viewBox.every(Number.isFinite) &&
      viewBox[2] > 0 &&
      viewBox[3] > 0
        ? viewBox[2] / viewBox[3]
        : null;
    let width = length("width"),
      height = length("height");
    width ||= height && ratio ? height * ratio : ratio ? viewBox[2] : 300;
    height ||= ratio ? width / ratio : 150;
    if (
      !Number.isFinite(width * height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > 100_000_000
    )
      invalid();
    const scale = Math.min(
      1,
      4096 / Math.max(width, height),
      Math.sqrt(16_000_000 / (width * height)),
    );
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    if (width * height > 16_000_000) height = Math.floor(16_000_000 / width);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    return { text: new XMLSerializer().serializeToString(svg), width, height };
  }
  async function rasterize(data) {
    const svg = sanitize(new TextDecoder().decode(data));
    const url = URL.createObjectURL(
      new Blob([svg.text], { type: "image/svg+xml" }),
    );
    const image = new Image();
    let timer;
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(Error("clipper_image_invalid"));
        timer = setTimeout(() => reject(Error("clipper_image_invalid")), 10000);
        image.src = url;
      });
      let width = svg.width,
        height = svg.height;
      for (let attempt = 0; attempt < 8; attempt++) {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) invalid();
        context.drawImage(image, 0, 0, width, height);
        const png = await canvas.convertToBlob({ type: "image/png" });
        if (png.size && png.size <= 4 * 1024 ** 2)
          return new Uint8Array(await png.arrayBuffer());
        width = Math.max(1, Math.floor(width * 0.75));
        height = Math.max(1, Math.floor(height * 0.75));
      }
      throw Error("clipper_image_compression_failed");
    } finally {
      clearTimeout(timer);
      image.src = "";
      URL.revokeObjectURL(url);
    }
  }
  globalThis.DocaSvgImage = { sanitize, rasterize };
})();
