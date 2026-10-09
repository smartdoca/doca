import { afterEach, expect, it, vi } from "vitest";
import { sendPendingItem } from "../apps/web/src/features/ai/ai-pending-runner.js";
import type { PendingSendItem } from "../apps/web/src/features/ai/ai-session-ux.js";

afterEach(() => vi.unstubAllGlobals());
it("uses the queued bubble identity for submission and for a retry after a lost response", async () => {
  const item: PendingSendItem = {
    id: crypto.randomUUID(), text: "queued message", createdAt: new Date().toISOString(),
    attachments: [], references: [], modelId: "mock", scope: "all",
  };
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 1) throw new Error("response lost");
    return Response.json({ id: body.id });
  }));
  await expect(sendPendingItem("session", item)).rejects.toThrow("response lost");
  expect(await sendPendingItem("session", item)).toBe(item.id);
  expect(requests.map(request => request.id)).toEqual([item.id, item.id]);
  expect(requests[0]).toEqual(requests[1]);
});
