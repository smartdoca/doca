import { afterEach, expect, it, vi } from "vitest";
import { uploadFile } from "@web/shared/api.js";

const file = (index: number) =>
  new File([`Attachment ${index}`], `资料-${index}.json`, {
    type: "application/json",
  });
const response = (index: number) =>
  Response.json(
    {
      id: `asset-${index}`,
      filename: file(index).name,
      extractStatus: "pending",
    },
    { status: 201 },
  );

afterEach(() => vi.unstubAllGlobals());

const mockFetch = (upload: (url: string) => Promise<Response>) =>
  vi.stubGlobal("fetch", (url: string) =>
    url === "/api/v1/ai/upload-policy"
      ? Promise.resolve(
          Response.json({ maxFiles: 100, maxFileBytes: 0, maxTotalBytes: 0 }),
        )
      : upload(url),
  );

it("queues eight selected files below the server concurrency limit without dropping attachments", async () => {
  let active = 0;
  let peak = 0;
  const requests: string[] = [];
  mockFetch(async (url: string) => {
    const index = requests.length;
    requests.push(url);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(index);
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      uploadFile(file(index), "ai_attachment"),
    ),
  );
  expect(peak).toBe(2);
  expect(results.map((result) => result.id)).toEqual(
    Array.from({ length: 8 }, (_, index) => `asset-${index}`),
  );
  expect(
    requests.map((url) =>
      new URL(url, "http://localhost").searchParams.get("filename"),
    ),
  ).toEqual(Array.from({ length: 8 }, (_, index) => file(index).name));
});

it("continues the queue after a failed upload and preserves the server error for diagnosis", async () => {
  let requests = 0;
  mockFetch(async () => {
    const index = requests++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return index === 0
      ? Response.json(
          { message: "存储暂时不可用", requestId: "request-123" },
          { status: 500 },
        )
      : response(index);
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      uploadFile(file(index), "ai_attachment"),
    ),
  );
  expect(results[0]).toMatchObject({
    status: "rejected",
    reason: {
      message: "存储暂时不可用",
      status: 500,
      payload: { requestId: "request-123" },
    },
  });
  expect(
    results.slice(1).every((result) => result.status === "fulfilled"),
  ).toBe(true);
  expect(requests).toBe(8);
});

it("cancels a queued upload before sending its bytes and lets later files proceed", async () => {
  const pending: (() => void)[] = [];
  const requests: string[] = [];
  mockFetch((url: string) => {
    const index = requests.length;
    requests.push(url);
    return new Promise<Response>((resolve) =>
      pending.push(() => resolve(response(index))),
    );
  });
  const first = uploadFile(file(0), "ai_attachment");
  const second = uploadFile(file(1), "ai_attachment");
  const controller = new AbortController();
  const removed = uploadFile(
    file(2),
    "ai_attachment",
    undefined,
    controller.signal,
  );
  const last = uploadFile(file(3), "ai_attachment");
  controller.abort();
  await expect(removed).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests).toHaveLength(2);
  pending[0]!();
  pending[1]!();
  await Promise.all([first, second]);
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]).toContain(encodeURIComponent(file(3).name));
  pending[2]!();
  await last;
});

it("never starts an upload whose signal was already cancelled, including uploads with progress", async () => {
  const fetch = vi.fn();
  const xhr = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("XMLHttpRequest", xhr);
  const controller = new AbortController();
  controller.abort();
  for (const progress of [undefined, vi.fn()]) {
    await expect(
      uploadFile(
        file(0),
        "ai_attachment",
        undefined,
        controller.signal,
        progress,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
});

it("queues progress-enabled uploads too and reports progress and HTTP failures", async () => {
  mockFetch(async () => {
    throw Error("Upload must use XHR when progress is requested");
  });
  let active = 0;
  let peak = 0;
  let sent = 0;
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      upload: {
        onprogress?: (event: {
          loaded: number;
          total: number;
          lengthComputable: boolean;
        }) => void;
      } = {};
      onload?: () => void;
      status = 201;
      responseText = "";
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return null;
      }
      send(body: File) {
        const index = sent++;
        active++;
        peak = Math.max(peak, active);
        this.upload.onprogress?.({
          loaded: body.size,
          total: body.size,
          lengthComputable: true,
        });
        setTimeout(() => {
          active--;
          this.status = index === 0 ? 429 : 201;
          this.responseText = JSON.stringify(
            index === 0 ? { message: "上传繁忙" } : { id: `asset-${index}` },
          );
          this.onload?.();
        }, 5);
      }
    },
  );
  const progress = vi.fn();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      uploadFile(file(index), "ai_attachment", undefined, undefined, progress),
    ),
  );
  expect(peak).toBe(2);
  expect(sent).toBe(8);
  expect(progress).toHaveBeenCalledTimes(8);
  expect(progress.mock.calls.every(([event]) => event.percent === 100)).toBe(
    true,
  );
  expect(results[0]).toMatchObject({
    status: "rejected",
    reason: { message: "上传繁忙", status: 429 },
  });
  expect(
    results.slice(1).every((result) => result.status === "fulfilled"),
  ).toBe(true);
});
