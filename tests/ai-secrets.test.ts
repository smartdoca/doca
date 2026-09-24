import { expect, it } from "vitest";
import { openTestDatabase } from "./database.js";
import { createUser } from "@core/modules/identity/passwords.js";
import { readNote, writeNote } from "../apps/server/src/services/ai/notes.js";
import {
  bindUserSecrets,
  deleteSecret,
  fillSecretPlaceholders,
  listSecrets,
  scrubSecretValues,
  writeSecret,
} from "../apps/server/src/services/ai/secrets.js";

it("keeps password-book values with their owner and out of the memo", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  try {
    const owner = await createUser(
      db,
      { login: "owner", displayName: "Owner", password: "owner-pass-2026" },
      { bootstrap: true },
    );
    const other = await createUser(
      db,
      { login: "other", displayName: "Other", password: "other-pass-2026" },
      { actor: { ...owner, admin: 1 } },
    );
    const saved = await writeSecret(db, owner.id, "PASSWORD", "s3cret-value");
    expect(saved).toEqual({ key: "PASSWORD", saved: true });
    expect(saved).not.toHaveProperty("value");
    await writeNote(db, owner.id, "令牌 s3cret-value\n站点 {{PASSWORD}}");
    expect((await readNote(db, owner.id)).content).toBe(
      "令牌 {{PASSWORD}}\n站点 {{PASSWORD}}",
    );
    expect(await listSecrets(db, other.id)).toEqual([]);
    await expect(deleteSecret(db, other.id, "PASSWORD")).rejects.toThrow(
      "没有这项",
    );
    expect((await listSecrets(db, owner.id)).map((item) => item.key)).toEqual([
      "PASSWORD",
    ]);
    const ownerVault = await bindUserSecrets(db, owner.id);
    const otherVault = await bindUserSecrets(db, other.id);
    expect(ownerVault.fill("Bearer {{PASSWORD}}")).toBe("Bearer s3cret-value");
    expect(ownerVault.hide("echo s3cret-value")).toBe("echo {{PASSWORD}}");
    expect(() => otherVault.fill("Bearer {{PASSWORD}}")).toThrow("没有");
    expect(
      fillSecretPlaceholders("{{PASSWORD}}", [
        { key: "PASSWORD", value: "s3cret-value" },
      ]),
    ).toBe("s3cret-value");
    expect(
      scrubSecretValues("s3cret-value and shorter", [
        { key: "PASSWORD", value: "s3cret-value" },
        { key: "SHORT", value: "ab" },
      ]),
    ).toBe("{{PASSWORD}} and shorter");
  } finally {
    await db.destroy();
  }
});
