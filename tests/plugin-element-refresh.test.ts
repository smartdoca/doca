import { afterEach, expect, it, vi } from "vitest";
import { createElementViewRefresh } from "../apps/web/src/features/documents/plugin-element-refresh.js";

afterEach(() => vi.useRealTimers());
it("has no idle timer, coalesces visible elements, stops offscreen/hidden and cancels on disposal", () => {
  vi.useFakeTimers();
  let visible = true;
  const refresh = vi.fn(),
    scheduler = createElementViewRefresh(refresh, () => visible);
  vi.advanceTimersByTime(60000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  scheduler.schedule(60000);
  for (let i = 0; i < 100; i++) scheduler.schedule(1000);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(999);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  // No visible timed cells were drawn after that refresh, so it does not recur.
  vi.advanceTimersByTime(60000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  scheduler.schedule(1000);
  visible = false;
  vi.advanceTimersByTime(1000);
  scheduler.schedule(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  visible = true;
  scheduler.schedule(1);
  vi.advanceTimersByTime(999);
  expect(refresh).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  scheduler.schedule(1000);
  scheduler.cancel();
  vi.advanceTimersByTime(60000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
