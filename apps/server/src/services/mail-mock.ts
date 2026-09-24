import { randomUUID } from "node:crypto";
import type { MailFolder, MailMessageDetail } from "../adapters/stalwart.js";

type StoredMessage = MailMessageDetail & { account: string };

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function textFile(name: string, text: string) {
  const data = Buffer.from(text).toString("base64");
  return {
    id: randomUUID(),
    name,
    mime: "text/plain",
    size: Buffer.byteLength(text),
    data,
  };
}

export function seedMockMessages(
  account: { address: string; folders: Map<string, MailFolder> },
  messages: Map<string, StoredMessage>,
) {
  if ([...messages.values()].some((item) => item.account === account.address)) return;
  const folder = (role: MailFolder["role"]) =>
    [...account.folders.values()].find((item) => item.role === role)!;
  const inbox = folder("inbox");
  const sent = folder("sent");
  const drafts = folder("drafts");
  const junk = folder("junk");
  const trash = folder("trash");
  const archive = folder("archive");
  const self = { name: "我", email: account.address };
  const samples: Array<
    Omit<StoredMessage, "id" | "account" | "folderId" | "folder" | "to" | "cc" | "bcc"> & {
      folder: MailFolder;
      to?: StoredMessage["to"];
      cc?: StoredMessage["cc"];
    }
  > = [
    {
      folder: inbox,
      subject: "本周产品进展：邮箱系统进入验收",
      from: { name: "产品周报", email: "weekly@heyphp.com" },
      to: [self, { name: "支持邮箱", email: "support@heyphp.com" }],
      cc: [{ name: "Alice Chen", email: "alice@example.com" }],
      snippet: "收件箱、写邮件、附件和分享已经可以在页面里走一遍，请按清单核对未读、星标和正文区。",
      unread: true,
      starred: true,
      hasAttachments: true,
      sentAt: hoursAgo(2),
      receivedAt: hoursAgo(2),
      text: "你好：\n\n邮箱页面这一版先用本地 mock 后端验收样式。\n请重点看收件箱列表、未读/星标、正文区和右下角写邮件。\n\n—— 产品",
      html: "",
      attachments: [textFile("验收清单.txt", "收件箱\n写邮件\n附件\n分享\n搜索")],
    },
    {
      folder: inbox,
      subject: "9 月预算表请查收",
      from: { name: "财务", email: "finance@heyphp.com" },
      snippet: "本月预算已经汇总，附件是最新一版。",
      unread: true,
      starred: false,
      hasAttachments: true,
      sentAt: hoursAgo(5),
      receivedAt: hoursAgo(5),
      text: "各位好，\n\n9 月预算表已更新，请在本周五前确认。\n如有调整直接回复这封邮件。\n\n财务组",
      html: "",
      attachments: [textFile("9月预算.txt", "市场 80,000\n研发 120,000")],
    },
    {
      folder: inbox,
      subject: "Re: 下周评审时间",
      from: { name: "Alice Chen", email: "alice@example.com" },
      snippet: "周三下午两点可以，会议室我来订。",
      unread: false,
      starred: true,
      hasAttachments: false,
      sentAt: hoursAgo(26),
      receivedAt: hoursAgo(26),
      text: "可以，周三 14:00。\n我订一下 3 号会议室，到时见。",
      html: "",
      attachments: [],
    },
    {
      folder: inbox,
      subject: "[doca] 你的检查已经通过",
      from: { name: "GitHub", email: "noreply@github.com" },
      snippet: "mail.test.ts 和其他相关检查已全部通过。",
      unread: false,
      starred: false,
      hasAttachments: false,
      sentAt: hoursAgo(30),
      receivedAt: hoursAgo(30),
      text: "All checks have passed.\n\nmail.test.ts\nsearch-intent.test.ts",
      html: "",
      attachments: [],
    },
    {
      folder: inbox,
      subject: "邀请你共同管理 support@heyphp.com",
      from: { name: "管理员", email: "admin@heyphp.com" },
      snippet: "把支持邮箱分享给你，权限是可发邮件。",
      unread: false,
      starred: false,
      hasAttachments: false,
      sentAt: hoursAgo(50),
      receivedAt: hoursAgo(50),
      text: "已经把 support 邮箱加到你的邮箱列表里。\n只读、发邮件、管理员三种权限都可以在分享面板里改。",
      html: "",
      attachments: [],
    },
    {
      folder: sent,
      subject: "会议纪要已发",
      from: self,
      to: [{ name: "Alice Chen", email: "alice@example.com" }],
      snippet: "纪要在正文里，有问题随时回我。",
      unread: false,
      starred: false,
      hasAttachments: false,
      sentAt: hoursAgo(8),
      receivedAt: hoursAgo(8),
      text: "纪要：\n1. 邮箱先走 mock 验收样式\n2. 再接真实 Stalwart",
      html: "",
      attachments: [],
    },
    {
      folder: drafts,
      subject: "下周出差行程",
      from: self,
      to: [{ email: "hr@heyphp.com" }],
      snippet: "草稿：周一出发，周三回来。",
      unread: false,
      starred: false,
      hasAttachments: false,
      sentAt: null,
      receivedAt: hoursAgo(3),
      text: "周一出发，周三回来。酒店还没订。",
      html: "",
      attachments: [],
    },
    {
      folder: junk,
      subject: "恭喜中奖，点击领取",
      from: { name: "抽奖通知", email: "promo@spam.test" },
      snippet: "这是一封垃圾邮件示例。",
      unread: true,
      starred: false,
      hasAttachments: false,
      sentAt: hoursAgo(12),
      receivedAt: hoursAgo(12),
      text: "请忽略这封演示垃圾邮件。",
      html: "",
      attachments: [],
    },
    {
      folder: trash,
      subject: "过期的验证码",
      from: { name: "安全中心", email: "security@heyphp.com" },
      snippet: "验证码 483920，已放入已删除。",
      unread: false,
      starred: false,
      hasAttachments: false,
      sentAt: hoursAgo(80),
      receivedAt: hoursAgo(80),
      text: "你的验证码是 483920，10 分钟内有效。",
      html: "",
      attachments: [],
    },
    {
      folder: archive,
      subject: "入职指南",
      from: { name: "HR", email: "hr@heyphp.com" },
      snippet: "欢迎加入，这封已经归档。",
      unread: false,
      starred: false,
      hasAttachments: true,
      sentAt: hoursAgo(200),
      receivedAt: hoursAgo(200),
      text: "入职当天请带身份证原件。办公用品在 12 楼前台领取。",
      html: "",
      attachments: [textFile("入职清单.txt", "电脑\n工牌\nVPN")],
    },
  ];
  for (const item of samples) {
    const id = randomUUID();
    messages.set(id, {
      ...item,
      id,
      account: account.address,
      folderId: item.folder.id,
      folder: item.folder.name,
      to: item.to ?? [self],
      cc: item.cc ?? [],
      bcc: [],
    });
  }
}
