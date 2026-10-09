import { afterEach, expect, it, vi } from "vitest";
import {
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraft,
} from "@web/features/ai/ai-composer-draft.js";

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}
it("restores exact text and reference positions together with uploaded files and folder targets, isolated by account and session", () => {
  storage();
  const key = composerDraftKey("account-a", "session-a");
  const draft: ComposerDraft = {
    version: 1,
    segments: [
      { type: "text", value: "  妈妈讲故事\n" },
      {
        type: "reference",
        reference: {
          resourceId: "book",
          label: "故事书",
          anchor: { page: 4 },
          epochId: "epoch-a",
          seq: 8,
        },
      },
      { type: "text", value: "\n保留原文和构图  " },
    ],
    attachments: [
      {
        id: "persistent-asset",
        filename: "妈妈六视图.png",
        mime: "image/png",
        size: 100,
      },
    ],
    folders: [{ kind: "folder", id: "folder-a", name: "书页" }],
  };
  writeComposerDraft(key, draft);
  expect(
    readComposerDraft(composerDraftKey("account-b", "session-a")),
  ).toBeNull();
  expect(
    readComposerDraft(composerDraftKey("account-a", "session-b")),
  ).toBeNull();
  expect(readComposerDraft(key)).toEqual(draft);
  writeComposerDraft(composerDraftKey("account-a", "session-b"), {
    version: 1,
    segments: [{ type: "text", value: "另一会话" }],
    attachments: [],
    folders: [],
  });
  expect(readComposerDraft(key)).toEqual(draft);
  writeComposerDraft(key, {
    version: 1,
    segments: [],
    attachments: [],
    folders: [],
  });
  expect(readComposerDraft(key)).toBeNull();
  expect(
    readComposerDraft(composerDraftKey("account-a", "session-b"))?.segments,
  ).toEqual([{ type: "text", value: "另一会话" }]);
});
it.each([
  "{bad json",
  JSON.stringify({ version: 0, segments: [], attachments: [], folders: [] }),
])(
  "rejects invalid stored drafts without converting or deleting them",
  (raw) => {
    const values = storage(),
      key = composerDraftKey("a", "s");
    values.set(key, raw);
    expect(() => readComposerDraft(key)).toThrow();
    expect(values.get(key)).toBe(raw);
  },
);
