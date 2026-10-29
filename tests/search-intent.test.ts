import { expect, it } from "vitest";
import {
  constrainedDocumentIds,
  mergeDocumentIds,
  searchIntent,
  searchResultLayout,
  searchRetrieval,
  titleMatchTier,
} from "@core/modules/discovery/search-intent.js";
import { textMentionsTopic } from "@core/modules/discovery/search-excerpts.js";

it("extracts a requested document title from conversational Chinese", () => {
  for (const query of [
    "帮我找一下doca问题记录文档",
    "请帮我找一下 doca 问题记录文档",
    "麻烦 帮我 查找 doca问题记录文档",
  ]) {
    const intent = searchIntent(query);
    expect(intent.focus).toBe("document");
    expect(intent.topic.replace(/\s/g, "")).toBe("doca问题记录");
    expect(titleMatchTier("🎯 doca问题记录2.0", intent.topic)).toBe(1);
    expect(titleMatchTier("绘本项目说明 DOCA", intent.topic)).toBe(0);
  }
  expect(titleMatchTier("🎯 DOCA 问题记录", "doca问题记录")).toBe(2);
});

it("treats documents-containing-media queries as document retrieval", () => {
  expect(searchIntent("含有猫猫图片的文档")).toEqual({
    focus: "document",
    topic: "猫猫",
    media: "image",
    requireEvidence: true,
  });
  expect(searchIntent("搜索包含猫猫的文档")).toMatchObject({
    focus: "document",
    topic: "猫猫",
    requireEvidence: false,
  });
  expect(searchRetrieval(searchIntent("搜索包含猫猫的文档"))).toMatchObject({
    documents: true,
    files: false,
    fileEvidence: false,
    tool: "knowledge_search",
  });
  expect(searchRetrieval(searchIntent("猫猫的图片"))).toMatchObject({
    documents: false,
    files: true,
    tool: "file_search",
  });
  expect(
    searchRetrieval(searchIntent("包含猫猫的文档"), { contentMode: "files" }),
  ).toMatchObject({
    documents: false,
    files: true,
    tool: "file_search",
  });
  expect(
    searchRetrieval(searchIntent("猫猫的图片"), {
      contentMode: "documents",
      format: "spreadsheet",
    }),
  ).toMatchObject({
    documents: true,
    files: false,
    format: "spreadsheet",
    tool: "knowledge_search",
  });
  expect(
    searchRetrieval(searchIntent("包含猫猫的excel"), {
      contentMode: "documents",
      format: "rich_text",
    }),
  ).toMatchObject({
    documents: true,
    files: false,
    format: "spreadsheet",
    tool: "knowledge_search",
  });
  expect(searchIntent("帮我找包含预算的表格")).toEqual({
    focus: "document",
    topic: "预算",
    format: "spreadsheet",
    requireEvidence: false,
  });
  expect(searchIntent("产品发布会的演示文稿")).toEqual({
    focus: "document",
    topic: "产品发布会",
    format: "presentation",
    requireEvidence: false,
  });
});

it("maps excel-style asks onto spreadsheet documents with image evidence", () => {
  expect(searchIntent("包含猫猫图片的excel")).toMatchObject({
    focus: "document",
    topic: "猫猫",
    format: "spreadsheet",
    media: "image",
    requireEvidence: true,
  });
  expect(searchIntent("包含猫猫的excel")).toMatchObject({
    focus: "document",
    topic: "猫猫",
    format: "spreadsheet",
    requireEvidence: false,
  });
  expect(searchIntent("包含猫猫的在线表格")).toMatchObject({
    focus: "document",
    topic: "猫猫",
    format: "spreadsheet",
    requireEvidence: false,
  });
  expect(searchIntent("包含猫猫图片的在线表格")).toMatchObject({
    focus: "document",
    topic: "猫猫",
    format: "spreadsheet",
    media: "image",
    requireEvidence: true,
  });
  expect(searchIntent("包含狗狗图片的excel")).toMatchObject({
    focus: "document",
    topic: "狗狗",
    format: "spreadsheet",
    media: "image",
    requireEvidence: true,
  });
});

it("treats media queries as file retrieval", () => {
  expect(searchIntent("猫猫的图片")).toEqual({
    focus: "file",
    topic: "猫猫",
    media: "image",
    requireEvidence: false,
  });
  expect(searchIntent("猫猫图片")).toEqual({
    focus: "file",
    topic: "猫猫",
    media: "image",
    requireEvidence: false,
  });
});

it("keeps mixed queries as topical search", () => {
  expect(searchIntent("预算报销")).toEqual({
    focus: "mixed",
    topic: "预算报销",
    requireEvidence: false,
  });
  expect(searchIntent("狗狗")).toEqual({
    focus: "mixed",
    topic: "狗狗",
    requireEvidence: false,
  });
  expect(searchIntent("")).toEqual({ focus: "mixed", topic: "", requireEvidence: false });
  expect(searchIntent("查找预算邮件")).toMatchObject({
    focus: "mixed",
    topic: "预算邮件",
  });
});

it("lets a named query type empty the other document formats", () => {
  const excel = searchIntent("包含猫猫的excel");
  expect(searchResultLayout(excel, "all")).toMatchObject({
    nestFiles: false,
    showDocuments: true,
    showFileHits: false,
    format: "spreadsheet",
    formatConflict: false,
  });
  expect(searchResultLayout(searchIntent("包含猫猫的文档"), "all")).toMatchObject({
    nestFiles: false,
    showDocuments: true,
    showFileHits: false,
  });
  expect(searchResultLayout(searchIntent("包含猫猫图片的文档"), "all")).toMatchObject({
    nestFiles: true,
    showDocuments: true,
    showFileHits: false,
  });
  expect(searchResultLayout(excel, "documents", "rich_text")).toMatchObject({
    nestFiles: false,
    showDocuments: true,
    showFileHits: false,
    format: "spreadsheet",
    formatConflict: false,
  });
  expect(searchResultLayout(excel, "documents", "spreadsheet")).toMatchObject({
    nestFiles: false,
    showDocuments: true,
    showFileHits: false,
    format: "spreadsheet",
    formatConflict: false,
  });
  expect(searchResultLayout(excel, "files")).toMatchObject({
    nestFiles: false,
    showDocuments: false,
    showFileHits: true,
    formatConflict: false,
  });
  expect(searchResultLayout(searchIntent("猫猫"), "all")).toMatchObject({
    nestFiles: true,
    showDocuments: true,
    showFileHits: true,
    formatConflict: false,
  });
  expect(searchResultLayout(searchIntent("猫猫的图片"), "all")).toMatchObject({
    nestFiles: false,
    showDocuments: false,
    showFileHits: true,
  });
  expect(searchResultLayout(searchIntent("猫猫的图片"), "documents", "rich_text")).toMatchObject({
    showDocuments: true,
    showFileHits: false,
    format: "rich_text",
  });
});

it("does not turn attached files into document hits unless the user asked for them", () => {
  expect(
    mergeDocumentIds(["title-hit", "file-hit", "other"], ["file-hit", "only-file"], "document"),
  ).toEqual(["file-hit", "title-hit", "other"]);
  expect(mergeDocumentIds(["a", "b"], ["b"], "mixed")).toEqual(["a", "b"]);
  expect(mergeDocumentIds(["a"], ["b"], "file")).toEqual(["a"]);
  expect(
    constrainedDocumentIds(
      ["title-hit", "other"],
      ["only-file"],
      searchIntent("包含猫猫的文档"),
      new Set(["title-hit"]),
    ),
  ).toEqual(["title-hit"]);
  expect(
    constrainedDocumentIds(
      ["title-hit"],
      ["only-file"],
      searchIntent("包含猫猫图片的文档"),
      new Set(["title-hit"]),
    ),
  ).toEqual(["only-file"]);
});

it("keeps format and topic as hard filters so cats cannot satisfy a dog query", () => {
  expect(textMentionsTopic("橘猫趴在窗边", "猫猫")).toBe(true);
  expect(textMentionsTopic("橘猫趴在窗边", "狗狗")).toBe(false);
  expect(textMentionsTopic("英国短毛猫（蓝猫）", "狗狗")).toBe(false);
  expect(
    constrainedDocumentIds(
      ["cat-doc", "other"],
      ["cat-doc"],
      searchIntent("包含猫猫图片的excel"),
      new Set(["cat-doc"]),
    ),
  ).toEqual(["cat-doc"]);
  expect(
    constrainedDocumentIds(
      ["cat-doc"],
      [],
      searchIntent("包含狗狗图片的excel"),
      new Set(),
    ),
  ).toEqual([]);
  expect(
    constrainedDocumentIds(
      ["cat-doc"],
      [],
      searchIntent("狗狗"),
      new Set(),
    ),
  ).toEqual([]);
});
