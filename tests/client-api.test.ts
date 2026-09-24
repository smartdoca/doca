import { afterEach, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/shared/api.js";
afterEach(() => vi.unstubAllGlobals());
it("omits JSON content type for empty-body visit, heartbeat, logout and copy requests", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  for (const path of [
    "/me/heartbeat",
    "/resources/id/visit",
    "/resources/id/copy",
    "/auth/logout",
  ]) {
    await api(path, "POST");
    const init = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(init[1].headers).toEqual({});
    expect(init[1].body).toBeUndefined();
  }
});
it("serializes JSON when a request body is actually provided", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  await api("/me/profile", "PUT", { displayName: "小张" });
  const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(init[1].headers).toEqual({ "Content-Type": "application/json" });
  expect(init[1].body).toBe('{"displayName":"小张"}');
});
