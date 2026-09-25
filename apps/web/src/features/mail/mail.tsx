import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronDown,
  Forward,
  Inbox,
  Mail,
  MailWarning,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  ShieldCheck,
  SquarePen,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@web/shared/api.js";
import { mailDraftKey, type MailScratch } from "@core/modules/page-state.js";
import { clearPageState, readPageState, writePageState } from "@web/features/page-state/client.js";
import { Feedback } from "@web/shared/components/feedback.js";
import { useAI } from "@web/features/ai/ai-context.js";
import { MailPermissionPanel } from "@web/features/mail/mail-permissions.js";
import { MailHtmlView } from "@web/features/mail/mail-body.js";
import { MailRichEditor } from "@web/features/mail/mail-editor.js";
import { htmlToText, quoteOriginal } from "@web/features/mail/mail-html.js";
import {
  previewFolders,
  previewMessages,
  previewOverview,
} from "@web/features/mail/mail-preview-data.js";
import "@web/features/mail/mail.css";

type MailProvider = {
  id: string;
  label: string;
  hint: string;
  auth?: "oauth" | "password";
  oauthReady?: boolean;
  helpUrl?: string;
};
type Mailbox = {
  id: string;
  address: string;
  localPart: string;
  displayName: string;
  kind: "personal" | "shared";
  source?: "internal" | "external";
  provider?: string;
  providerLabel?: string;
  locked: boolean;
  shareable: boolean;
  deletable: boolean;
  role: "owner" | "admin" | "sender" | "reader";
  knowledgeScope?: "off" | "starred" | "all";
};
type Folder = { id: string; name: string; role: string; total: number; unread: number };

const knowledgeScopeLabel: Record<"off" | "starred" | "all", string> = {
  off: "不加入",
  starred: "星标加入",
  all: "完全加入",
};

const folderLabels: Record<string, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿箱",
  junk: "垃圾邮件",
  trash: "已删除",
  archive: "归档",
};

function folderLabel(folder: Folder) {
  return folderLabels[folder.role] || folder.name;
}

function onMailRoute(id?: string) {
  const path = location.hash.split("?")[0] ?? "";
  if (id) return path === `#/mail/${id}` || path === "#/mail";
  return path === "#/mail" || path.startsWith("#/mail/");
}

function mailSearchParams() {
  const raw = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?") + 1) : "";
  return new URLSearchParams(raw);
}

function writeMailHash(mailboxId: string, next?: { message?: string | null }) {
  const params = mailSearchParams();
  params.delete("mailBind");
  params.delete("token");
  if (next && "message" in next) {
    if (next.message) params.set("message", next.message);
    else params.delete("message");
  }
  const hash = `/mail/${mailboxId}${params.size ? `?${params}` : ""}`;
  if (location.hash !== `#${hash}` && onMailRoute(mailboxId)) location.hash = hash;
}
type Address = { name?: string; email: string };
type MailAttachment = { id: string; name: string; mime: string; size: number; fileId?: string };
type Message = {
  id: string;
  folderId: string;
  folder: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc?: Address[];
  snippet: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  receivedAt: string;
  attachments?: MailAttachment[];
  files?: Array<{ name: string; size: number }>;
};
type MessageDetail = Message & {
  text: string;
  html: string;
  attachments: MailAttachment[];
};
type ComposeDraft = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html: string;
  inReplyTo?: string;
  draftId?: string;
  attachments: Array<{ name: string; mime: string; data: string }>;
};
type Overview = {
  enabled: boolean;
  configured: boolean;
  internalConfigured?: boolean;
  mock?: boolean;
  domain: string;
  mode: "independent" | "free";
  maxMailboxes: number;
  external?: { enabled: boolean; maxAccounts: number; providers: MailProvider[] };
  mailboxes: Mailbox[];
};

const folderIcon = (role: string) =>
  role === "sent"
    ? Send
    : role === "trash"
      ? Trash2
      : role === "archive"
        ? Archive
        : role === "drafts"
          ? SquarePen
          : role === "junk"
            ? MailWarning
            : role === "starred"
              ? Star
              : Inbox;

function weekday(date: Date) {
  return `周${"日一二三四五六"[date.getDay()]}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日 ${weekday(date)} ${time}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${weekday(date)} ${time}`;
}

function formatFullTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday(date)} ${time}`;
}

function formatSize(size?: number) {
  if (!size || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function displayAddress(address?: Address) {
  return address?.name || address?.email || "未知发件人";
}

function formatPeople(list?: Address[]) {
  if (!list?.length) return "";
  return list.map((item) => (item.name && item.email ? `${item.name} <${item.email}>` : item.name || item.email)).join("、");
}

function parseAddresses(value: string): Address[] {
  return value.split(/[,;，；]/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = item.match(/^(.*)<([^>]+)>$/);
    return match
      ? {
          name: (match[1] ?? "").trim() || undefined,
          email: (match[2] ?? "").trim(),
        }
      : { email: item };
  });
}

function listPeer(item: Message, folderRole?: string) {
  if (folderRole === "sent" || folderRole === "drafts") return item.to[0] ?? item.cc[0] ?? item.from;
  return item.from;
}

function folderStats(source: Message[]) {
  return previewFolders.map((folder) => ({
    ...folder,
    total: source.filter((item) => item.folderId === folder.id).length,
    unread: source.filter((item) => item.folderId === folder.id && item.unread).length,
  }));
}

function formatExtras(item: Message, starredOnly = false) {
  const files = item.attachments ?? item.files ?? [];
  const parts = [`收件人 ${formatPeople(item.to) || "—"}`];
  if (item.cc.length) parts.push(`抄送 ${formatPeople(item.cc)}`);
  if (item.bcc?.length) parts.push(`密送 ${item.bcc.length} 人`);
  if (starredOnly && item.folder) parts.push(item.folder);
  if (files.length) parts.push(files.map((file) => `${file.name}${file.size ? ` ${formatSize(file.size)}` : ""}`).join("、"));
  return parts.join(" · ");
}

function roleLabel(role: Mailbox["role"]) {
  return role === "owner" ? "所有者" : role === "admin" ? "管理员" : role === "sender" ? "可发邮件" : "只读";
}

function mailboxOrigin(item: Mailbox) {
  if (item.source === "external") return `外部 · ${item.providerLabel || "外部邮箱"}`;
  return item.kind === "shared" ? "Doca 共享" : "Doca";
}

function initials(address?: Address) {
  const name = displayAddress(address).replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "");
  return (name.slice(0, 1) || "邮").toUpperCase();
}

function useHeaderSlot(id: string) {
  const [slot, setSlot] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.getElementById(id),
  );
  useEffect(() => { setSlot(document.getElementById(id)); }, [id]);
  return slot;
}

function MailHeaderPortal({ id, children }: { id: string; children: ReactNode }) {
  const slot = useHeaderSlot(id);
  return slot ? createPortal(children, slot) : null;
}

export function MailApp({ mailboxId, preview = false }: { mailboxId?: string; preview?: boolean }) {
  const ai = useAI();
  const joinToken = new URLSearchParams(location.hash.split("?")[1] ?? "").get("token");
  const [overview, setOverview] = useState<Overview | null>(preview ? previewOverview : null);
  const [mailbox, setMailbox] = useState<(Mailbox & { folders: Folder[] }) | null>(
    preview ? { ...previewOverview.mailboxes[0]!, folders: folderStats(previewMessages) } : null,
  );
  const [folderId, setFolderId] = useState<string>(preview ? previewFolders[0]!.id : "");
  const [catalog, setCatalog] = useState<MessageDetail[]>(preview ? previewMessages : []);
  const [messages, setMessages] = useState<Message[]>(
    preview ? previewMessages.filter((item) => item.folderId === previewFolders[0]!.id) : [],
  );
  const [selected, setSelected] = useState<MessageDetail | null>(preview ? previewMessages[0]! : null);
  const [query, setQuery] = useState("");
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyPart, setApplyPart] = useState("");
  const [bindSource, setBindSource] = useState("doca");
  const [bindAddress, setBindAddress] = useState("");
  const [bindPassword, setBindPassword] = useState("");
  const [bindName, setBindName] = useState("");
  const [bindUsername, setBindUsername] = useState("");
  const [bindImapHost, setBindImapHost] = useState("");
  const [bindImapPort, setBindImapPort] = useState("993");
  const [bindSmtpHost, setBindSmtpHost] = useState("");
  const [bindSmtpPort, setBindSmtpPort] = useState("465");
  const [shareOpen, setShareOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [loading, setLoading] = useState(!preview);
  const [listLoading, setListLoading] = useState(false);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    detail: string;
    action: () => Promise<void>;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const switchRef = useRef<HTMLDivElement>(null);
  const mailboxRef = useRef(mailbox);
  const folderRef = useRef(folderId);
  const selectedIdRef = useRef<string | null>(null);
  const openFromHash = useRef<(id: string) => void>(() => undefined);
  const readGen = useRef(0);
  const listGen = useRef(0);
  mailboxRef.current = mailbox;
  folderRef.current = folderId;
  selectedIdRef.current = selected?.id ?? null;

  function matchQuery(item: Message, keyword: string) {
    if (!keyword) return true;
    const hay = [
      item.subject,
      item.snippet,
      item.from.email,
      item.from.name,
      ...item.to.map((person) => `${person.name ?? ""} ${person.email}`),
      ...item.cc.map((person) => `${person.name ?? ""} ${person.email}`),
      ...(item.attachments ?? item.files ?? []).map((file) => file.name),
    ].join(" ").toLowerCase();
    return hay.includes(keyword);
  }

  function previewList(source: MessageDetail[], nextFolder = folderId, q = query, starred = starredOnly) {
    const keyword = q.trim().toLowerCase();
    return source.filter((item) => {
      if (starred && !item.starred) return false;
      if (!starred && nextFolder && item.folderId !== nextFolder) return false;
      return matchQuery(item, keyword);
    });
  }

  async function loadOverview() {
    const next = await api<Overview>("/mail");
    setOverview(next);
    return next;
  }

  async function openMailbox(id: string, keepFolder = folderId) {
    if (preview) {
      const item = overview?.mailboxes.find((mailboxItem) => mailboxItem.id === id) ?? previewOverview.mailboxes[0]!;
      const detail = { ...item, folders: folderStats(catalog) };
      setMailbox(detail);
      setStarredOnly(false);
      setFolderId(previewFolders[0]!.id);
      setSelected(null);
      setMessages(previewList(catalog, previewFolders[0]!.id, query, false));
      return { detail, folderId: previewFolders[0]!.id };
    }
    const detail = await api<Mailbox & { folders: Folder[] }>(`/mail/mailboxes/${id}`);
    mailboxRef.current = detail;
    setMailbox(detail);
    const nextFolder =
      detail.folders.find((item) => item.id === keepFolder)?.id ||
      detail.folders.find((item) => item.role === "inbox")?.id ||
      detail.folders[0]?.id ||
      "";
    setFolderId(nextFolder);
    writeMailHash(id);
    return { detail, folderId: nextFolder };
  }

  async function loadMessages(
    id: string,
    nextFolder = folderId,
    q = query,
    starred = starredOnly,
    silent = false,
  ) {
    if (preview) {
      setMessages(previewList(catalog, nextFolder, q, starred));
      return;
    }
    const gen = ++listGen.current;
    if (!silent) setListLoading(true);
    try {
      const params = new URLSearchParams();
      if (!starred && nextFolder) params.set("folderId", nextFolder);
      if (q.trim()) params.set("q", q.trim());
      if (starred) params.set("starred", "true");
      const page = await api<{ items: Message[] }>(`/mail/mailboxes/${id}/messages?${params}`);
      if (gen !== listGen.current) return;
      setMessages(page.items);
    } finally {
      if (!silent) setListLoading(false);
    }
  }

  async function syncMailbox(id: string, nextFolder = folderId, silent = false) {
    if (preview) return;
    if (!onMailRoute(id)) return;
    try {
      const synced = await api<Mailbox & { folders: Folder[]; syncedAt?: string | null }>(
        `/mail/mailboxes/${id}/sync${nextFolder ? `?folderId=${encodeURIComponent(nextFolder)}` : ""}`,
        "POST",
      );
      if (!onMailRoute(id)) return;
      setMailbox((old) => old && old.id === id ? { ...old, ...synced, folders: synced.folders } : old);
      await loadMessages(id, nextFolder || synced.folders.find((item) => item.role === "inbox")?.id, query, starredOnly, silent);
      return { detail: synced, folderId: nextFolder };
    } catch (error) {
      if (!silent) throw error;
    }
  }

  useEffect(() => {
    const hash = location.hash;
    const query = hash.includes("?") ? new URLSearchParams(hash.slice(hash.indexOf("?") + 1)) : null;
    if (query?.get("mailBind") === "error") {
      setError("外部邮箱授权失败或已取消，请重试。");
      history.replaceState(null, "", hash.slice(0, hash.indexOf("?")) || "#/mail");
    }
  }, []);

  useEffect(() => {
    if (preview) return;
    let active = true;
    void (async () => {
      try {
        if (joinToken) {
          const joined = await api<{ id: string }>(`/mail/share/redeem`, "POST", { token: joinToken });
          if (active && onMailRoute()) location.hash = `/mail/${joined.id}`;
        }
        const next = await loadOverview();
        if (!active || !onMailRoute(mailboxId)) return;
        setLoading(false);
        const target = mailboxId || next.mailboxes[0]?.id;
        if (!target) return;
        const opened = await openMailbox(target);
        if (!active || !onMailRoute(target)) return;
        await loadMessages(target, opened.folderId);
        const pendingMessage = mailSearchParams().get("message");
        if (active && pendingMessage && mailSearchParams().get("compose") !== "1") void openMessage(pendingMessage, opened.detail);
        if (active && onMailRoute(target)) void syncMailbox(target, opened.folderId, true);
      } catch (e) {
        if (active && onMailRoute(mailboxId)) setError(e instanceof Error ? e.message : "邮箱加载失败");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [mailboxId]);

  useEffect(() => {
    if (!switchOpen) return;
    const close = (event: PointerEvent) => {
      if (!switchRef.current?.contains(event.target as Node)) {
        setSwitchOpen(false);
        if (overview?.mailboxes.length) setApplyOpen(false);
      }
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [switchOpen, overview?.mailboxes.length]);

  const canSend =
    !!mailbox && ["owner", "admin", "sender"].includes(mailbox.role);
  const internalReady = !!(overview?.internalConfigured ?? (overview?.configured && overview.domain));
  const ownedInternal = overview?.mailboxes.filter((item) => item.source === "internal" && item.role === "owner").length ?? 0;
  const canApplyDoca = !!(
    internalReady
    && overview?.mode === "free"
    && overview.maxMailboxes > 1
    && ownedInternal < overview.maxMailboxes
  );
  const externalProviders = overview?.external?.enabled ? overview.external.providers : [];
  const canAddMailbox = canApplyDoca || externalProviders.length > 0;
  const activeBind = canApplyDoca && bindSource === "doca"
    ? "doca"
    : bindSource === "doca"
      ? (externalProviders[0]?.id || "")
      : bindSource;
  const selectedProvider = externalProviders.find((item) => item.id === activeBind);
  const currentFolder = mailbox?.folders.find((item) => item.id === folderId);

  const showBind = canAddMailbox && (applyOpen || !overview?.mailboxes.length);

  function openBind() {
    setBindSource(canApplyDoca ? "doca" : externalProviders[0]?.id || "doca");
    setApplyOpen(true);
    setSwitchOpen(true);
  }

  useEffect(() => {
    if (loading || !overview || overview.mailboxes.length || !canAddMailbox) return;
    setBindSource(canApplyDoca ? "doca" : externalProviders[0]?.id || "doca");
    setApplyOpen(true);
    setSwitchOpen(true);
  }, [loading, overview?.mailboxes.length, canAddMailbox, canApplyDoca]);

  useEffect(() => {
    if (preview || !mailbox) return;
    const id = mailbox.id;
    const interval = window.setInterval(() => {
      if (mailboxRef.current?.id !== id || document.hidden || !onMailRoute(id)) return;
      void syncMailbox(id, folderRef.current, true).catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(interval);
  }, [preview, mailbox?.id]);
  const unread = useMemo(() => mailbox?.folders.reduce((sum, item) => sum + item.unread, 0) ?? 0, [mailbox]);
  const folderUnread = starredOnly ? messages.filter((item) => item.unread).length : currentFolder?.unread ?? unread;
  const folderTotal = starredOnly ? messages.length : currentFolder?.total ?? messages.length;
  const starredCount = preview ? catalog.filter((item) => item.starred).length : starredOnly ? messages.length : 0;
  const composeBytes = compose?.attachments.reduce((sum, item) => sum + Math.round(item.data.length * 0.75), 0) ?? 0;

  const setMailFocus = ai?.setMailFocus;
  const scratchVersion = useRef(0);
  const lastScratch = useRef("");
  const scratchEpoch = useRef(0);
  const pendingSave = useRef<{ mailboxId: string; scratch: MailScratch; epoch: number } | null>(null);
  const scratchReload = useRef(false);
  const composeRef = useRef(compose);
  composeRef.current = compose;
  useEffect(() => {
    if (!setMailFocus) return;
    if (!mailbox) {
      setMailFocus(null);
      return;
    }
    setMailFocus({
      mailboxId: mailbox.id,
      mailboxAddress: mailbox.address,
      canSend,
      message: selected
        ? {
            id: selected.id,
            subject: selected.subject,
            from: selected.from.email,
            snippet: selected.snippet || selected.text?.slice(0, 180) || "",
          }
        : undefined,
    });
  }, [
    setMailFocus,
    mailbox?.id,
    mailbox?.address,
    canSend,
    selected?.id,
    selected?.subject,
    selected?.from.email,
    selected?.snippet,
    selected?.text,
  ]);

  useEffect(() => () => { setMailFocus?.(null); }, [setMailFocus]);

  useEffect(() => {
    if (preview) return;
    const apply = () => {
      const box = mailboxRef.current;
      if (!box) return;
      if (mailSearchParams().get("compose") === "1") return;
      const pending = mailSearchParams().get("message");
      if (!pending || pending === selectedIdRef.current) return;
      openFromHash.current(pending);
    };
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [preview]);

  function syncComposeHash(open: boolean) {
    if (preview) return;
    const box = mailboxRef.current;
    if (!box) return;
    const params = mailSearchParams();
    if ((params.get("compose") === "1") === open && (!open || !params.has("message"))) return;
    if (open) {
      params.set("compose", "1");
      params.delete("message");
    } else params.delete("compose");
    const next = `/mail/${box.id}${params.size ? `?${params}` : ""}`;
    if (location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);
  }

  useEffect(() => {
    if (preview || !mailbox) return;
    if (mailSearchParams().get("compose") !== "1") return;
    scratchReload.current = true;
    setCompose(null);
    setComposeOpen(true);
  }, [preview, mailbox?.id]);

  useEffect(() => {
    if (preview) return;
    const apply = () => {
      if (!mailboxRef.current || mailSearchParams().get("compose") !== "1") return;
      setComposeOpen(true);
    };
    const reload = () => {
      if (!mailboxRef.current) return;
      scratchReload.current = true;
      setCompose(null);
      setComposeOpen(true);
    };
    window.addEventListener("hashchange", apply);
    window.addEventListener("doca-mail-compose", reload);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("doca-mail-compose", reload);
    };
  }, [preview]);

  useEffect(() => {
    if (preview || !composeOpen || !mailbox) return;
    if (compose && !scratchReload.current) return;
    scratchReload.current = false;
    const mailboxId = mailbox.id;
    let active = true;
    void readPageState<MailScratch>(mailDraftKey(mailboxId)).then((item) => {
      if (!active || mailboxRef.current?.id !== mailboxId) return;
      const scratch = item?.value ?? { to: "", cc: "", bcc: "", subject: "", text: "", html: "" };
      scratchVersion.current = item?.version ?? 0;
      lastScratch.current = JSON.stringify(scratch);
      pendingSave.current = null;
      setCompose({ ...scratch, attachments: [] });
    }).catch(() => {
      if (active) setCompose({ to: "", cc: "", bcc: "", subject: "", text: "", html: "", attachments: [] });
    });
    return () => { active = false; };
  }, [preview, composeOpen, mailbox?.id, compose]);

  useEffect(() => {
    if (preview || !composeOpen || !compose || !mailbox) return;
    const scratch: MailScratch = {
      to: compose.to,
      cc: compose.cc,
      bcc: compose.bcc,
      subject: compose.subject,
      text: compose.text,
      html: compose.html,
    };
    const snapshot = JSON.stringify(scratch);
    if (snapshot === lastScratch.current) return;
    const mailboxId = mailbox.id;
    const epoch = scratchEpoch.current;
    pendingSave.current = { mailboxId, scratch, epoch };
    const timer = window.setTimeout(() => {
      lastScratch.current = snapshot;
      void writePageState(mailDraftKey(mailboxId), scratch, scratchVersion.current).then(async (item) => {
        if (epoch !== scratchEpoch.current) {
          await clearPageState(mailDraftKey(mailboxId)).catch(() => undefined);
          return;
        }
        scratchVersion.current = item?.version ?? 0;
        if (!item) lastScratch.current = JSON.stringify({ to: "", cc: "", bcc: "", subject: "", text: "", html: "" });
      }).catch(() => { lastScratch.current = ""; });
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [preview, composeOpen, compose, mailbox?.id]);

  useEffect(() => {
    if (preview) return;
    return () => {
      const pending = pendingSave.current;
      if (!pending || pending.epoch !== scratchEpoch.current) return;
      const snapshot = JSON.stringify(pending.scratch);
      if (snapshot === lastScratch.current) return;
      pendingSave.current = null;
      lastScratch.current = snapshot;
      void writePageState(mailDraftKey(pending.mailboxId), pending.scratch, scratchVersion.current).then((item) => {
        if (pending.epoch !== scratchEpoch.current) return;
        scratchVersion.current = item?.version ?? 0;
      }).catch(() => { lastScratch.current = ""; });
    };
  }, [preview, composeOpen, mailbox?.id]);

  useEffect(() => {
    if (preview || !composeOpen || !mailbox) return;
    const mailboxId = mailbox.id;
    const pull = async () => {
      const current = composeRef.current;
      if (current) {
        const scratch = JSON.stringify({
          to: current.to, cc: current.cc, bcc: current.bcc, subject: current.subject, text: current.text, html: current.html,
        });
        if (scratch !== lastScratch.current) return;
      }
      const item = await readPageState<MailScratch>(mailDraftKey(mailboxId));
      if (!item || item.version === scratchVersion.current) return;
      scratchVersion.current = item.version;
      lastScratch.current = JSON.stringify(item.value);
      setCompose((old) => ({ ...(old ?? { attachments: [] }), ...item.value, attachments: old?.attachments ?? [] }));
    };
    const timer = window.setInterval(() => { void pull().catch(() => undefined); }, 12000);
    return () => window.clearInterval(timer);
  }, [preview, composeOpen, mailbox?.id]);

  async function markFolderRead() {
    const unreadItems = messages.filter((item) => item.unread);
    if (!unreadItems.length) return;
    if (preview) {
      const ids = new Set(unreadItems.map((item) => item.id));
      const apply = <T extends Message>(item: T): T => ids.has(item.id) ? { ...item, unread: false } : item;
      const next = catalog.map(apply);
      setCatalog(next);
      setMessages((old) => old.map(apply));
      setSelected((old) => old && ids.has(old.id) ? { ...old, unread: false } : old);
      if (mailbox) setMailbox({ ...mailbox, folders: folderStats(next) });
      setNotice("已全部标为已读");
      return;
    }
    if (!mailbox) return;
    setBusy(true); setError("");
    try {
      await Promise.all(unreadItems.map((item) => api(`/mail/mailboxes/${mailbox.id}/messages/${item.id}`, "PATCH", { unread: false })));
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "标记失败"); }
    finally { setBusy(false); }
  }

  async function refresh() {
    if (!mailbox) return;
    setError("");
    try {
      await syncMailbox(mailbox.id, folderId);
    } catch (e) { setError(e instanceof Error ? e.message : "刷新失败"); }
  }

  async function openMessage(id: string, box = mailbox) {
    if (!box) return;
    selectedIdRef.current = id;
    if (preview) {
      const detail = catalog.find((item) => item.id === id);
      if (!detail) return;
      if (detail.folder === "草稿箱" || currentFolder?.role === "drafts") {
        startCompose({
          to: detail.to.map((item) => item.email).join(", "),
          cc: detail.cc.map((item) => item.email).join(", "),
          bcc: (detail.bcc ?? []).map((item) => item.email).join(", "),
          subject: detail.subject,
          text: detail.text,
          html: detail.html,
          draftId: detail.id,
          attachments: [],
        });
        return;
      }
      const next = catalog.map((item) => item.id === id ? { ...item, unread: false } : item);
      setSelected({ ...detail, unread: false });
      setCatalog(next);
      setMessages((old) => old.map((item) => item.id === id ? { ...item, unread: false } : item));
      if (mailbox) setMailbox({ ...mailbox, folders: folderStats(next) });
      setComposeOpen(false);
      syncComposeHash(false);
      return;
    }
    const gen = ++readGen.current;
    const previewItem = messages.find((item) => item.id === id);
    setComposeOpen(false);
    syncComposeHash(false);
    setReadingId(id);
    setError("");
    writeMailHash(box.id, { message: id });
    if (previewItem) {
      setSelected({
        ...previewItem,
        text: "",
        html: "",
        attachments: previewItem.attachments ?? [],
      });
      setMessages((old) => old.map((item) => item.id === id ? { ...item, unread: false } : item));
    }
    try {
      const detail = await api<MessageDetail>(`/mail/mailboxes/${box.id}/messages/${id}`);
      if (gen !== readGen.current) return;
      if (detail.folder === "草稿箱" || currentFolder?.role === "drafts") {
        setReadingId(null);
        setCompose({
          to: detail.to.map((item) => item.email).join(", "),
          cc: detail.cc.map((item) => item.email).join(", "),
          bcc: (detail.bcc ?? []).map((item) => item.email).join(", "),
          subject: detail.subject,
          text: detail.text,
          html: detail.html,
          draftId: detail.id,
          attachments: [],
        });
        return;
      }
      setSelected(detail);
      setMessages((old) => old.map((item) => item.id === id ? { ...item, unread: false } : item));
      if (detail.folderId && detail.folderId !== folderRef.current && !starredOnly) {
        setFolderId(detail.folderId);
        void loadMessages(box.id, detail.folderId, query, false, true);
      }
    } catch (e) {
      if (gen !== readGen.current) return;
      setError(e instanceof Error ? e.message : "邮件加载失败");
    } finally {
      if (gen === readGen.current) setReadingId(null);
    }
  }
  openFromHash.current = (id) => {
    const box = mailboxRef.current;
    if (box) void openMessage(id, box);
  };

  function startCompose(partial: Partial<ComposeDraft> = {}) {
    setCompose({ to: "", cc: "", bcc: "", subject: "", text: "", html: "", attachments: [], ...partial });
    setComposeOpen(true);
  }

  function closeCompose() {
    setCompose(null);
    setComposeOpen(false);
    syncComposeHash(false);
  }

  function openComposeTab() {
    setComposeOpen(true);
    syncComposeHash(true);
    if (!compose && preview) startCompose();
  }

  async function patchMessage(id: string, body: Record<string, unknown>) {
    if (!mailbox) return;
    if (preview) {
      const moved = typeof body.folderId === "string" && body.folderId !== folderId;
      const apply = <T extends Message>(item: T): T => item.id === id ? { ...item, ...body } as T : item;
      const next = catalog.map(apply);
      setCatalog(next);
      setMessages(previewList(next, folderId, query, starredOnly).filter((item) => !moved || item.id !== id));
      setSelected((old) => {
        if (!old || old.id !== id) return old;
        if (moved) return null;
        return { ...old, ...body } as MessageDetail;
      });
      if (mailbox) setMailbox({ ...mailbox, folders: folderStats(next) });
      if (moved) {
        const target = mailbox?.folders.find((item) => item.id === body.folderId) ?? previewFolders.find((item) => item.id === body.folderId);
        if (target) setNotice(`已移到${target.name}`);
      }
      return;
    }
    const previous = {
      messages: messages.map((item) => ({ ...item })),
      selected: selected ? { ...selected } : null,
    };
    const moved = typeof body.folderId === "string" && body.folderId !== folderId;
    const apply = <T extends Message>(item: T): T => item.id === id ? { ...item, ...body } as T : item;
    setMessages((old) => old.map(apply).filter((item) => !moved || item.id !== id));
    setSelected((old) => {
      if (!old || old.id !== id) return old;
      if (moved) return null;
      return { ...old, ...body } as MessageDetail;
    });
    try {
      await api(`/mail/mailboxes/${mailbox.id}/messages/${id}`, "PATCH", body);
      if (moved) {
        const target = mailbox.folders.find((item) => item.id === body.folderId);
        if (target) setNotice(`已移到${folderLabel(target)}`);
      }
    } catch (e) {
      setMessages(previous.messages);
      setSelected(previous.selected);
      setError(e instanceof Error ? e.message : "操作失败");
    }
  }

  function toggleSelected(id: string, event?: { stopPropagation(): void }) {
    event?.stopPropagation();
    setSelectedIds((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id]);
  }

  async function deleteMessages(ids: string[]) {
    if (!mailbox || !ids.length) return;
    if (preview) {
      const drop = new Set(ids);
      const next = catalog.filter((item) => !drop.has(item.id));
      setCatalog(next);
      setMessages(next.filter((item) => starredOnly ? item.starred : item.folderId === folderId));
      if (mailbox) setMailbox({ ...mailbox, folders: folderStats(next) });
      if (selected && drop.has(selected.id)) setSelected(null);
      setSelectedIds([]);
      setNotice(ids.length > 1 ? `已删除 ${ids.length} 封（演示）` : "已删除（演示）");
      return;
    }
    setBusy(true); setError("");
    try {
      const result = await api<{ deleted: number; failed: string[] }>(
        `/mail/mailboxes/${mailbox.id}/messages/batch-delete`,
        "POST",
        { ids },
      );
      const drop = new Set(ids.filter((id) => !result.failed.includes(id)));
      setMessages((old) => old.filter((item) => !drop.has(item.id)));
      if (selected && drop.has(selected.id)) setSelected(null);
      setSelectedIds((old) => old.filter((id) => !drop.has(id)));
      setNotice(result.failed.length ? `已删除 ${result.deleted} 封，${result.failed.length} 封失败` : ids.length > 1 ? `已删除 ${result.deleted} 封` : "已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  function askDelete(ids: string[], label?: string) {
    if (!ids.length) return;
    const many = ids.length > 1;
    setConfirm({
      title: many ? `删除这 ${ids.length} 封邮件？` : "删除这封邮件？",
      detail: many
        ? "删除后会从邮箱和 Doca 中移除，第三方邮箱会尽量移到已删除。"
        : `确定删除「${label || "这封邮件"}」？删除后会从邮箱和 Doca 中移除。`,
      action: async () => {
        setConfirm(null);
        await deleteMessages(ids);
      },
    });
  }

  async function sendMail(draft = false) {
    if (!mailbox || !compose) return;
    if (preview) {
      const role = draft ? "drafts" : "sent";
      const folder = mailbox.folders.find((item) => item.role === role) ?? mailbox.folders[0]!;
      const created: MessageDetail = {
        id: compose.draftId ?? `local-${Date.now()}`,
        folderId: folder.id,
        folder: folder.name,
        subject: compose.subject,
        from: { name: mailbox.displayName, email: mailbox.address },
        to: parseAddresses(compose.to),
        cc: parseAddresses(compose.cc),
        bcc: parseAddresses(compose.bcc),
        snippet: (compose.text || htmlToText(compose.html)).replace(/\s+/g, " ").trim().slice(0, 120) || "（无正文）",
        unread: false,
        starred: false,
        hasAttachments: compose.attachments.length > 0,
        receivedAt: new Date().toISOString(),
        text: compose.text || htmlToText(compose.html),
        html: compose.html,
        attachments: compose.attachments.map((item, index) => ({
          id: `local-a-${index}`,
          name: item.name,
          mime: item.mime,
          size: Math.round(item.data.length * 0.75),
        })),
      };
      const next = compose.draftId
        ? catalog.map((item) => item.id === compose.draftId ? created : item)
        : [created, ...catalog.filter((item) => item.id !== created.id)];
      setCatalog(next);
      setMailbox({ ...mailbox, folders: folderStats(next) });
      closeCompose();
      setNotice(draft ? "草稿已保存（演示）" : "邮件已发送（演示）");
      setMessages(previewList(next, folderId, query, starredOnly));
      if (!starredOnly && folderId === folder.id) setSelected(created);
      return;
    }
    setBusy(true); setError("");
    try {
      const sent = await api<MessageDetail & { receipt?: MessageDetail }>(`/mail/mailboxes/${mailbox.id}/messages`, "POST", {
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        text: compose.text || htmlToText(compose.html),
        html: compose.html,
        inReplyTo: compose.inReplyTo,
        draftId: compose.draftId,
        attachments: compose.attachments,
        draft,
      });
      if (!draft) {
        scratchEpoch.current += 1;
        lastScratch.current = JSON.stringify({ to: "", cc: "", bcc: "", subject: "", text: "", html: "" });
        scratchVersion.current = 0;
        await clearPageState(mailDraftKey(mailbox.id)).catch(() => undefined);
      }
      closeCompose();
      setNotice(draft ? "草稿已保存" : "邮件已发送，回执在收件箱");
      if (!draft && sent.receipt) await revealReceipt(sent.receipt);
      else await refresh();
    } catch (e) {
      const receipt = e && typeof e === "object" && "payload" in e
        ? (e as { payload?: { receipt?: MessageDetail } }).payload?.receipt
        : undefined;
      setError(e instanceof Error ? e.message : "发送失败");
      if (receipt) {
        closeCompose();
        await revealReceipt(receipt);
      }
    }
    finally { setBusy(false); }
  }

  async function revealReceipt(receipt: MessageDetail) {
    setStarredOnly(false);
    setFolderId(receipt.folderId);
    setSelected(receipt);
    setMessages((old) => old.some((item) => item.id === receipt.id) ? old : [receipt, ...old]);
    if (mailbox) await loadMessages(mailbox.id, receipt.folderId, "", false);
  }

  async function applyMailbox() {
    setBusy(true); setError("");
    try {
      if (selectedProvider?.auth === "oauth") {
        const started = await api<{ url: string }>(`/mail/oauth/${activeBind}`, "POST", {
          displayName: bindName || undefined,
        });
        location.assign(started.url);
        return;
      }
      const created = activeBind === "doca"
        ? await api<Mailbox>("/mail/mailboxes", "POST", { localPart: applyPart, displayName: bindName || undefined })
        : await api<Mailbox>("/mail/external", "POST", {
            provider: activeBind,
            address: bindAddress,
            password: bindPassword,
            displayName: bindName || undefined,
            username: bindUsername || undefined,
            ...(activeBind === "custom" ? {
              imapHost: bindImapHost,
              imapPort: Number(bindImapPort) || 993,
              imapSecure: true,
              smtpHost: bindSmtpHost,
              smtpPort: Number(bindSmtpPort) || 465,
              smtpSecure: Number(bindSmtpPort) !== 587,
            } : {}),
          });
      setApplyOpen(false);
      setSwitchOpen(false);
      setApplyPart("");
      setBindAddress("");
      setBindPassword("");
      setBindName("");
      setBindUsername("");
      await loadOverview();
      const opened = await openMailbox(created.id);
      await loadMessages(created.id, opened.folderId);
      void syncMailbox(created.id, opened.folderId, true);
    } catch (e) { setError(e instanceof Error ? e.message : "添加失败"); }
    finally { setBusy(false); }
  }

  async function setKnowledgeScope(scope: "off" | "starred" | "all") {
    if (!mailbox || mailbox.knowledgeScope === scope) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api<Mailbox>(`/mail/mailboxes/${mailbox.id}`, "PATCH", { knowledgeScope: scope });
      setMailbox((current) => current ? { ...current, knowledgeScope: updated.knowledgeScope ?? scope } : current);
      setOverview((current) => current ? {
        ...current,
        mailboxes: current.mailboxes.map((item) => item.id === mailbox.id ? { ...item, knowledgeScope: updated.knowledgeScope ?? scope } : item),
      } : current);
      setNotice(scope === "off"
        ? "这只邮箱已退出搜索库。"
        : scope === "all"
          ? "这只邮箱的全部邮件会进入搜索库，并由 AI 打标。"
          : "这只邮箱里打过星的邮件会进入搜索库，并由 AI 打标。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "搜索范围没有保存");
    } finally {
      setBusy(false);
    }
  }

  async function removeMailbox() {
    if (!mailbox?.deletable) return;
    setBusy(true); setError("");
    try {
      await api(`/mail/mailboxes/${mailbox.id}`, "DELETE");
      setMailbox(null);
      setSelected(null);
      const next = await loadOverview();
      const target = next.mailboxes[0]?.id;
      if (target) {
        const opened = await openMailbox(target);
        await loadMessages(target, opened.folderId);
      } else location.hash = "/mail";
    } catch (e) { setError(e instanceof Error ? e.message : mailbox?.source === "external" ? "解绑失败" : "删除失败"); }
    finally { setBusy(false); }
  }

  async function downloadAttachment(attachment: MessageDetail["attachments"][number]) {
    if (!mailbox || !selected) return;
    const response = await fetch(`/api/v1/mail/mailboxes/${mailbox.id}/messages/${selected.id}/attachments/${attachment.id}`, { credentials: "include" });
    if (!response.ok) throw new Error("附件下载失败");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function addComposeFiles(files: FileList | null) {
    if (!files || !compose) return;
    const next = [...compose.attachments];
    for (const file of Array.from(files)) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, mime: file.type || "application/octet-stream", data });
    }
    setCompose({ ...compose, attachments: next });
  }

  if (loading && !overview) return <section className="mail-app"><p className="empty">正在打开邮箱…</p></section>;
  if (!overview?.configured)
    return <section className="mail-app mail-empty-state"><Mail size={36} /><strong>邮箱系统尚未启用</strong><span>管理员需要先启用内部邮箱，或开放外部邮箱绑定。</span></section>;

  return (
    <section className="mail-app">
      {(error || notice) && <div className="mail-toasts">
        {error && <Feedback tone="error" message={error} />}
        {notice && <Feedback tone="success" message={notice} />}
      </div>}
      <aside className="mail-nav">
        {overview.mock && <p className="mail-mock-hint">本地演示数据，尚未连接内部邮件服务</p>}
        {canSend && (
          <button type="button" className="primary mail-compose-button" aria-pressed={composeOpen} onClick={openComposeTab}>
            <SquarePen size={16} />写邮件
          </button>
        )}
        {mailbox && <nav className="mail-folders">
          {mailbox.folders.map((folder) => {
            const Icon = folderIcon(folder.role);
            return <button key={folder.id} className={!composeOpen && !starredOnly && folderId === folder.id ? "active" : ""} onClick={() => { setComposeOpen(false); syncComposeHash(false); setStarredOnly(false); setFolderId(folder.id); setSelected(null); setSelectedIds([]); void loadMessages(mailbox.id, folder.id, query, false); }}>
              <Icon size={16} />
              <span>{folderLabel(folder)}</span>
              <small>{folder.total}</small>
              <em className={folder.unread ? "" : "is-empty"}>{folder.unread || ""}</em>
            </button>;
          })}
          <button className={!composeOpen && starredOnly ? "active" : ""} onClick={() => { setComposeOpen(false); syncComposeHash(false); setStarredOnly(true); setSelected(null); setSelectedIds([]); void loadMessages(mailbox.id, folderId, query, true); }}>
            <Star size={16} />
            <span>星标邮件</span>
            <small>{starredCount || ""}</small>
            <em className="is-empty" />
          </button>
        </nav>}
      </aside>
      <MailHeaderPortal id="mail-header-mailbox">
        <div className="mail-mailbox-switch" ref={switchRef}>
          <button type="button" className="mail-mailbox-current" aria-expanded={switchOpen} onClick={() => setSwitchOpen((open) => !open)}>
            <span>{mailbox?.address || (canAddMailbox ? "绑定邮箱" : "选择邮箱")}</span>
            {mailbox?.source === "external" && <i className="mail-provider-tag">{mailbox.providerLabel || "外部"}</i>}
            {mailbox && <i className="mail-scope-tag">{knowledgeScopeLabel[mailbox.knowledgeScope ?? "starred"]}</i>}
            <ChevronDown size={14} />
          </button>
          {switchOpen && <div className={`mail-mailbox-menu${showBind ? " is-bind" : ""}`} role="listbox">
            {overview.mailboxes.map((item) => (
              <button
                key={item.id}
                role="option"
                aria-selected={mailbox?.id === item.id}
                className={mailbox?.id === item.id ? "active" : ""}
                onClick={() => {
                  closeCompose();
                  setSwitchOpen(false);
                  setApplyOpen(false);
                  void openMailbox(item.id).then((opened) => loadMessages(item.id, opened.folderId));
                }}
              >
                <Mail size={16} />
                <span>
                  <strong>{item.displayName}<i>{mailboxOrigin(item)} · {roleLabel(item.role)}</i></strong>
                  <small>{item.address}</small>
                </span>
                <em className={mailbox?.id === item.id && unread ? "" : "is-empty"}>{mailbox?.id === item.id && unread ? unread : ""}</em>
              </button>
            ))}
            {!overview.mailboxes.length && !canAddMailbox && (
              <p className="empty">{internalReady ? "正在准备你的独立邮箱…" : "管理员尚未开放邮箱绑定。"}</p>
            )}
            {canAddMailbox && !showBind && (
              <button type="button" className="mail-mailbox-apply" onClick={openBind}>
                <Plus size={15} />{canApplyDoca && !externalProviders.length ? "申请邮箱" : "添加邮箱"}
              </button>
            )}
            {showBind && (
              <form className="mail-bind-panel" onSubmit={(event) => { event.preventDefault(); void applyMailbox(); }}>
                <strong>{activeBind === "doca" ? "申请邮箱" : overview.mailboxes.length ? "添加邮箱" : "绑定邮箱"}</strong>
                <p>
                  {canApplyDoca && externalProviders.length
                    ? "选择邮件名申请 Doca 内部邮箱，或绑定一家外部邮箱。邮件名不能与已有邮箱重复。"
                    : canApplyDoca
                      ? `选择邮件名，申请一个 ${overview.domain} 邮箱。已占用的名称不能重复。还可申请 ${overview.maxMailboxes - ownedInternal} 个。`
                      : "Gmail 和 Outlook 使用官方账号授权，其他邮箱填写授权码或应用专用密码。"}
                </p>
                {(canApplyDoca || externalProviders.length > 1) && (
                  <div className="mail-bind-sources" role="radiogroup" aria-label="邮箱来源">
                    {canApplyDoca && (
                      <button type="button" className={activeBind === "doca" ? "active" : ""} onClick={() => setBindSource("doca")}>
                        <strong>Doca</strong>
                        <small>内部邮箱</small>
                      </button>
                    )}
                    {externalProviders.map((item) => (
                      <button key={item.id} type="button" className={activeBind === item.id ? "active" : ""} onClick={() => setBindSource(item.id)}>
                        <strong>{item.label}</strong>
                        <small>{item.auth === "oauth" ? "官方授权" : "授权码"}</small>
                      </button>
                    ))}
                  </div>
                )}
                {activeBind === "doca" ? (
                  <>
                    <label><span>邮件名</span><input value={applyPart} onChange={(event) => setApplyPart(event.target.value)} autoFocus placeholder={`邮件名@${overview.domain}`} /></label>
                    <label><span>显示名称</span><input value={bindName} onChange={(event) => setBindName(event.target.value)} placeholder="可选" /></label>
                  </>
                ) : (
                  <>
                    {selectedProvider?.hint && <p>{selectedProvider.hint}</p>}
                    {selectedProvider?.auth === "oauth" ? (
                      <>
                        {!selectedProvider.oauthReady && (
                          <p>管理员还没配置 {selectedProvider.label} 的 OAuth 客户端，暂时不能绑定。</p>
                        )}
                        <label><span>显示名称</span><input value={bindName} onChange={(event) => setBindName(event.target.value)} placeholder="可选" /></label>
                      </>
                    ) : (
                      <>
                        <label><span>邮箱地址</span><input value={bindAddress} onChange={(event) => setBindAddress(event.target.value)} autoFocus placeholder="name@example.com" autoComplete="username" /></label>
                        <label><span>授权码 / 应用专用密码</span><input type="password" value={bindPassword} onChange={(event) => setBindPassword(event.target.value)} autoComplete="current-password" /></label>
                        <label><span>显示名称</span><input value={bindName} onChange={(event) => setBindName(event.target.value)} placeholder="可选" /></label>
                        {(activeBind === "custom" || activeBind === "icloud") && (
                          <label><span>登录用户名</span><input value={bindUsername} onChange={(event) => setBindUsername(event.target.value)} placeholder={activeBind === "icloud" ? "默认完整邮箱；连不上可只填 @ 前缀" : "默认与邮箱地址相同"} /></label>
                        )}
                        {activeBind === "custom" && (
                          <>
                            <label><span>IMAP 主机</span><input value={bindImapHost} onChange={(event) => setBindImapHost(event.target.value)} placeholder="imap.example.com" /></label>
                            <label><span>IMAP 端口</span><input value={bindImapPort} onChange={(event) => setBindImapPort(event.target.value)} /></label>
                            <label><span>SMTP 主机</span><input value={bindSmtpHost} onChange={(event) => setBindSmtpHost(event.target.value)} placeholder="smtp.example.com" /></label>
                            <label><span>SMTP 端口</span><input value={bindSmtpPort} onChange={(event) => setBindSmtpPort(event.target.value)} /></label>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
                <footer>
                  {!!overview.mailboxes.length && <button type="button" onClick={() => setApplyOpen(false)}>取消</button>}
                  <button className="primary" disabled={busy || (activeBind === "doca" ? !applyPart.trim() : selectedProvider?.auth === "oauth" ? !selectedProvider.oauthReady : !bindAddress.trim() || !bindPassword.trim())}>
                    {activeBind === "doca" ? "申请" : selectedProvider?.auth === "oauth" ? `使用 ${selectedProvider.label} 授权` : "绑定"}
                  </button>
                </footer>
              </form>
            )}
            {mailbox && !showBind && (mailbox.role === "owner" || mailbox.role === "admin") && (
              <fieldset className="mail-knowledge-scope">
                <legend>AI 搜索</legend>
                <p>加入后，这只邮箱会进入搜索库，并由 AI 打标。默认是星标加入，只处理打过星的邮件。</p>
                <div role="radiogroup" aria-label="这只邮箱如何进入 AI 搜索">
                  {(["off", "starred", "all"] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      role="radio"
                      aria-checked={(mailbox.knowledgeScope ?? "starred") === scope}
                      className={(mailbox.knowledgeScope ?? "starred") === scope ? "active" : ""}
                      disabled={busy}
                      onClick={() => void setKnowledgeScope(scope)}
                    >{knowledgeScopeLabel[scope]}</button>
                  ))}
                </div>
              </fieldset>
            )}
            {mailbox && (mailbox.role === "owner" || mailbox.role === "admin") && (
              <button type="button" onClick={() => { setSwitchOpen(false); window.dispatchEvent(new CustomEvent("doca-subscribe-library", { detail: { kind: "mailbox", id: mailbox.id, title: mailbox.displayName || mailbox.address } })); }}>收入知识库</button>
            )}
            {mailbox?.shareable && <button type="button" data-permissions-trigger onClick={() => { setSwitchOpen(false); setShareOpen(true); }}><ShieldCheck size={15} />分享</button>}
            {mailbox?.deletable && <button type="button" disabled={busy} onClick={() => { setSwitchOpen(false); void removeMailbox(); }}><Trash2 size={15} />{mailbox.source === "external" ? "解绑邮箱" : "删除邮箱"}</button>}
          </div>}
        </div>
        {mailbox && (
          <span className="mail-header-folder">
            {composeOpen ? "写邮件" : starredOnly ? "星标邮件" : (currentFolder ? folderLabel(currentFolder) : "收件箱")}
            {!composeOpen && ` · ${folderTotal} 封`}
            {!composeOpen && folderUnread ? ` · ${folderUnread} 未读` : ""}
          </span>
        )}
      </MailHeaderPortal>
      <MailHeaderPortal id="mail-header-actions">
        {!composeOpen && (
          <button
            type="button"
            className={`secondary${selecting ? " active" : ""}`}
            onClick={() => {
              setSelecting((open) => {
                if (open) setSelectedIds([]);
                return !open;
              });
            }}
          >{selecting ? "取消批量" : "批量操作"}</button>
        )}
        {!composeOpen && selecting && selectedIds.length > 0 && canSend && (
          <button className="secondary" disabled={busy} onClick={() => askDelete(selectedIds)}>
            删除选中 · {selectedIds.length}
          </button>
        )}
        {!composeOpen && folderUnread > 0 && <button className="secondary" disabled={busy} onClick={() => void markFolderRead()}>全部已读</button>}
        {!composeOpen && <label className="mail-search">
          <Search size={15} />
          <input ref={searchRef} value={query} placeholder="搜索主题、发件人或正文" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && mailbox) void loadMessages(mailbox.id, folderId, query); }} />
        </label>}
        {!composeOpen && <button className="icon" onClick={() => void refresh()} aria-label="刷新" disabled={listLoading}>
          <RefreshCw size={16} className={listLoading ? "mail-spin" : undefined} />
        </button>}
      </MailHeaderPortal>
      <div className="mail-main">
        <div className={`mail-workspace${composeOpen ? " is-compose" : ""}`}>
          {!composeOpen && <div className={`mail-list${listLoading ? " is-loading" : ""}${selecting ? " is-selecting" : ""}`}>
            {listLoading && <div className="mail-sync-bar" aria-hidden="true" />}
            {!messages.length && <div className="mail-empty">
              {listLoading ? <RefreshCw size={28} className="mail-spin" /> : <Inbox size={28} />}
              <strong>{listLoading ? "正在同步邮件" : "没有邮件"}</strong>
              <span>{listLoading ? "刚绑定的邮箱可能需要几秒才能拉到列表。" : "这个文件夹是空的。"}</span>
            </div>}
            {messages.map((item) => {
              const peer = listPeer(item, starredOnly ? "starred" : currentFolder?.role);
              return (
              <button key={item.id} className={`mail-list-item ${selected?.id === item.id ? "active" : ""} ${item.unread ? "unread" : ""} ${readingId === item.id ? "is-reading" : ""} ${selectedIds.includes(item.id) ? "is-checked" : ""}`} onClick={() => { if (selecting) toggleSelected(item.id); else void openMessage(item.id); }}>
                <span className="mail-list-check" onClick={(event) => toggleSelected(item.id, event)}>
                  <input type="checkbox" checked={selectedIds.includes(item.id)} readOnly tabIndex={-1} aria-label="选择邮件" />
                </span>
                <span className="mail-list-star" onClick={(event) => { event.stopPropagation(); void patchMessage(item.id, { starred: !item.starred }); }}><Star size={14} fill={item.starred ? "currentColor" : "none"} /></span>
                <span className="mail-list-avatar" aria-hidden="true">{initials(peer)}</span>
                <span className="mail-list-copy">
                  <span className="mail-list-line">
                    <i className={`mail-unread-dot${item.unread ? " is-on" : ""}`} />
                    <strong className="mail-list-from">{displayAddress(peer)}</strong>
                    <em className="mail-list-email">{peer.email}</em>
                    <time>{formatTime(item.receivedAt)}</time>
                  </span>
                  <span className="mail-list-line mail-list-subject-line">
                    <span className="mail-list-subject-wrap">
                      <span className="mail-list-subject">{item.subject || "（无主题）"}</span>
                      {canSend && (
                        <span className="mail-list-quick">
                          <span
                            role="button"
                            tabIndex={0}
                            className="mail-list-quick-btn is-delete"
                            aria-label="删除"
                            onClick={(event) => { event.stopPropagation(); askDelete([item.id], item.subject || "（无主题）"); }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              event.stopPropagation();
                              askDelete([item.id], item.subject || "（无主题）");
                            }}
                          >
                            <Trash2 size={14} />
                          </span>
                        </span>
                      )}
                    </span>
                    {item.hasAttachments && <Paperclip size={13} />}
                  </span>
                  <span className="mail-list-snippet">{item.snippet}</span>
                  <span className="mail-list-extra">{formatExtras(item, starredOnly)}</span>
                </span>
              </button>
              );
            })}
          </div>}
          <article className={`mail-reader${composeOpen ? " is-compose" : ""}`}>
            {composeOpen && compose ? (
              <form className="mail-compose mail-compose-pane" onSubmit={(event) => { event.preventDefault(); void sendMail(false); }}>
                <header>
                  <strong>写邮件</strong>
                  {mailbox && <span className="mail-compose-account">{mailbox.displayName} · {mailbox.address}</span>}
                  <button type="button" className="icon" onClick={closeCompose} aria-label="关闭写邮件"><X size={16} /></button>
                </header>
                {mailbox && <label><span>发件人</span><input value={`${mailbox.displayName} <${mailbox.address}>`} readOnly /></label>}
                <label><span>收件人</span><input value={compose.to} onChange={(event) => setCompose({ ...compose, to: event.target.value })} required placeholder="user@example.com" /></label>
                <label><span>抄送</span><input value={compose.cc} onChange={(event) => setCompose({ ...compose, cc: event.target.value })} /></label>
                <label><span>密送</span><input value={compose.bcc} onChange={(event) => setCompose({ ...compose, bcc: event.target.value })} /></label>
                <label><span>主题</span><input value={compose.subject} onChange={(event) => setCompose({ ...compose, subject: event.target.value })} /></label>
                <MailRichEditor
                  html={compose.html}
                  text={compose.text}
                  resetKey={compose.draftId || compose.inReplyTo || "new"}
                  onChange={(html, text) => setCompose((old) => old ? { ...old, html, text } : old)}
                />
                <label className="mail-compose-files">
                  <span>附件</span>
                  <div className="mail-compose-attach">
                    <input ref={attachRef} type="file" multiple hidden onChange={(event) => { void addComposeFiles(event.target.files); event.target.value = ""; }} />
                    <button type="button" className="secondary" onClick={() => attachRef.current?.click()}><Paperclip size={14} />添加附件</button>
                    {!!compose.attachments.length && <small>{compose.attachments.length} 个 · {formatSize(composeBytes)}</small>}
                    {!!compose.attachments.length && <ul>{compose.attachments.map((item, index) => <li key={`${item.name}-${index}`}><Paperclip size={13} />{item.name}<button type="button" onClick={() => setCompose({ ...compose, attachments: compose.attachments.filter((_, i) => i !== index) })}><X size={12} /></button></li>)}</ul>}
                  </div>
                </label>
                <footer>
                  <button className="primary" disabled={busy || !compose.to.trim()}><Send size={15} />{busy ? "发送中…" : "发送"}</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void sendMail(true)}>存草稿</button>
                </footer>
              </form>
            ) : composeOpen ? <div className="mail-empty"><SquarePen size={28} /><strong>正在打开写邮件</strong><span>正在读取未发送的内容。</span></div>
            : !mailbox ? <div className="mail-empty"><Mail size={28} /><strong>{canAddMailbox ? "先绑定一个邮箱" : "还没有邮箱"}</strong><span>{canAddMailbox ? "打开顶部邮箱下拉框，选择申请 Doca 或绑定外部邮箱。" : "管理员尚未开放邮箱。"}</span></div>
            : !selected ? <div className="mail-empty"><Mail size={28} /><strong>选择一封邮件</strong><span>从左侧列表打开邮件正文，或点击写邮件。</span></div>
            : readingId === selected.id && !selected.html && !selected.text ? <>
              <header>
                <div className="mail-reader-title">
                  <h2>{selected.subject || "（无主题）"}</h2>
                </div>
                <div className="mail-reader-from">
                  <span className="mail-list-avatar" aria-hidden="true">{initials(selected.from)}</span>
                  <dl>
                    <div><dt>发件人</dt><dd><strong>{displayAddress(selected.from)}</strong> {selected.from.email}</dd></div>
                    <div><dt>时间</dt><dd>{formatFullTime(selected.receivedAt)}</dd></div>
                  </dl>
                </div>
              </header>
              <div className="mail-reader-loading">
                <RefreshCw size={22} className="mail-spin" />
                <strong>正在加载正文</strong>
                <span>正在从邮箱服务器拉取这封邮件…</span>
              </div>
            </> : <>
              <header>
                <div className="mail-reader-title">
                  <h2>{selected.subject || "（无主题）"}</h2>
                  <div className="mail-reader-actions">
                    <button onClick={() => window.dispatchEvent(new CustomEvent("doca-subscribe-library", { detail: { kind: "mail", id: selected.id, title: selected.subject || "（无主题）" } }))}><Search size={15} />收入知识库</button>
                    {canSend && <button onClick={() => startCompose({ to: selected.from.email, subject: selected.subject.startsWith("Re:") ? selected.subject : `Re: ${selected.subject}`, html: quoteOriginal(selected), text: htmlToText(quoteOriginal(selected)), inReplyTo: selected.id })}><Reply size={15} />回复</button>}
                    {canSend && <button onClick={() => startCompose({ to: [selected.from, ...selected.to].map((item) => item.email).join(", "), cc: selected.cc.map((item) => item.email).join(", "), subject: selected.subject.startsWith("Re:") ? selected.subject : `Re: ${selected.subject}`, html: quoteOriginal(selected), text: htmlToText(quoteOriginal(selected)), inReplyTo: selected.id })}><ReplyAll size={15} />全部回复</button>}
                    {canSend && <button onClick={() => startCompose({ subject: selected.subject.startsWith("Fwd:") ? selected.subject : `Fwd: ${selected.subject}`, html: quoteOriginal(selected), text: htmlToText(quoteOriginal(selected)) })}><Forward size={15} />转发</button>}
                    <button onClick={() => void patchMessage(selected.id, { unread: true })}><MailOpen size={15} />标为未读</button>
                    {canSend && mailbox?.folders.some((item) => item.role === "archive") && <button onClick={() => void patchMessage(selected.id, { folderId: mailbox.folders.find((item) => item.role === "archive")!.id })}><Archive size={15} />归档</button>}
                    {canSend && <button onClick={() => askDelete([selected.id], selected.subject || "（无主题）")}><Trash2 size={15} />删除</button>}
                  </div>
                </div>
                <div className="mail-reader-from">
                  <span className="mail-list-avatar" aria-hidden="true">{initials(selected.from)}</span>
                  <dl>
                    <div><dt>发件人</dt><dd><strong>{displayAddress(selected.from)}</strong> {selected.from.email}</dd></div>
                    <div><dt>收件人</dt><dd>{formatPeople(selected.to) || "—"}</dd></div>
                    {!!selected.cc.length && <div><dt>抄送</dt><dd>{formatPeople(selected.cc)}</dd></div>}
                    {!!selected.bcc?.length && <div><dt>密送</dt><dd>{formatPeople(selected.bcc)}</dd></div>}
                    <div><dt>时间</dt><dd>{formatFullTime(selected.receivedAt)}</dd></div>
                    <div><dt>位置</dt><dd>{selected.folder}{selected.starred ? " · 已星标" : ""}{selected.unread ? " · 未读" : " · 已读"}{selected.attachments?.length ? ` · ${selected.attachments.length} 个附件` : ""}</dd></div>
                  </dl>
                </div>
              </header>
              <MailHtmlView html={selected.html} text={selected.text || selected.snippet} />
              {!!selected.attachments.length && <ul className="mail-attachments">{selected.attachments.map((item) => <li key={item.id}><button type="button" onClick={() => void downloadAttachment(item).catch((e) => setError(e instanceof Error ? e.message : "附件下载失败"))}><Paperclip size={14} /><span>{item.name}</span><small>{formatSize(item.size)}</small></button></li>)}</ul>}
            </>}
          </article>
        </div>
      </div>
      {confirm && (
        <div className="mail-compose-backdrop" onClick={() => setConfirm(null)}>
          <form className="mail-compose mail-confirm" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void confirm.action(); }}>
            <header><strong>{confirm.title}</strong><button type="button" className="icon" onClick={() => setConfirm(null)}><X size={16} /></button></header>
            <p>{confirm.detail}</p>
            <footer>
              <button type="button" onClick={() => setConfirm(null)}>取消</button>
              <button className="primary" disabled={busy}>删除</button>
            </footer>
          </form>
        </div>
      )}
      {shareOpen && mailbox && (preview ? (
        <div className="mail-compose-backdrop" onClick={() => setShareOpen(false)}>
          <form className="mail-compose" onClick={(event) => event.stopPropagation()}>
            <header><strong>分享 {mailbox.address}</strong><button type="button" className="icon" onClick={() => setShareOpen(false)}><X size={16} /></button></header>
            <p className="mail-share-preview">演示模式不连权限接口。正式环境复用文件夹分享：只读、发邮件、管理员。</p>
            <footer><button type="button" className="primary" onClick={() => setShareOpen(false)}>知道了</button></footer>
          </form>
        </div>
      ) : <MailPermissionPanel mailboxId={mailbox.id} close={() => setShareOpen(false)} />)}
    </section>
  );
}
