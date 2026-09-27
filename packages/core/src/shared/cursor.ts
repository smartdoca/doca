import { createHash } from "node:crypto";
import { fail } from "./errors.js";

export type PageCursor = { value: string; id: string };

export function cursorFingerprint(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function encodePageCursor(
  fingerprint: string,
  value: string,
  id: string,
) {
  return Buffer.from(JSON.stringify({ fingerprint, value, id })).toString(
    "base64url",
  );
}

export function decodePageCursor(
  cursor: string,
  fingerprint: string,
): PageCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      value.fingerprint !== fingerprint ||
      typeof value.value !== "string" ||
      typeof value.id !== "string"
    )
      throw Error();
    return { value: value.value, id: value.id };
  } catch {
    fail(400, "分页游标无效，请重新查询");
  }
}
