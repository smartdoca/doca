import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const CREDENTIAL_MASTER_KEY_ENV = "DOCA_CREDENTIAL_MASTER_KEY";
export const MAX_CREDENTIAL_BYTES = 64 * 1024;
const domain = "doca.plugin-credential.v1";

export type CredentialCryptoErrorCode =
  | "missing-key"
  | "invalid-key"
  | "invalid-credential"
  | "invalid-record"
  | "key-mismatch"
  | "authentication-failed"
  | "disposed";

/** Errors deliberately contain neither input values nor native crypto errors. */
export class CredentialCryptoError extends Error {
  constructor(readonly code: CredentialCryptoErrorCode) {
    super(
      {
        "missing-key": `${CREDENTIAL_MASTER_KEY_ENV} is required for credential storage`,
        "invalid-key": `${CREDENTIAL_MASTER_KEY_ENV} must contain exactly 64 hexadecimal characters`,
        "invalid-credential": "Invalid credential value or identity",
        "invalid-record": "Invalid encrypted credential record",
        "key-mismatch":
          "Credential master key does not match the stored record",
        "authentication-failed": "Credential record authentication failed",
        disposed: "Credential cipher has been disposed",
      }[code],
    );
    this.name = "CredentialCryptoError";
  }
}

export interface CredentialBinding {
  readonly pluginId: string;
  readonly credentialId: string;
  readonly revision: number;
}

/** Internal encrypted representation; this is not a public plugin SDK export. */
export interface SealedCredential {
  readonly format: 1;
  readonly keyFingerprint: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface CredentialCipher {
  seal(binding: CredentialBinding, value: string): SealedCredential;
  open(binding: CredentialBinding, record: unknown): string;
  dispose(): void;
}

function identity(binding: CredentialBinding) {
  if (
    !binding ||
    ![binding.pluginId, binding.credentialId].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 160 &&
        !/[\u0000-\u001f\u007f]/.test(value),
    ) ||
    !Number.isSafeInteger(binding.revision) ||
    binding.revision < 1
  )
    throw new CredentialCryptoError("invalid-credential");
}

function decode(value: unknown, bytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(MAX_CREDENTIAL_BYTES / 3) * 4
  )
    throw new CredentialCryptoError("invalid-record");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (bytes !== undefined && decoded.length !== bytes) ||
    !decoded.length ||
    decoded.length > MAX_CREDENTIAL_BYTES
  )
    throw new CredentialCryptoError("invalid-record");
  return decoded;
}

/**
 * One host-supplied key shared by all instances. No generated default, keyring,
 * plaintext fallback, rotation, database access, or process-wide singleton.
 */
export function createCredentialCipher(
  masterKey: string | undefined = process.env[CREDENTIAL_MASTER_KEY_ENV],
): CredentialCipher {
  if (!masterKey) throw new CredentialCryptoError("missing-key");
  if (!/^[a-fA-F0-9]{64}$/.test(masterKey))
    throw new CredentialCryptoError("invalid-key");
  const key = Buffer.from(masterKey, "hex");
  const keyFingerprint = createHash("sha256")
    .update(domain)
    .update(key)
    .digest("hex");
  let disposed = false;
  function aad(binding: CredentialBinding) {
    if (disposed) throw new CredentialCryptoError("disposed");
    identity(binding);
    return Buffer.from(
      JSON.stringify([
        domain,
        keyFingerprint,
        binding.pluginId,
        binding.credentialId,
        binding.revision,
      ]),
      "utf8",
    );
  }
  return Object.freeze({
    seal(binding: CredentialBinding, value: string): SealedCredential {
      const authenticatedIdentity = aad(binding);
      if (
        typeof value !== "string" ||
        !value.length ||
        Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES
      )
        throw new CredentialCryptoError("invalid-credential");
      const plaintext = Buffer.from(value, "utf8");
      try {
        // Reject malformed Unicode instead of silently changing a secret.
        if (plaintext.toString("utf8") !== value)
          throw new CredentialCryptoError("invalid-credential");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(authenticatedIdentity);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        return Object.freeze({
          format: 1,
          keyFingerprint,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        });
      } finally {
        plaintext.fill(0);
      }
    },
    open(binding: CredentialBinding, input: unknown): string {
      const authenticatedIdentity = aad(binding);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "ciphertext,format,keyFingerprint,nonce,tag"
      )
        throw new CredentialCryptoError("invalid-record");
      const record = input as SealedCredential;
      if (
        record.format !== 1 ||
        typeof record.keyFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.keyFingerprint)
      )
        throw new CredentialCryptoError("invalid-record");
      if (record.keyFingerprint !== keyFingerprint)
        throw new CredentialCryptoError("key-mismatch");
      const nonce = decode(record.nonce, 12);
      const tag = decode(record.tag, 16);
      const ciphertext = decode(record.ciphertext);
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(authenticatedIdentity);
        decipher.setAuthTag(tag);
        // Do not expose unauthenticated update() bytes before final() succeeds.
        plaintext = decipher.update(ciphertext);
        const tail = decipher.final();
        const value = Buffer.concat([plaintext, tail]);
        try {
          return value.toString("utf8");
        } finally {
          value.fill(0);
          tail.fill(0);
        }
      } catch {
        throw new CredentialCryptoError("authentication-failed");
      } finally {
        plaintext?.fill(0);
      }
    },
    dispose() {
      key.fill(0);
      disposed = true;
    },
  });
}
