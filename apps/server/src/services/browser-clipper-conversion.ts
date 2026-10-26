import { randomUUID } from "node:crypto";
import {
  importMarkdown,
  type ConversionWarning,
} from "@smartdoca/slate/conversion";
import type { EditorValue } from "@smartdoca/slate";
import { createEditorDocument } from "@smartdoca/slate/headless";

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
  options: { maxDocumentBytes?: number; title?: string } = {},
) {
  const literalContent = (): EditorValue => {
    const content: EditorValue = [
      ...(options.title ? [paragraph(options.title)] : []),
      // Bound individual text blocks so a long fallback stays usable in the
      // editor. Unicode matching preserves whole code points and every source
      // character; no truncation or second parser is involved.
      ...(markdown.match(/[\s\S]{1,8192}/gu) ?? [""]).map(paragraph),
    ];
    for (const [source, path] of assets)
      if (markdown.includes(source))
        content.push({
          type: "image",
          id: randomUUID(),
          path,
          children: [{ text: "" }],
        });
    return content;
  };
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
    value = literalContent();
  }
  warnings = [...imageWarnings, ...warnings];
  // A visible note accompanies every reported degradation. The parser already
  // retains readable formula/code/HTML text and inserts missing-image markers.
  const withNotices = (content: EditorValue) => [
    ...content,
    ...warnings.map((warning) =>
      paragraph(`[Content not fully converted: ${warning.message}]`),
    ),
  ];
  let initialValue = withNotices(value);
  if (
    options.maxDocumentBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(createEditorDocument(initialValue))) >
      options.maxDocumentBytes
  ) {
    warnings.push({
      code: "format-degraded",
      message:
        "Formatted content exceeded the document import limit; the complete original Markdown is preserved as plain text, with uploaded images below.",
    });
    initialValue = withNotices(literalContent());
  }
  const notes = warnings.map(
    (warning) => `[Content not fully converted: ${warning.message}]`,
  );
  return {
    initialValue,
    warnings,
    markdown: markdown + (notes.length ? "\n\n" + notes.join("\n\n") : ""),
  };
}
