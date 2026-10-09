import { createHash, webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { installBrowserCrypto } from "@web/shared/browser-crypto.js";

it("supplies cryptographic UUID v4 when HTTP browsers lack randomUUID", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) =>
    webcrypto.getRandomValues(bytes),
  );
  const target = { getRandomValues } as unknown as Crypto;
  installBrowserCrypto(target);
  const ids = Array.from({ length: 100 }, () => target.randomUUID());
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids)
    expect(id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  expect(getRandomValues).toHaveBeenCalledTimes(ids.length);
});

it("keeps the native UUID implementation when it exists", () => {
  const native = vi.fn(() => "00112233-4455-4677-8899-aabbccddeeff" as const);
  const target = { randomUUID: native } as unknown as Crypto;
  installBrowserCrypto(target);
  expect(target.randomUUID).toBe(native);
  expect(target.randomUUID()).toBe("00112233-4455-4677-8899-aabbccddeeff");
});

it("fails explicitly without a cryptographic random source", () => {
  expect(() => installBrowserCrypto({} as Crypto)).toThrow(
    "cryptographic random",
  );
});

it("matches native SHA-256 byte-for-byte for snapshots and offset buffer views", async () => {
  const target = {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
  } as unknown as Crypto;
  installBrowserCrypto(target);
  for (const value of ["", "abc", "HTTP 表格快照", "x".repeat(10000)]) {
    const bytes = new TextEncoder().encode(value);
    const actual = await target.subtle.digest("SHA-256", bytes);
    expect(Buffer.from(actual).toString("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(actual).toEqual(await webcrypto.subtle.digest("SHA-256", bytes));
  }
  const padded = new Uint8Array([0, 97, 98, 99, 0]);
  const actual = await target.subtle.digest(
    { name: "sha-256" },
    padded.subarray(1, 4),
  );
  expect(Buffer.from(actual).toString("hex")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const full = await target.subtle.digest("SHA-256", padded.buffer);
  expect(Buffer.from(full).toString("hex")).toBe(
    createHash("sha256").update(padded).digest("hex"),
  );
  await expect(target.subtle.digest("SHA-512", padded)).rejects.toMatchObject({
    name: "NotSupportedError",
  });
  expect(target.subtle.encrypt).toBeUndefined();
});

it("preserves native WebCrypto rather than replacing its encryption surface", () => {
  const target = {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    subtle: webcrypto.subtle,
  } as unknown as Crypto;
  installBrowserCrypto(target);
  expect(target.subtle).toBe(webcrypto.subtle);
});
