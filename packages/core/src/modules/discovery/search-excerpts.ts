export type SearchMatch = { start: number; length: number };
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const queryFillers = new Set([
  "如何",
  "怎么",
  "哪些",
  "什么",
  "支持",
  "功能",
  "文档",
  "内容",
  "搜索",
  "查找",
  "帮我",
  "关于",
  "图片",
  "照片",
  "图像",
  "文件",
  "一张",
  "一只",
  "一个",
  "可以",
  "一起",
  "即可",
  "the",
  "how",
  "what",
  "which",
  "with",
]);
const topicParticles = new Set(["的", "了", "和", "与", "或", "在", "是", "也", "把", "被", ...queryFillers]);
const normalizeTerm = (value: string) => value.toLowerCase().replace(/(.)\1+/gu, "$1").trim();
/** Concrete topic tokens used as hard filters, including single Han characters like 猫/狗. */
export function topicMatchTerms(topic: string) {
  const terms = searchTerms(topic).filter((term) => !topicParticles.has(term));
  if (/^[\p{Script=Han}]+$/u.test(topic) && topic.length <= 6) {
    for (const char of topic) {
      if (!topicParticles.has(char) && !terms.includes(char)) terms.push(char);
    }
  }
  return terms.slice(0, 8);
}
export function textMentionsTopic(text: string, topic: string) {
  if (!topic.trim()) return true;
  const hay = text.toLowerCase();
  return topicMatchTerms(topic).some((term) => hay.includes(term.toLowerCase()));
}
export function queryCoverage(text: string, query: string) {
  const terms = [
    ...new Set(
      Array.from(segmenter.segment(query.toLowerCase()))
        .filter(
          (s) =>
            s.isWordLike &&
            (s.segment.length > 1 || /[\p{Script=Han}]/u.test(s.segment)) &&
            !queryFillers.has(s.segment),
        )
        .map((s) => normalizeTerm(s.segment)),
    ),
  ];
  const normalized = text.toLowerCase();
  return terms.length
    ? terms.filter((term) => normalized.includes(term)).length / terms.length
    : 0;
}
export function searchTerms(query: string) {
  const q = query.trim();
  if (!q) return [];
  return [
    ...new Set([
      q,
      ...Array.from(segmenter.segment(q))
        .filter((s) => s.isWordLike && !queryFillers.has(s.segment.toLowerCase()))
        .map((s) => normalizeTerm(s.segment)),
    ]),
  ]
    .filter((s) => s.length > 1 || q.length === 1)
    .sort((a, b) => b.length - a.length);
}
export function textMatches(text: string, query: string): SearchMatch[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const pattern = terms
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return Array.from(text.matchAll(new RegExp(pattern, "giu")), (match) => ({
    start: match.index!,
    length: match[0].length,
  }));
}
/** Find the actual matching paragraph, then center a bounded excerpt on its densest matches. */
export function searchExcerpt(body: string, query: string, maxLength = 360) {
  const blocks = body
    .split(/\n+/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let text = blocks[0] ?? "",
    best = -1,
    blockIndex = 0;
  for (const [index, block] of blocks.entries()) {
    const matches = textMatches(block, query);
    const distinct = new Set(
      matches.map((m) =>
        block.slice(m.start, m.start + m.length).toLowerCase(),
      ),
    );
    const score =
      distinct.size * 10 +
      Math.min(
        20,
        matches.reduce((n, m) => n + m.length, 0),
      );
    if (score > best) {
      best = score;
      text = block;
      blockIndex = index;
    }
  }
  const matches = textMatches(text, query);
  let start = 0,
    windowScore = -1;
  let left = 0,
    right = 0;
  const terms = new Map<string, number>();
  const key = (m: SearchMatch) =>
    text.slice(m.start, m.start + m.length).toLowerCase();
  for (const match of matches) {
    const candidate = Math.max(0, match.start - 70);
    while (
      right < matches.length &&
      matches[right]!.start + matches[right]!.length <= candidate + maxLength
    ) {
      const word = key(matches[right++]!);
      terms.set(word, (terms.get(word) ?? 0) + 1);
    }
    while (left < right && matches[left]!.start < candidate) {
      const word = key(matches[left++]!);
      const count = (terms.get(word) ?? 1) - 1;
      if (count) terms.set(word, count);
      else terms.delete(word);
    }
    const score = terms.size * 10 + right - left;
    if (score > windowScore) {
      windowScore = score;
      start = candidate;
    }
  }
  if (text.length <= maxLength) start = 0;
  const prefix = start > 0 || blockIndex > 0 ? "…" : "";
  const summary =
    prefix +
    text.slice(start, start + maxLength) +
    (start + maxLength < text.length || blockIndex < blocks.length - 1
      ? "…"
      : "");
  return { summary, summaryMatches: textMatches(summary, query) };
}
