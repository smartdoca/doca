import { it, expect } from "vitest";
import { validateNativeRequest } from "@smartdoca/plugin-sdk/native";
const request = {
  version: 1,
  id: "one",
  pluginId: "example.mail",
  operation: "attachment.save",
  input: {
    path: "/attachments/a?download=true",
    name: "report.pdf",
    mime: "application/pdf",
  },
};
it("accepts same-plugin relative attachments and rejects namespace, traversal and redirect destinations", () => {
  expect(validateNativeRequest(request, "example.mail")).toEqual(request);
  expect(() => validateNativeRequest(request, "another.plugin")).toThrow();
  for (const path of [
    "//evil.example",
    "https://evil.example/a",
    "/../auth",
    "/a/../../auth",
    "/%2e%2e/auth",
    "/a%2fa",
    "/%252e%252e/auth",
    "/a\\b",
    "/a#b",
  ])
    expect(() =>
      validateNativeRequest(
        { ...request, input: { ...request.input, path } },
        "example.mail",
      ),
    ).toThrow();
});
it("bounds cache values and rejects filesystem names", () => {
  for (const name of ["../a", "a/b", "..", ".", "a\\b"])
    expect(() =>
      validateNativeRequest(
        { ...request, input: { ...request.input, name } },
        "example.mail",
      ),
    ).toThrow();
  expect(() =>
    validateNativeRequest(
      {
        ...request,
        operation: "storage.set",
        input: { key: "mail", value: "a".repeat(2_000_001) },
      },
      "example.mail",
    ),
  ).toThrow();
  expect(() =>
    validateNativeRequest(
      { ...request, operation: "storage.get", input: { key: "" } },
      "example.mail",
    ),
  ).toThrow();
});

it("dispatches authorized native downloads internally without following plugin redirects", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerPluginMobileSessions } =
    await import("@server/plugins/mobile-session.js");
  const app = Fastify();
  const entries = [
    { id: "example.mail.inbox", pluginId: "example.mail", mobile: true },
  ] as any;
  registerPluginMobileSessions(
    app,
    {} as any,
    () => ({ id: "user", display_name: "User", admin: 0 }),
    entries,
    false,
  );
  app.get("/api/v1/plugins/example.mail/attachment", (req) => {
    expect(req.headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
    return Buffer.from("attachment contents");
  });
  app.get("/api/v1/plugins/example.mail/redirect", (_req, reply) =>
    reply.redirect("https://evil.example"),
  );
  const download = (path: string, token = true) =>
    app.inject({
      method: "POST",
      url: "/api/v1/plugins-mobile/attachment",
      headers: token ? { authorization: `Bearer ${"a".repeat(64)}` } : {},
      payload: {
        pluginId: "example.mail",
        path,
        name: "a.txt",
        mime: "text/plain",
      },
    });
  try {
    const success = await download("/attachment");
    expect(success.statusCode).toBe(200);
    expect(Buffer.from(success.json().base64, "base64").toString()).toBe(
      "attachment contents",
    );
    expect((await download("/redirect")).statusCode).toBe(400);
    expect((await download("/../auth")).statusCode).toBe(400);
    expect((await download("/attachment", false)).statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
