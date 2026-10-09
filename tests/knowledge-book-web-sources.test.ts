import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import { openTestDatabase } from "./database.js";
import type { DB } from "@db/index.js";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { createKnowledgeBook } from "@core/modules/knowledge-books/management.js";
import { aiDefaults } from "@core/modules/ai/config.js";
import { fail, AppError } from "@core/shared/errors.js";
import { registerKnowledgeBooks } from "../apps/server/src/routes/knowledge-books.js";
import {
  searchBookWebSources,
  checkBookWebSources,
} from "../apps/server/src/services/ai/knowledge-book-web-sources.js";
const search = vi.hoisted(() => vi.fn());
vi.mock("../apps/server/src/services/ai/web-search.js", async (original) => ({
  ...(await original<
    typeof import("../apps/server/src/services/ai/web-search.js")
  >()),
  searchWeb: search,
}));
let db: DB, owner: Actor, stranger: Actor, bookId: string;
beforeEach(async () => {
  search.mockReset();
  db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  owner = {
    ...(await createUser(
      db,
      { login: "owner", displayName: "Owner", password: randomUUID() },
      { bootstrap: true },
    )),
    admin: 1,
  };
  stranger = {
    ...(await createUser(
      db,
      { login: "stranger", displayName: "Stranger", password: randomUUID() },
      { actor: owner },
    )),
    admin: 0,
  };
  bookId = (await createKnowledgeBook(db, owner, "Web sources")).id;
  await db
    .insertInto("account_settings")
    .values({
      id: "ai",
      revision: 1,
      config: JSON.stringify({
        ...aiDefaults,
        webSearch: {
          provider: "searxng",
          baseUrl: "http://127.0.0.1:8080",
          apiKey: null,
        },
      }),
    })
    .execute();
});
afterEach(async () => {
  await db.destroy();
});
it("uses the configured SearXNG endpoint and website constraints only after checking book edit permission", async () => {
  search.mockResolvedValue({
    sources: [
      {
        title: "RFC",
        url: "https://www.rfc-editor.org/rfc/rfc9293.html",
        snippet: "TCP",
        retrievedAt: "now",
      },
    ],
    provider: "searxng",
    query: "TCP",
  });
  const request = { query: "TCP", sites: "rfc-editor.org", language: "en" };
  await expect(
    searchBookWebSources(db, stranger, bookId, request),
  ).rejects.toMatchObject({ status: 404 });
  expect(search).not.toHaveBeenCalled();
  const result = await searchBookWebSources(db, owner, bookId, request);
  expect(result.sources).toHaveLength(1);
  expect(search.mock.calls[0]![0]).toMatchObject({
    provider: "searxng",
    baseUrl: "http://127.0.0.1:8080",
  });
  expect(search.mock.calls[0]![4]).toMatchObject({
    sites: ["rfc-editor.org"],
    language: "en",
    limit: 8,
  });
});
it("verifies actual body text and reports invalid, empty, inaccessible and oversized pages independently", async () => {
  const readWeb = vi.fn(async (url: string) => {
    if (url.includes("empty")) return { title: "Empty", text: "  " };
    if (url.includes("large"))
      return { title: "Large", text: "x".repeat(120001) };
    if (url.includes("private")) fail(403, "Blocked");
    return { title: "TCP", text: "TCP is a byte stream." };
  });
  const result = await checkBookWebSources(
    db,
    owner,
    bookId,
    {
      urls: [
        "https://example.com/tcp",
        "https://example.com/empty",
        "https://example.com/large",
        "https://example.com/private",
        "https://secret:password@example.com/tcp",
        "ftp://example.com/tcp",
      ],
    },
    {
      readWeb,
      async readFile() {
        throw new Error("not used");
      },
    },
  );
  expect(result.items.map((item) => item.valid)).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(result.items[0]).toMatchObject({
    title: "TCP",
    characters: 21,
    preview: "TCP is a byte stream.",
  });
  expect(result.items.slice(1).map((item) => item.error)).toEqual([
    "empty",
    "too_large",
    "unavailable",
    "invalid_url",
    "invalid_url",
  ]);
  expect(readWeb).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(result)).not.toContain("password");
});

it("returns HTTP 400 for malformed web requests, including whitespace queries, without calling a search provider", async () => {
  const api = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  api.setErrorHandler<FastifyError>((error, _request, reply) => {
    reply
      .status(
        error instanceof AppError ? error.status : (error.statusCode ?? 500),
      )
      .send({ error: error.message });
  });
  registerKnowledgeBooks(api, db, () => owner);
  try {
    for (const [route, payload] of [
      ["source-search", { query: "   ", sites: "", language: "en" }],
      ["source-search", { query: "TCP", sites: "", language: "unsupported" }],
      ["source-web-check", { urls: [] }],
      ["source-web-check", { urls: ["not-a-url"] }],
    ] as const) {
      const response = await api.inject({
        method: "POST",
        url: `/api/v1/knowledge-books/${bookId}/${route}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(search).not.toHaveBeenCalled();
  } finally {
    await api.close();
  }
});
