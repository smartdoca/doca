import { isLocale } from "@doca/i18n";

/** Per-user page state. Mail scratches are keyed by mailbox; UI keys are shared preferences the assistant can read and update. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MailScratch = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
};

/** Floating quick-notes window. Shared by the web client and page-state writes. */
export type NotesFloatState = {
  open: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const notesFloatDefaults: NotesFloatState = {
  open: false,
  collapsed: false,
  x: 28,
  y: 76,
  width: 380,
  height: 560,
};

export type PageStateKey =
  | `mail.draft.${string}`
  | "ui.locale"
  | "ui.filesView"
  | "ui.notesFloat"
  | "ai.model";

export function mailDraftKey(mailboxId: string) {
  return `mail.draft.${mailboxId}` as const;
}

export function parsePageStateKey(key: string): PageStateKey | null {
  if (key === "ui.locale" || key === "ui.filesView" || key === "ui.notesFloat" || key === "ai.model")
    return key;
  const draft = /^mail\.draft\.([0-9a-f-]{36})$/i.exec(key);
  if (draft && UUID.test(draft[1]!)) return `mail.draft.${draft[1]}`;
  return null;
}

export function normalizePageStateValue(key: PageStateKey, value: unknown): unknown {
  if (key === "ui.locale") {
    if (!isLocale(value)) throw new Error("invalid_locale");
    return value;
  }
  if (key === "ui.filesView") {
    if (value !== "columns" && value !== "grid" && value !== "list")
      throw new Error("文件夹样式只能是分栏、图标或列表");
    return value;
  }
  if (key === "ai.model") {
    if (typeof value !== "string" || !value.trim() || value.length > 80)
      throw new Error("模型标识无效");
    return value.trim();
  }
  if (key === "ui.notesFloat") return normalizeNotesFloat(value);
  return normalizeMailScratch(value);
}

export function normalizeNotesFloat(value: unknown): NotesFloatState {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const num = (field: string, fallback: number, min: number, max: number) => {
    const raw = record[field];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    open: record.open === true,
    collapsed: record.collapsed === true,
    x: num("x", notesFloatDefaults.x, -4000, 8000),
    y: num("y", notesFloatDefaults.y, -4000, 8000),
    width: num("width", notesFloatDefaults.width, 280, 960),
    height: num("height", notesFloatDefaults.height, 320, 960),
  };
}

export function normalizeMailScratch(value: unknown): MailScratch {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (field: string, max: number) => {
    const raw = record[field];
    if (typeof raw !== "string") return "";
    return raw.slice(0, max);
  };
  return {
    to: text("to", 2000),
    cc: text("cc", 2000),
    bcc: text("bcc", 2000),
    subject: text("subject", 500),
    text: text("text", 100_000),
    html: text("html", 100_000),
  };
}

export function mailScratchEmpty(scratch: MailScratch) {
  return ![scratch.to, scratch.cc, scratch.bcc, scratch.subject, scratch.text, scratch.html]
    .some((part) => part.trim());
}
