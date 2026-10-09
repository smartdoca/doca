import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import sharp from "sharp";
import { defaultImageProfile, imageModelProfiles, imageProfileForModel } from "@core/modules/ai/image-model-catalog.js";
import { imageProviderRequest, invokeImageProvider, imageProviderPixels, type ImageProviderInput } from "../apps/server/src/services/ai/image-provider-adapters.js";
import { parseMfluxImageProviderOutput } from "../apps/server/src/services/ai/image-provider-mflux.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const profile = imageModelProfiles.find((profile) => profile.id === "mflux-flux2-klein-9b-q8-v1")!;
const png = (color: string) => sharp({ create: { width: 256, height: 256, channels: 3, background: color } }).png().toBuffer();
const base: ImageProviderInput = { profile, model: "flux2-klein-9b-8bit", apiKey: "mock-only", baseUrl: "http://127.0.0.1:39365/v1", operation: "edit", prompt: "Change the target while retaining other roles.", size: "256x256", images: [] };
function response(bytes: Buffer, input: ImageProviderInput) {
  return { version: 1, status: "completed", profile: input.profile.id, model: input.model, request_id: "ab838680-6df9-4c50-890c-f3cc209c3343",
    input_sha256: input.images.map((image) => sha(image.data)),
    data: [{ b64_json: bytes.toString("base64"), mime: "image/png", width: 256, height: 256, sha256: sha(bytes) }],
    usage: { input_images: input.images.length, generated_images: 1, runtime: { implementation: "mflux", implementation_version: "0.22.0", steps: 4, seed: 42, elapsed_seconds: 1.2, model_revision: "a".repeat(40) } } };
}

it("requires an explicit local profile and keeps the approved old config defaults unchanged", () => {
  for (const model of ["flux2-klein-9b-8bit", "qwen-image-edit-2511-8bit", profile.id]) expect(defaultImageProfile("compatible", model)).toBeUndefined();
  expect(defaultImageProfile("compatible", "existing-unrelated-deployment")?.adapter).toBe("openai-images");
  expect(imageProfileForModel({ provider: "compatible", imageGeneration: true, imageProfile: profile.id })).toEqual(profile);
});

it("sends the real source first and preserves ordered references on a single native request", async () => {
  const source = await png("blue"), identity = await png("red"), result = await png("green");
  const input = { ...base, images: [{ data: source, mime: "image/png", filename: "source.png" }, { data: identity, mime: "image/png", filename: "identity.png" }] };
  const raw = response(result, input);
  const fetcher = vi.fn(async (url, options) => {
    expect(url).toBe("http://127.0.0.1:39365/v1/images");
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ version: 1, profile: profile.id, model: "flux2-klein-9b-8bit", operation: "edit", width: 256, height: 256, n: 1 });
    expect(body.images.map((image: any) => image.sha256)).toEqual([sha(source), sha(identity)]);
    expect(body.images.map((image: any) => Buffer.from(image.b64_json, "base64"))).toEqual([source, identity]);
    return Response.json(raw);
  });
  const output = await invokeImageProvider(input, { fetch: fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(output.protocol).toBe("mflux-native-v1");
  expect(output.usage).toEqual(raw.usage);
  expect(await imageProviderPixels(output)).toEqual(result);
});

it.each(["version", "count", "hash", "dimensions", "source-order", "model", "steps"])("rejects a mismatched native %s without another generation", async (field) => {
  const source = await png("blue"), identity = await png("red"), result = await png("green");
  const input = { ...base, images: [{ data: source, mime: "image/png", filename: "source" }, { data: identity, mime: "image/png", filename: "identity" }] };
  const raw: any = response(result, input);
  if (field === "version") raw.version = 0;
  if (field === "count") raw.usage.generated_images = 2;
  if (field === "hash") raw.data[0].sha256 = "f".repeat(64);
  if (field === "dimensions") raw.data[0].width = 128;
  if (field === "source-order") raw.input_sha256.reverse();
  if (field === "model") raw.model = "qwen-image-edit-2511-8bit";
  if (field === "steps") raw.usage.runtime.steps = 1;
  const fetcher = vi.fn(async () => Response.json(raw));
  await expect(invokeImageProvider(input, { fetch: fetcher })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects malformed and truly transparent reference bytes before a native submission", async () => {
  const alpha = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
  for (const data of [Buffer.from("invalid PNG"), alpha]) {
    const fetcher = vi.fn();
    await expect(invokeImageProvider({ ...base, images: [{ data, mime: "image/png", filename: "input" }] }, { fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("uses generation without references, rejects unsupported masks and never aliases a GPT model", () => {
  expect(JSON.parse(String(imageProviderRequest({ ...base, operation: "generate" }).init.body)).images).toEqual([]);
  expect(() => imageProviderRequest({ ...base, model: "gpt-image-2", operation: "generate" })).toThrow();
  expect(() => imageProviderRequest({ ...base, mask: Buffer.from("mask"), images: [{ data: Buffer.from("image"), mime: "image/png", filename: "source" }] })).toThrow();
});

it("refuses incomplete receipts and retained result URLs instead of downloading them", async () => {
  const input = { ...base, operation: "generate" as const };
  const raw: any = response(await png("green"), input);
  raw.status = "running";
  expect(() => parseMfluxImageProviderOutput(raw)).toThrow();
  raw.status = "completed";
  delete raw.data[0].b64_json;
  raw.data[0].url = "https://example.invalid/result.png";
  expect(() => parseMfluxImageProviderOutput(raw)).toThrow();
});

it("does not resubmit when the local service rejects a generation", async () => {
  const fetcher = vi.fn(async () => Response.json({ detail: "Local model unavailable" }, { status: 503 }));
  await expect(invokeImageProvider({ ...base, operation: "generate" }, { fetch: fetcher })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
