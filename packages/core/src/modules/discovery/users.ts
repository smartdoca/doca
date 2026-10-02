import { sql } from "kysely";
import type {
  DirectoryPage,
  DirectorySearchInput,
  DirectoryUser,
} from "@smartdoca/plugin-contracts";
import type { DB } from "../../../../db/src/index.js";
import type { Actor } from "../identity/passwords.js";
import {
  cursorFingerprint,
  decodePageCursor,
  encodePageCursor,
} from "../../shared/cursor.js";
import { fail } from "../../shared/errors.js";
import { assertDirectoryMode, directoryAccess } from "./directory.js";

function queryUsers(db: DB, ids: Set<string> | null) {
  let query = db
    .selectFrom("users")
    .leftJoin("user_preferences", "user_preferences.user_id", "users.id")
    .select([
      "users.id",
      "users.display_name",
      "users.public_id",
      "user_preferences.avatar",
      "user_preferences.avatar_asset_id",
    ])
    .where("users.status", "=", "active");
  if (ids) query = query.where("users.id", "in", [...ids]);
  return query;
}
function project(user: {
  id: string;
  display_name: string;
  public_id?: string | null;
  avatar: string | null;
  avatar_asset_id?: string | null;
}): DirectoryUser {
  return {
    ...user,
    public_id: user.public_id ?? null,
    avatar_asset_id: user.avatar_asset_id ?? null,
    display_name: user.display_name.trim() || user.public_id || user.id,
  };
}
function selectionIds(ids: readonly string[]) {
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 200)
  )
    fail(400, "Invalid directory selection");
  return [...new Set(ids)];
}

/** Policy-aware public directory. Never returns full account profiles or credentials. */
export function createUserDirectory(db: DB) {
  return {
    async search(
      actor: Actor,
      input: DirectorySearchInput,
      signal?: AbortSignal,
    ): Promise<DirectoryPage> {
      if (typeof input.query !== "string" || input.query.length > 160)
        fail(400, "Invalid directory query");
      const limit = input.limit ?? 20;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.cursor && input.cursor.length > 2048)
      )
        fail(400, "Invalid directory page");
      const access = await directoryAccess(db, actor, signal);
      const text = input.query.trim().toLowerCase();
      const fingerprint = cursorFingerprint({
        directory: 1,
        user: actor.id,
        mode: access.mode,
        query: text,
      });
      const cursor = input.cursor
        ? decodePageCursor(input.cursor, fingerprint)
        : null;
      if (access.ids && !access.ids.size)
        return { items: [], nextCursor: null, complete: access.complete };
      let query = queryUsers(db, access.ids);
      const escaped = text
        .replaceAll("!", "!!")
        .replaceAll("%", "!%")
        .replaceAll("_", "!_");
      if (escaped)
        query = query.where((eb) =>
          eb.or([
            sql<boolean>`lower(users.public_id) like ${escaped + "%"} escape '!'`,
            sql<boolean>`lower(users.display_name) like ${"%" + escaped + "%"} escape '!'`,
          ]),
        );
      if (cursor)
        query = query.where((eb) =>
          eb.or([
            eb("users.display_name", ">", cursor.value),
            eb.and([
              eb("users.display_name", "=", cursor.value),
              eb("users.id", ">", cursor.id),
            ]),
          ]),
        );
      const rows = await query
        .orderBy("users.display_name")
        .orderBy("users.id")
        .limit(limit + 1)
        .execute();
      signal?.throwIfAborted();
      await assertDirectoryMode(db, actor, access.mode);
      const last = rows[limit - 1];
      return {
        items: rows.slice(0, limit).map(project),
        nextCursor:
          rows.length > limit && last
            ? encodePageCursor(fingerprint, last.display_name, last.id)
            : null,
        complete: access.complete,
      };
    },
    async resolve(
      actor: Actor,
      input: { ids: readonly string[] },
      signal?: AbortSignal,
    ): Promise<readonly DirectoryUser[]> {
      const ids = selectionIds(input.ids);
      const access = await directoryAccess(db, actor, signal);
      const visible = ids.filter(
        (id) => access.ids === null || access.ids.has(id),
      );
      if (!visible.length) return [];
      const rows = await queryUsers(db, new Set(visible)).execute();
      signal?.throwIfAborted();
      await assertDirectoryMode(db, actor, access.mode);
      const byId = new Map(rows.map((user) => [user.id, project(user)]));
      return ids.flatMap((id) => {
        const user = byId.get(id);
        return user ? [user] : [];
      });
    },
    async validate(
      actor: Actor,
      input: { ids: readonly string[] },
      signal?: AbortSignal,
    ): Promise<void> {
      const ids = selectionIds(input.ids);
      const users = await this.resolve(actor, { ids }, signal);
      if (users.length !== ids.length) fail(403, "包含当前不可选择的用户");
    },
  };
}
