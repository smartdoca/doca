import { sha256 } from "@noble/hashes/sha2.js";

type BrowserCrypto = Pick<Crypto, "getRandomValues"> & {
  randomUUID?: Crypto["randomUUID"];
  subtle?: Pick<SubtleCrypto, "digest">;
};

/** Approved HTTP browser adapter; UUID v4 and persisted ID formats are unchanged. */
export function installBrowserCrypto(
  target: BrowserCrypto = globalThis.crypto,
) {
  if (typeof target.randomUUID !== "function") {
    if (typeof target.getRandomValues !== "function")
      throw new Error("A cryptographic random number generator is required");
    Object.defineProperty(target, "randomUUID", {
      configurable: true,
      writable: true,
      value: (): ReturnType<Crypto["randomUUID"]> => {
        const bytes = target.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  }
  if (target.subtle === undefined)
    Object.defineProperty(target, "subtle", {
      configurable: true,
      value: {
        async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          const name =
            typeof algorithm === "string" ? algorithm : algorithm.name;
          if (name.toUpperCase() !== "SHA-256")
            throw new DOMException(
              "Only SHA-256 digest is supported",
              "NotSupportedError",
            );
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          return new Uint8Array(sha256(bytes)).buffer;
        },
      },
    });
}

if (typeof window !== "undefined") installBrowserCrypto();
