export type DocumentPageWidth = "a4" | "a3" | "fluid";
export function parseDocumentPageWidth(
  value: string | null,
): DocumentPageWidth {
  return value === "a3" || value === "fluid" ? value : "a4";
}

// CSS pixels at 96 dpi, portrait paper width. These are view settings, not print settings.
export function documentPageLayout(
  width: number,
  mode: DocumentPageWidth,
  outlineWanted: boolean,
) {
  const paper = mode === "a4" ? 794 : mode === "a3" ? 1123 : 0;
  const budget = Math.max(0, width - 40);
  const body = paper || 540;
  // Preserve navigation first; comments move into a drawer before the outline.
  const outlineInline = paper ? budget >= body + 216 : width >= 800;
  const commentsInline = paper
    ? budget >= body + 296 + (outlineWanted ? 216 : 0)
    : width > (outlineWanted ? 1050 : 800);
  return { paper, commentsInline, outlineInline };
}
