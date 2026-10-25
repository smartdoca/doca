/* Runs in the isolated content world. Page scripts never receive credentials. */
(() => {
  const escape = (value) => value.replace(/[\\`*_[\]<>]/g, "\\$&");
  const safeUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return ["https:", "http:", "mailto:"].includes(url.protocol)
        ? url.href
        : null;
    } catch {
      return null;
    }
  };
  function capture(mode, savedRange) {
    if (!["page", "selection"].includes(mode))
      throw Error("clipper_invalid_input");
    const images = [],
      knownImages = new Map();
    let source, originals;
    if (mode === "selection") {
      const selection = window.getSelection(),
        range =
          savedRange ||
          (selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null);
      if (!range || range.collapsed) throw Error("clipper_selection_missing");
      source = document.createElement("div");
      source.append(range.cloneContents());
      originals = [...document.images].filter((image) =>
        range.intersectsNode(image),
      );
    } else {
      source = document.body.cloneNode(true);
      originals = [...document.images];
    }
    const copies = [...source.querySelectorAll("img")];
    for (let i = 0; i < copies.length; i++) {
      const original = originals[i],
        image = copies[i];
      if (original)
        image.setAttribute(
          "src",
          original.currentSrc || original.src || original.dataset.src || "",
        );
      if (original) {
        const style = window.getComputedStyle(original);
        if (style.display === "none" || style.visibility === "hidden")
          image.hidden = true;
      }
    }
    source
      .querySelectorAll(
        "script,style,noscript,template,form,input,textarea,select,button,[data-doca-capture-ui],[hidden],[aria-hidden='true']",
      )
      .forEach((node) => {
        if (node.localName === "style" && node.closest("svg")) return;
        node.remove();
      });
    let nodes = 0;
    function walk(node, depth = 0) {
      if (++nodes > 100000 || depth > 60)
        throw Error("clipper_content_too_large");
      if (node.nodeType === Node.TEXT_NODE)
        return escape(node.textContent.replace(/\s+/g, " "));
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase(),
        children = () =>
          [...node.childNodes].map((child) => walk(child, depth + 1)).join("");
      if (tag === "br") return "\n";
      if (tag === "svg") {
        const image = document.createElement("img");
        image.src =
          "data:image/svg+xml;charset=utf-8," +
          encodeURIComponent(new XMLSerializer().serializeToString(node));
        image.alt =
          node.getAttribute("aria-label") ||
          node.querySelector("title")?.textContent ||
          "SVG";
        return walk(image, depth + 1);
      }
      if (tag === "img") {
        let url = node.getAttribute("src");
        if (!url) return node.alt ? escape(node.alt) : "";
        try {
          url = new URL(url, document.baseURI).href;
        } catch {
          url = "invalid:";
        }
        let id = knownImages.get(url);
        if (!id) {
          if (images.length >= 100) throw Error("clipper_too_many_images");
          id = crypto.randomUUID();
          knownImages.set(url, id);
          const filename = (() => {
            try {
              if (/^data:image\/svg\+xml/i.test(url)) return "image.svg";
              return decodeURIComponent(
                new URL(url).pathname.split("/").pop() || "image",
              )
                .replace(/[\x00-\x1f/\\]/g, "_")
                .slice(0, 200);
            } catch {
              return "image";
            }
          })();
          images.push({ id, url, name: filename || "image" });
        }
        return `![${escape(node.alt || "image")}](https://clipper.invalid/images/${id})`;
      }
      if (tag === "pre") {
        const text = node.textContent,
          fence = text.includes("```") ? "~~~~" : "```";
        return `\n\n${fence}\n${text}\n${fence}\n\n`;
      }
      if (tag === "code")
        return "`" + node.textContent.replaceAll("`", "\\`") + "`";
      if (tag === "a") {
        const url = safeUrl(node.getAttribute("href") || "");
        const label = children();
        if (!url) return label;
        const target = url.replace(/[()<>\s]/g, (character) =>
          encodeURIComponent(character),
        );
        // Keep media outside link labels: the document converter cannot parse
        // nested image/link Markdown. Preserve the image and its target link.
        const media = node.querySelector("img,svg");
        if (media) {
          const textOnly = node.cloneNode(true);
          textOnly.querySelectorAll("img,svg").forEach((image) => image.remove());
          const text =
            textOnly.textContent.trim().replace(/\s+/g, " ") ||
            node.getAttribute("aria-label") ||
            media.getAttribute("alt") ||
            media.querySelector("title")?.textContent ||
            url;
          return `\n\n${label.trim()}\n\n[${escape(text)}](${target})\n\n`;
        }
        return `[${label || escape(url)}](${target})`;
      }
      if (["strong", "b"].includes(tag)) return `**${children()}**`;
      if (["em", "i"].includes(tag)) return `*${children()}*`;
      if (/^h[1-6]$/.test(tag))
        return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
      if (tag === "blockquote")
        return (
          "\n\n" +
          children()
            .trim()
            .split("\n")
            .map((line) => "> " + line)
            .join("\n") +
          "\n\n"
        );
      if (tag === "li") {
        const prefix =
          node.parentElement?.tagName === "OL"
            ? `${[...node.parentElement.children].indexOf(node) + 1}. `
            : "- ";
        return "\n" + prefix + children().trim();
      }
      if (tag === "table") {
        const rows = [...node.querySelectorAll("tr")].map((row) =>
          [...row.children]
            .filter((cell) => ["TD", "TH"].includes(cell.tagName))
            .map((cell) =>
              walk(cell, depth + 1)
                .trim()
                .replaceAll("|", "\\|")
                .replace(/\n+/g, " "),
            ),
        );
        const width = Math.max(0, ...rows.map((row) => row.length));
        if (!width) return "";
        const line = (row) =>
          "| " +
          Array.from({ length: width }, (_, i) => row[i] || "").join(" | ") +
          " |";
        return (
          "\n\n" +
          [
            line(rows[0]),
            line(Array(width).fill("---")),
            ...rows.slice(1).map(line),
          ].join("\n") +
          "\n\n"
        );
      }
      if (["iframe", "canvas", "video", "audio"].includes(tag)) {
        const url = safeUrl(node.getAttribute("src") || "");
        return url
          ? `\n\n[${tag}](${url.replace(/[()<>\s]/g, (character) => encodeURIComponent(character))})\n\n`
          : "";
      }
      const text = children();
      return [
        "p",
        "div",
        "section",
        "article",
        "main",
        "header",
        "footer",
        "nav",
        "ul",
        "ol",
        "figure",
        "figcaption",
        "hr",
      ].includes(tag)
        ? `\n\n${text}\n\n`
        : text;
    }
    const markdown = walk(source)
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!markdown) throw Error("clipper_content_empty");
    if (new TextEncoder().encode(markdown).length > 512 * 1024)
      throw Error("clipper_content_too_large");
    return {
      mode,
      url: location.href,
      title: (document.title || location.hostname).slice(0, 160),
      capturedAt: new Date().toISOString(),
      markdown,
      images,
    };
  }
  globalThis.DocaCapture = { capture };
})();
