import { randomUUID } from "node:crypto";
import {
  importMarkdown,
  type ConversionWarning,
} from "@smartdoca/slate/conversion";
import type { EditorValue } from "@smartdoca/slate";

const paragraph = (text: string) => ({
  type: "paragraph" as const,
  id: randomUUID(),
  children: [{ text }],
});

/** Conversion is best effort; authorization and storage stay outside this boundary. */
export async function convertClipperMarkdown(
  markdown: string,
  assets: Map<string, string>,
  convert = importMarkdown,
  imageWarnings: ConversionWarning[] = [],
) {
  let value: EditorValue, warnings: ConversionWarning[];
  try {
    const result = await convert(markdown, {
      resources: {
        signal: new AbortController().signal,
        async importResource(request) {
          const asset = assets.get(request.url ?? request.path ?? "");
          if (!asset) throw Error("clipper_image_unlisted");
          return asset;
        },
      },
    });
    value = result.initialValue;
    warnings = result.warnings;
  } catch {
    // Do not feed the fallback through the failing parser. Preserve every source
    // character as literal text, plus uploaded images through their authorized IDs.
    warnings = [
      {
        code: "format-degraded",
        message:
          "Content conversion failed; the original Markdown is preserved as plain text below.",
      },
    ];
    value = [paragraph(markdown)];
    for (const [source, path] of assets)
      if (markdown.includes(source))
        value.push({
          type: "image",
          id: randomUUID(),
          path,
          children: [{ text: "" }],
        });
  }
  warnings = [...imageWarnings, ...warnings];
  // A visible note accompanies every reported degradation. The parser already
  // retains readable formula/code/HTML text and inserts missing-image markers.
  for (const warning of warnings)
    value.push(paragraph(`[Content not fully converted: ${warning.message}]`));
  const notes = warnings.map(
    (warning) => `[Content not fully converted: ${warning.message}]`,
  );
  return {
    initialValue: value,
    warnings,
    markdown: markdown + (notes.length ? "\n\n" + notes.join("\n\n") : ""),
  };
}
