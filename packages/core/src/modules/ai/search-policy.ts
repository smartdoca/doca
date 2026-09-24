const asksForSearch =
  /搜索|检索|查一下|查一查|联网|最新|新闻|官网|找资料|核实|了解一下/;
const formatOnly =
  /样式|格式|富文本|markdown|排版|原文/i;
const stillNeedsFacts = /写一篇|起草|调研|方案|介绍|什么是|帮我写/;

/** Style and format follow-ups should reuse the document and earlier sources. */
export function shouldSkipWebSearch(userText: string) {
  const text = userText.trim();
  if (!text || asksForSearch.test(text) || stillNeedsFacts.test(text))
    return false;
  return formatOnly.test(text);
}
