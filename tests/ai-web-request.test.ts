import { expect, it } from "vitest";
import {
  requestPublicHttp,
  sanitizeHttpHeaders,
} from "../apps/server/src/services/ai/web-request.js";

it("keeps only request headers that are safe to forward", () => {
  expect(
    sanitizeHttpHeaders({
      Authorization: "Bearer token",
      Host: "evil.example",
      "Content-Length": "99",
      "X-Account-Id": "acc-1",
      Cookie: "sid=1",
    }),
  ).toEqual({
    Authorization: "Bearer token",
    "X-Account-Id": "acc-1",
    Cookie: "sid=1",
  });
});

it("blocks private destinations before connecting", async () => {
  const blocked = [
    "http://127.0.0.1/admin",
    "http://10.0.0.8/status",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://2130706433/",
    "http://localhost/",
    "http://printer.local/",
  ];
  for (const url of blocked)
    await expect(requestPublicHttp({ url }), url).rejects.toThrow("内网");
});
