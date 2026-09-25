import Fastify from "fastify";
import { expect, it } from "vitest";
import { createUser, type Actor } from "@core/modules/identity/passwords.js";
import { registerSearch } from "../apps/server/src/routes/search.js";
import {
  documentSearchSource,
  fileSearchSource,
  knowledgeSearchSource,
  mailSearchSource,
} from "../apps/server/src/services/search/sources.js";
import { openTestDatabase } from "./database.js";

it("keeps document, file and knowledge search active when mail is absent", async () => {
  const db = await openTestDatabase({ driver: "sqlite", path: ":memory:" });
  const actor = {
    ...(await createUser(
      db,
      {
        login: "search-sources",
        displayName: "Search Sources",
        password: "search-source-password",
      },
      { bootstrap: true },
    )),
    admin: 1,
  } as Actor;
  const app = Fastify();
  try {
    const registration = await registerSearch(app, db, () => actor, {
      allowedOrigins: ["http://127.0.0.1:7700"],
      sources: { mail: false },
    });
    const descriptors = registration.searchHost.registry
      .list()
      .map((source) => source.descriptor);
    expect(descriptors).toEqual(
      expect.arrayContaining([
        documentSearchSource,
        fileSearchSource,
        knowledgeSearchSource,
      ]),
    );
    expect(descriptors).not.toContainEqual(mailSearchSource);
  } finally {
    await app.close();
    await db.destroy();
  }
});
