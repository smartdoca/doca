import { expect, it, vi } from "vitest";
import {
  composingKey,
  createCompositionGate,
} from "../apps/web/src/features/search/composition.js";

it("does not search or reveal unfinished pinyin, then commits the complete Chinese query", () => {
  const findAndReveal = vi.fn();
  const gate = createCompositionGate(findAndReveal);
  gate.change("已有");
  findAndReveal.mockClear();
  gate.start();
  for (const value of ["已有s", "已有sh", "已有shu", "已有输入"])
    gate.change(value);
  expect(gate.composing).toBe(true);
  expect(findAndReveal).not.toHaveBeenCalled();
  gate.end("已有输入");
  expect(gate.composing).toBe(false);
  expect(findAndReveal).toHaveBeenCalledExactlyOnceWith("已有输入");
  gate.change("");
  expect(findAndReveal).toHaveBeenLastCalledWith("");
});

it("preserves IME confirmation/cancellation keys, including the final key with keyCode 229", () => {
  expect(composingKey({ isComposing: true, keyCode: 13 })).toBe(true);
  expect(composingKey({ isComposing: true, keyCode: 27 })).toBe(true);
  expect(composingKey({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(composingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  expect(composingKey({ isComposing: false, keyCode: 27 })).toBe(false);
});

it("leaves committed text unchanged when composition is cancelled", () => {
  const commit = vi.fn();
  const gate = createCompositionGate(commit);
  gate.change("文档");
  gate.start();
  gate.change("文档pin");
  gate.end("文档");
  expect(commit.mock.calls.map(([value]) => value)).toEqual(["文档", "文档"]);
});
