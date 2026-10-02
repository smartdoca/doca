import { expect, it } from "vitest";
import type { ContentSourceDescriptor } from "@smartdoca/plugin-sdk/content";
import { contentQuerySources, searchableSources } from "../apps/web/src/features/search/content-search.js";

const mail: ContentSourceDescriptor = {
  id: "doca.mail.messages", pluginId: "doca.mail", version: 1,
  title: { zh: "邮件", en: "Mail" }, contentTypes: ["mail"],
  purposes: ["knowledge", "analysis", "search"], capabilities: { search: true },
  configSchema: { type: "object", properties: {} },
};
const calendar = { ...mail, id: "doca.calendar.events", pluginId: "doca.calendar", title: { zh: "日程", en: "Calendar" } };
const all = { compact: false, contentMode: "all" as const, selectedSourceId: null, filterCount: 0 };

it("offers registered search sources before a query, excluding unavailable capabilities", () => {
  expect(searchableSources([mail, calendar, { ...mail, id: "no-search", capabilities: { search: false } }, { ...mail, id: "knowledge-only", purposes: ["knowledge"] }])).toEqual([mail, calendar]);
});
it("searches all plugins in All and only mail when the mail tab is selected", () => {
  expect(contentQuerySources([mail, calendar], all)).toEqual([mail, calendar]);
  expect(contentQuerySources([mail, calendar], { ...all, selectedSourceId: mail.id })).toEqual([mail]);
  expect(contentQuerySources([calendar], { ...all, selectedSourceId: mail.id })).toEqual([]);
});
it("keeps document-only pickers and filters from querying plugin business content", () => {
  for (const selection of [{ ...all, compact: true }, { ...all, contentMode: "documents" as const }, { ...all, contentMode: "files" as const }, { ...all, filterCount: 1 }]) {
    expect(contentQuerySources([mail], selection)).toEqual([]);
  }
});
