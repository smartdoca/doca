import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialCipher,
  CredentialCryptoError,
  MAX_CREDENTIAL_BYTES,
  CREDENTIAL_MASTER_KEY_ENV,
} from "@server/services/credential-cipher.js";

const binding = {
  pluginId: "test.mail",
  credentialId: "account-a",
  revision: 1,
};

afterEach(() => vi.unstubAllEnvs());

describe("host credential encryption", () => {
  it("reads the global host environment value without a generated default", () => {
    vi.stubEnv(CREDENTIAL_MASTER_KEY_ENV, undefined);
    expect(() => createCredentialCipher()).toThrow(
      new CredentialCryptoError("missing-key"),
    );
    vi.stubEnv(CREDENTIAL_MASTER_KEY_ENV, randomBytes(32).toString("hex"));
    const a = createCredentialCipher();
    const b = createCredentialCipher();
    try {
      const record = a.seal(binding, "environment-key-test");
      expect(b.open(binding, record)).toBe("environment-key-test");
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("lets independent instances decrypt with the same environment key", () => {
    const key = randomBytes(32).toString("hex");
    const a = createCredentialCipher(key);
    const b = createCredentialCipher(key);
    try {
      const secret = '{"accessToken":"秘密","refreshToken":"refresh-value"}';
      const first = a.seal(binding, secret);
      const second = a.seal(binding, secret);
      expect(first.nonce).not.toBe(second.nonce);
      expect(first.ciphertext).not.toBe(second.ciphertext);
      expect(JSON.stringify(first)).not.toContain("refresh-value");
      expect(JSON.stringify(first)).not.toContain(key);
      expect(b.open(binding, first)).toBe(secret);
      a.dispose();
      expect(b.open(binding, second)).toBe(secret);
      expect(() => a.open(binding, first)).toThrow("disposed");
      expect(() => a.seal(binding, secret)).toThrow("disposed");
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it.each([
    { pluginId: "test.calendar" },
    { credentialId: "account-b" },
    { revision: 2 },
  ])("authenticates the plugin, credential and revision: %j", (change) => {
    const cipher = createCredentialCipher(randomBytes(32).toString("hex"));
    try {
      const sealed = cipher.seal(binding, "secret-value");
      expect(() => cipher.open({ ...binding, ...change }, sealed)).toThrow(
        "authentication failed",
      );
    } finally {
      cipher.dispose();
    }
  });

  it.each(["nonce", "tag", "ciphertext"] as const)(
    "rejects tampering with %s without disclosing any plaintext",
    (field) => {
      const cipher = createCredentialCipher(randomBytes(32).toString("hex"));
      try {
        const record = cipher.seal(binding, "never-include-this-in-errors");
        const bytes = Buffer.from(record[field], "base64");
        bytes[0] = bytes[0]! ^ 1;
        const altered = { ...record, [field]: bytes.toString("base64") };
        expect(() => cipher.open(binding, altered)).toThrow(
          new CredentialCryptoError("authentication-failed"),
        );
      } finally {
        cipher.dispose();
      }
    },
  );

  it("rejects replacement keys instead of returning plaintext or reencrypting", () => {
    const a = createCredentialCipher(randomBytes(32).toString("hex"));
    const b = createCredentialCipher(randomBytes(32).toString("hex"));
    try {
      const record = a.seal(binding, "secret");
      expect(() => b.open(binding, record)).toThrow(
        new CredentialCryptoError("key-mismatch"),
      );
      expect(a.open(binding, record)).toBe("secret");
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it.each(["", "short-secret", "z".repeat(64), " " + "ab".repeat(32)])(
    "rejects missing or invalid configuration without echoing it",
    (key) => {
      expect(() => createCredentialCipher(key)).toThrow(CredentialCryptoError);
      try {
        createCredentialCipher(key);
      } catch (error) {
        if (key) expect((error as Error).message).not.toContain(key);
      }
    },
  );

  it("enforces byte limits and rejects malformed Unicode without conversion", () => {
    const cipher = createCredentialCipher(randomBytes(32).toString("hex"));
    try {
      const maximum = "a".repeat(MAX_CREDENTIAL_BYTES);
      expect(cipher.open(binding, cipher.seal(binding, maximum))).toBe(maximum);
      for (const value of [
        "",
        maximum + "a",
        "汉".repeat(MAX_CREDENTIAL_BYTES / 2),
        "\ud800",
      ])
        expect(() => cipher.seal(binding, value)).toThrow(
          new CredentialCryptoError("invalid-credential"),
        );
    } finally {
      cipher.dispose();
    }
  });

  it("rejects unknown, plaintext and malformed encrypted formats", () => {
    const cipher = createCredentialCipher(randomBytes(32).toString("hex"));
    try {
      const record = cipher.seal(binding, "secret");
      for (const input of [
        null,
        "secret",
        { value: "secret" },
        { ...record, format: 2 },
        { ...record, legacy: true },
        { ...record, nonce: record.nonce + "\n" },
        { ...record, tag: "AA==" },
        { ...record, ciphertext: "" },
      ])
        expect(() => cipher.open(binding, input)).toThrow(
          new CredentialCryptoError("invalid-record"),
        );
    } finally {
      cipher.dispose();
    }
  });
});
