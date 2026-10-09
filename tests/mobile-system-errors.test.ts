import { afterEach, expect, it, vi } from "vitest";
import { encodeSystemError } from "@doca/i18n";
import { api } from "../apps/mobile/src/api";
import { apiErrorMessage, setAPIErrorLocale, systemErrorMessage } from "../apps/mobile/src/system-errors";
import { createTranslator } from "@doca/i18n";

vi.mock("../apps/mobile/src/session", () => ({
  loadSession: async () => ({ origin: "https://mobile.invalid", token: "fixture-token" }),
  removeAccount: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  setAPIErrorLocale("zh");
});

it("uses the mobile locale for new API and streamed errors while preserving historical text", async () => {
  const message = encodeSystemError({ code: "image_edit_failed", data: { status: 422 } });
  const fetcher = vi.fn(async () => Response.json({ message }, { status: 502 }));
  vi.stubGlobal("fetch", fetcher);
  for (const locale of ["zh", "en"] as const) {
    setAPIErrorLocale(locale);
    const displayed = systemErrorMessage(message, createTranslator(locale));
    expect(apiErrorMessage(message)).toBe(displayed);
    await expect(api("/ai/sessions/fixture/messages", { body: { text: "原始输入" } })).rejects.toMatchObject({ status: 502, message: displayed });
    expect(systemErrorMessage("历史错误原文", createTranslator(locale))).toBe("历史错误原文");
  }
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
});
