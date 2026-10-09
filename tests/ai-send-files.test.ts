import { expect, it, vi } from "vitest";
import { prepareSendFiles, type SendFile } from "../apps/web/src/features/ai/ai-send-files.js";

const selected = (uid: string): SendFile => ({
  uid, filename: `${uid}.txt`, mime: "text/plain", size: 4,
  local: new File(["text"], `${uid}.txt`, { type: "text/plain" }),
});
const uploaded = (id: string, extractStatus: "pending" | "ready" = "ready") => ({
  id, filename: `${id}.txt`, mime: "text/plain", size: 4, extractStatus,
});

it("finishes uploading and parsing every attachment before the message can be submitted", async () => {
  const files = [selected("one"), selected("two")];
  const update = vi.fn();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const extract = vi.fn(async (id: string) => {
    if (id === "two") await gate;
    return { status: "ready" as const };
  });
  const dependencies = {
    upload: vi.fn(async (file: File, _signal: AbortSignal, progress: (percent: number) => void) => {
      progress(50);
      return uploaded(file.name.replace(".txt", ""), "pending");
    }),
    extract, pause: vi.fn(async () => {}),
  };
  let ready = false;
  const preparing = prepareSendFiles(files, new AbortController().signal, update, dependencies)
    .then(result => { ready = true; return result; });
  await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
  expect(ready).toBe(false);
  expect(update).toHaveBeenCalledWith({ uid: "two", status: "uploading", percent: 50 });
  release();
  expect((await preparing).map(file => file.id)).toEqual(["one", "two"]);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ uid: "two", status: "ready" }));
});

it("keeps successful uploads when another attachment fails and retries only the missing file", async () => {
  const files = [selected("one"), selected("two")];
  let failed = false;
  const dependencies = {
    upload: vi.fn(async (file: File) => {
      if (file.name === "two.txt" && !failed) {
        failed = true;
        throw new Error("temporary failure");
      }
      return uploaded(file.name.replace(".txt", ""));
    }),
    extract: vi.fn(), pause: vi.fn(),
  };
  await expect(prepareSendFiles(files, new AbortController().signal, vi.fn(), dependencies))
    .rejects.toThrow("temporary failure");
  expect(files[0]!.uploaded?.id).toBe("one");
  const ready = await prepareSendFiles(files, new AbortController().signal, vi.fn(), dependencies);
  expect(ready.map(file => file.id)).toEqual(["one", "two"]);
  expect(dependencies.upload.mock.calls.map(([file]) => file.name)).toEqual(["one.txt", "two.txt", "two.txt"]);
});

it("reuses an uploaded asset while polling parsing and stops before submitting a failed or canceled input", async () => {
  const file = selected("one");
  file.uploaded = uploaded("one", "pending");
  const dependencies = {
    upload: vi.fn(), pause: vi.fn(async () => {}),
    extract: vi.fn().mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "failed", error: "invalid document" }),
  };
  await expect(prepareSendFiles([file], new AbortController().signal, vi.fn(), dependencies))
    .rejects.toThrow("invalid document");
  expect(dependencies.upload).not.toHaveBeenCalled();
  expect(dependencies.pause).toHaveBeenCalledOnce();
  const controller = new AbortController();
  controller.abort(new Error("canceled"));
  await expect(prepareSendFiles([selected("two")], controller.signal, vi.fn(), dependencies))
    .rejects.toThrow("canceled");
  expect(dependencies.upload).not.toHaveBeenCalled();
});
