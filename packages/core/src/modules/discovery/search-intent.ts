import { textMentionsTopic } from "./search-excerpts.js";

export type SearchFocus = "document" | "file" | "mixed";
export type DocumentFormat =
  | "rich_text"
  | "markdown"
  | "spreadsheet"
  | "presentation"
  | "canvas";
export type SearchMode = "keyword" | "ai";
export type ContentMode = "all" | "documents" | "files";
export type SearchIntent = {
  focus: SearchFocus;
  topic: string;
  format?: DocumentFormat;
  media?: "image";
  requireEvidence: boolean;
};
export type SearchHardLimits = {
  contentMode?: ContentMode;
  format?: string;
  mode?: SearchMode;
};

const containPattern = /含有|包含|带有|带了|里面有|里边有|里头有|内含|里的|内的/u;
const mediaPattern = /图片|照片|图像|截图|images?|photos?|pictures?/iu;
const documentKindPattern = /在线文档|文档|知识库|documents?/iu;
const fileAskPattern = /的?(图片|照片|图像|截图|文件|images?|photos?|pictures?|files?)们?$/iu;
const formatPatterns: Array<{ format: DocumentFormat; match: RegExp }> = [
  {
    format: "spreadsheet",
    match:
      /在线表格|在线电子表格|excel表格|excel|xlsx|\bxls\b|spreadsheet|电子表格|表格/iu,
  },
  {
    format: "presentation",
    match: /在线演示文稿|在线演示|pptx?|powerpoint|幻灯片|演示文稿|演示/iu,
  },
  { format: "markdown", match: /markdown|\.md\b/iu },
  { format: "canvas", match: /在线画板|画板|白板|\bcanvas\b/iu },
  { format: "rich_text", match: /word|\.docx?|\bdocs?\b|富文本/iu },
];

function detectedFormat(text: string): DocumentFormat | undefined {
  return formatPatterns.find((row) => row.match.test(text))?.format;
}

function stripConstraints(text: string) {
  let next = text
    .replace(containPattern, " ")
    .replace(mediaPattern, " ")
    .replace(documentKindPattern, " ");
  for (const row of formatPatterns) next = next.replace(row.match, " ");
  return next.replace(/的/g, " ").replace(/\s+/g, " ").trim();
}

function asFormat(value?: string): DocumentFormat | undefined {
  return formatPatterns.some((row) => row.format === value)
    ? (value as DocumentFormat)
    : undefined;
}

/** Compact queries like 狗狗/猫猫 must mention the topic; longer questions may use semantics. */
export function topicIsSpecific(topic: string) {
  const value = topic.trim();
  if (!value) return false;
  if (/\s/.test(value)) return false;
  return value.length <= 6;
}

/**
 * Hard UI limits first (files vs documents, keyword vs AI), then query
 * understanding. A named type in the query (excel / 表格 / 文档) is itself a
 * hard format filter and empties the other document types.
 */
export function searchRetrieval(
  intent: SearchIntent,
  hard: SearchHardLimits = {},
) {
  const tab = hard.contentMode ?? "all";
  const tabFormat = asFormat(hard.format);
  if (tab === "files")
    return {
      documents: false,
      files: true,
      fileEvidence: false,
      nestMatchingFiles: false,
      format: undefined,
      mode: hard.mode,
      tool: "file_search" as const,
    };
  if (tab === "documents")
    return {
      documents: true,
      files: false,
      fileEvidence: intent.requireEvidence,
      nestMatchingFiles: intent.requireEvidence,
      format: intent.format ?? tabFormat,
      mode: hard.mode,
      tool: "knowledge_search" as const,
    };
  return {
    documents: intent.focus !== "file",
    files: intent.focus !== "document",
    fileEvidence: intent.requireEvidence,
    nestMatchingFiles: intent.requireEvidence || intent.focus === "mixed",
    format: intent.format,
    mode: hard.mode,
    tool:
      intent.focus === "file"
        ? ("file_search" as const)
        : intent.focus === "document"
          ? ("knowledge_search" as const)
          : ("both" as const),
  };
}

/** Rank documents that contain matching files first when file evidence is in play. */
export function mergeDocumentIds(
  ranked: string[],
  fromFiles: string[],
  focus: SearchFocus,
) {
  if (focus === "file" || !fromFiles.length) return ranked;
  const fileSet = new Set(fromFiles);
  if (focus === "document")
    return [
      ...ranked.filter((id) => fileSet.has(id)),
      ...ranked.filter((id) => !fileSet.has(id)),
    ];
  const missing = fromFiles.filter((id) => !ranked.includes(id));
  return [...ranked, ...missing];
}

/** Hard filters first (format/evidence/topic), then keep the ranked order. */
export function constrainedDocumentIds(
  ranked: string[],
  evidenced: string[],
  intent: SearchIntent,
  titles: Map<string, string> = new Map(),
) {
  const evidenceSet = new Set(evidenced);
  const admits = (id: string) => {
    if (intent.requireEvidence) return evidenceSet.has(id);
    if (!topicIsSpecific(intent.topic)) return true;
    return textMentionsTopic(titles.get(id) ?? "", intent.topic);
  };
  const allowedRanked = ranked.filter(admits);
  if (intent.requireEvidence)
    return [
      ...allowedRanked,
      ...evidenced.filter((id) => !allowedRanked.includes(id)),
    ];
  if (intent.focus === "mixed")
    return mergeDocumentIds(allowedRanked, evidenced, "mixed");
  return allowedRanked;
}

/** Files/documents/mode stay on the clicked envelope; query format empties other types. */
export function searchResultLayout(
  intent: SearchIntent,
  contentMode: ContentMode,
  tabFormat = "",
) {
  const retrieval = searchRetrieval(intent, {
    contentMode,
    format: tabFormat,
  });
  return {
    nestFiles: retrieval.nestMatchingFiles && retrieval.documents,
    showDocuments: retrieval.documents,
    showFileHits: retrieval.files,
    format: retrieval.format,
    formatConflict: false,
  };
}

/** Turn a natural-language search into retrieval constraints and a topical query. */
export function searchIntent(query: string): SearchIntent {
  const raw = query.trim();
  if (!raw)
    return { focus: "mixed", topic: "", requireEvidence: false };
  let text = raw
    .replace(/^(请|麻烦)?(帮我)?(找一下|找一找|搜索|查找|找|搜一下|搜)?/u, "")
    .trim();
  const format = detectedFormat(text);
  const media = mediaPattern.test(text) ? ("image" as const) : undefined;
  const contain = containPattern.test(text);
  const documentKind = documentKindPattern.test(text);
  const documentAsk = contain && (documentKind || !!format);
  const documentSuffix = !!(format || documentKind) && /的.+$/u.test(text);
  const fileAsk =
    !documentAsk &&
    !format &&
    !documentKind &&
    fileAskPattern.test(text);
  const requireEvidence = !!(contain && media && (format || documentKind));
  const topic = stripConstraints(text) || raw;
  return {
    focus:
      requireEvidence || documentAsk || documentSuffix || format
        ? "document"
        : fileAsk
          ? "file"
          : "mixed",
    topic,
    ...(format ? { format } : {}),
    ...(media ? { media } : {}),
    requireEvidence,
  };
}
