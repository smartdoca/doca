import { z } from "zod";
import type { DB } from "@db/index.js";
import type { Actor } from "@core/modules/identity/passwords.js";
import { aiConfig } from "@core/modules/ai/config.js";
import {
  bookAccess,
  bookHash,
} from "@core/modules/knowledge-books/management.js";
import type { BookSourceRuntime } from "@core/modules/knowledge-books/sources.js";
import { AppError } from "@core/shared/errors.js";
import { searchWeb, normalizeWebSites } from "./web-search.js";

export const bookWebSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    sites: z.string().max(300).optional(),
    language: z.enum(["zh", "en"]).optional(),
  })
  .strict();
export async function searchBookWebSources(
  db: DB,
  actor: Actor,
  bookId: string,
  raw: unknown,
) {
  await bookAccess(db, actor, bookId, 3);
  const input = bookWebSearchSchema.parse(raw);
  return searchWeb(
    (await aiConfig(db)).webSearch,
    input.query,
    undefined,
    fetch,
    {
      sites: normalizeWebSites(input.sites),
      language: input.language,
      limit: 8,
    },
  );
}
export const bookWebCheckSchema = z
  .object({ urls: z.array(z.string().url().max(4000)).min(1).max(50) })
  .strict();
export async function checkBookWebSources(
  db: DB,
  actor: Actor,
  bookId: string,
  raw: unknown,
  runtime: BookSourceRuntime,
) {
  await bookAccess(db, actor, bookId, 3);
  const input = bookWebCheckSchema.parse(raw);
  const results: Array<{
    url: string;
    valid: boolean;
    title?: string;
    characters?: number;
    contentHash?: string;
    preview?: string;
    checkedAt: string;
    error?: "invalid_url" | "unavailable" | "empty" | "too_large";
  }> = [];
  for (const url of [...new Set(input.urls)]) {
    const parsed = new URL(url),
      checkedAt = new Date().toISOString();
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      results.push({
        url:
          parsed.username || parsed.password
            ? `${parsed.protocol}//${parsed.host}${parsed.pathname}`
            : url,
        valid: false,
        error: "invalid_url",
        checkedAt,
      });
      continue;
    }
    try {
      const page = await runtime.readWeb(url);
      if (!page.text.trim())
        results.push({ url, valid: false, error: "empty", checkedAt });
      else if (page.text.length > 120000)
        results.push({ url, valid: false, error: "too_large", checkedAt });
      else
        results.push({
          url,
          valid: true,
          title: page.title,
          characters: page.text.length,
          contentHash: bookHash(page.text),
          preview: page.text.slice(0, 1500),
          checkedAt,
        });
    } catch (error) {
      results.push({
        url,
        valid: false,
        error:
          error instanceof AppError && error.status === 413
            ? "too_large"
            : "unavailable",
        checkedAt,
      });
    }
  }
  return { items: results };
}
