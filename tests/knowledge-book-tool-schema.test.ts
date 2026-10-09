import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bookAssistantInputSchema,
  bookAssistantActionSchema,
} from "../apps/server/src/services/ai/knowledge-book-tool-schema.js";
it("declares actual root and nested command objects and rejects encoded strings and obsolete single-source inputs", () => {
  const schema = bookAssistantInputSchema.toJSONSchema();
  expect(schema.type).toBe("object");
  expect(schema.properties!.command).toMatchObject({ type: "object" });
  const input = {
    action: "command",
    bookId: randomUUID(),
    command: {
      operation: "source.save",
      expectedRevision: 0,
      title: "Mixed",
      status: "active",
      configuration: {
        version: 1,
        items: [
          { id: "document", kind: "document", resourceId: randomUUID() },
          { id: "url", kind: "url", url: "https://example.com" },
        ],
      },
    },
  };
  expect(bookAssistantInputSchema.safeParse(input).success).toBe(true);
  expect(bookAssistantActionSchema.safeParse(input).success).toBe(true);
  expect(
    bookAssistantInputSchema.safeParse({
      ...input,
      command: JSON.stringify(input.command),
    }).success,
  ).toBe(false);
  expect(
    bookAssistantActionSchema.safeParse({
      ...input,
      command: {
        ...input.command,
        configuration: { kind: "url", url: "https://example.com" },
      },
    }).success,
  ).toBe(false);
});
