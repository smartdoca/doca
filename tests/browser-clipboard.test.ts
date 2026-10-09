import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "@web/shared/clipboard.js";

afterEach(() => vi.unstubAllGlobals());

it("uses native text copy without creating a DOM adapter", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await writeClipboardText("http://doca.internal/#/r/test");
  expect(writeText).toHaveBeenCalledWith("http://doca.internal/#/r/test");
});

it.each([true, false])(
  "restores focus and selection after HTTP copy (success=%s)",
  async (success) => {
    const field = {
      value: "",
      readOnly: false,
      tabIndex: 0,
      style: {},
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    const range = {};
    const selection = {
      rangeCount: 1,
      getRangeAt: () => ({ cloneRange: () => range }),
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    const active = { focus: vi.fn() };
    const execCommand = vi.fn(() => {
      expect(field.value).toBe("isolated HTTP copy");
      return success;
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      activeElement: active,
      getSelection: () => selection,
      createElement: () => field,
      body: { append: vi.fn() },
      execCommand,
    });
    const copied = writeClipboardText("isolated HTTP copy");
    if (success) await expect(copied).resolves.toBeUndefined();
    else await expect(copied).rejects.toThrow("Copy failed");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalledOnce();
    expect(active.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(selection.addRange).toHaveBeenCalledWith(range);
  },
);

it("reports a native permission failure instead of pretending the copy succeeded", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
  });
  await expect(writeClipboardText("private text")).rejects.toThrow("Denied");
});
