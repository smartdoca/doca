import { describe, expect, it } from "vitest";
import { parseImageTaskRoute } from "../apps/server/src/services/ai/image-task-route.js";

describe("runtime image task scope", () => {
  it.each([
    ["all-document-pages", "逐页处理全部PDF并交付"],
    ["ordinary", "读取全部PDF，生成一张海报"],
    ["uncertain", "处理这些资料"],
  ])("requires a literal formal-user quote for %s", (route, text) => {
    expect(parseImageTaskRoute(JSON.stringify({ route, quote: text }), text))
      .toEqual({ route, quote: text });
  });
  it.each([
    '{"route":"all-document-pages"}',
    '{"route":"all-document-pages","quote":"全部图片","passed":true}',
    '{"route":"ordinary","quote":"只处理首页"}',
    '```json\n{"route":"ordinary","quote":"全部PDF"}\n```',
    '{"route":"all-document-pages","quote":"全部PDF"',
  ])("rejects malformed output and invented scope evidence", (text) => {
    expect(() => parseImageTaskRoute(text, "逐页处理全部PDF并交付")).toThrow();
  });
});
