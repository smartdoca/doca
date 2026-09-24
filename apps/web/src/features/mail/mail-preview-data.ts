export const previewMailboxId = "11111111-1111-4111-8111-111111111111";
export const inboxId = "inbox-preview";
export const sentId = "sent-preview";
export const draftsId = "drafts-preview";
export const junkId = "junk-preview";
export const trashId = "trash-preview";
export const archiveId = "archive-preview";

export const previewOverview = {
  enabled: true,
  configured: true,
  internalConfigured: true,
  mock: true,
  domain: "heyphp.com",
  mode: "free" as const,
  maxMailboxes: 3,
  external: {
    enabled: true,
    maxAccounts: 5,
    providers: [
      { id: "gmail", label: "Gmail", hint: "通过 Google 账号授权。", auth: "oauth" as const, oauthReady: true },
      { id: "qq", label: "QQ 邮箱", hint: "使用 QQ 邮箱授权码。", auth: "password" as const },
    ],
  },
  mailboxes: [
    {
      id: previewMailboxId,
      address: "ada@heyphp.com",
      localPart: "ada",
      displayName: "Ada",
      kind: "personal" as const,
      source: "internal" as const,
      provider: "",
      providerLabel: "",
      locked: true,
      shareable: false,
      deletable: false,
      role: "owner" as const,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      address: "support@heyphp.com",
      localPart: "support",
      displayName: "支持邮箱",
      kind: "shared" as const,
      source: "internal" as const,
      provider: "",
      providerLabel: "",
      locked: false,
      shareable: true,
      deletable: true,
      role: "admin" as const,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      address: "ada.chen@gmail.com",
      localPart: "ada.chen",
      displayName: "Ada Gmail",
      kind: "personal" as const,
      source: "external" as const,
      provider: "gmail",
      providerLabel: "Gmail",
      locked: false,
      shareable: false,
      deletable: true,
      role: "owner" as const,
    },
  ],
};

export const previewFolders = [
  { id: inboxId, name: "收件箱", role: "inbox", total: 5, unread: 2 },
  { id: sentId, name: "已发送", role: "sent", total: 1, unread: 0 },
  { id: draftsId, name: "草稿箱", role: "drafts", total: 1, unread: 0 },
  { id: junkId, name: "垃圾邮件", role: "junk", total: 1, unread: 1 },
  { id: trashId, name: "已删除", role: "trash", total: 1, unread: 0 },
  { id: archiveId, name: "归档", role: "archive", total: 1, unread: 0 },
];

const now = Date.now();
const at = (hours: number) => new Date(now - hours * 3600_000).toISOString();

export const previewMessages = [
  {
    id: "m1",
    folderId: inboxId,
    folder: "收件箱",
    subject: "本周产品进展：邮箱系统进入验收",
    from: { name: "产品周报", email: "weekly@heyphp.com" },
    to: [{ name: "Ada", email: "ada@heyphp.com" }, { name: "支持邮箱", email: "support@heyphp.com" }],
    cc: [{ name: "Alice Chen", email: "alice@example.com" }],
    bcc: [],
    snippet: "收件箱、写邮件、附件和分享已经可以在页面里走一遍，请按清单核对未读、星标和正文区。",
    unread: true,
    starred: true,
    hasAttachments: true,
    receivedAt: at(2),
    text: "你好：\n\n邮箱页面这一版先用本地 mock 后端验收样式。\n请重点看收件箱列表、未读/星标、正文区和右下角写邮件。\n抄送了 Alice，方便一起过一遍。\n\n—— 产品",
    html: `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202124">
      <tr><td style="padding:0 0 16px"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#e8f0fe;color:#1967d2;font-size:12px;font-weight:600">产品周报</span></td></tr>
      <tr><td><p style="margin:0 0 12px;font-size:16px">你好：</p>
        <p style="margin:0 0 12px;line-height:1.7">邮箱页面这一版先用本地 mock 后端验收样式。请重点看<strong>收件箱列表</strong>、<em>未读/星标</em>、正文区和写邮件。</p>
        <table width="100%" cellpadding="10" cellspacing="0" style="background:#f8fbff;border:1px solid #e8eaed;border-radius:8px">
          <tr><td style="border-bottom:1px solid #e8eaed">列表滚动</td><td>左侧超出可滑</td></tr>
          <tr><td style="border-bottom:1px solid #e8eaed">HTML 正文</td><td>表格、强调、引用</td></tr>
          <tr><td>写邮件</td><td>右侧富文本</td></tr>
        </table>
        <p style="margin:16px 0 0;color:#5f6368">抄送了 Alice，方便一起过一遍。</p>
        <p style="margin:24px 0 0">—— 产品</p></td></tr>
    </table>`,
    attachments: [{ id: "a1", name: "验收清单.txt", mime: "text/plain", size: 1280 }],
  },
  {
    id: "m2",
    folderId: inboxId,
    folder: "收件箱",
    subject: "9 月预算表请查收",
    from: { name: "财务", email: "finance@heyphp.com" },
    to: [{ name: "Ada", email: "ada@heyphp.com" }],
    cc: [{ name: "管理员", email: "admin@heyphp.com" }],
    bcc: [],
    snippet: "本月预算已经汇总，附件是最新一版，请在本周五前确认市场和研发两栏。",
    unread: true,
    starred: false,
    hasAttachments: true,
    receivedAt: at(5),
    text: "各位好，\n\n9 月预算表已更新，请在本周五前确认。\n市场 80,000，研发 120,000。如有调整直接回复这封邮件。\n\n财务组",
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#202124;line-height:1.7">
      <p>各位好，</p>
      <p>9 月预算表已更新，请在<strong>本周五前</strong>确认。</p>
      <ul><li>市场 <span style="color:#188038;font-weight:600">80,000</span></li><li>研发 <span style="color:#d93025;font-weight:600">120,000</span></li></ul>
      <p>如有调整直接回复这封邮件。</p>
      <p style="color:#5f6368">财务组</p>
    </div>`,
    attachments: [
      { id: "a2", name: "9月预算.txt", mime: "text/plain", size: 4096 },
      { id: "a2b", name: "说明.txt", mime: "text/plain", size: 860 },
    ],
  },
  {
    id: "m3",
    folderId: inboxId,
    folder: "收件箱",
    subject: "Re: 下周评审时间",
    from: { name: "Alice Chen", email: "alice@example.com" },
    to: [{ name: "Ada", email: "ada@heyphp.com" }],
    cc: [{ name: "Bob", email: "bob@heyphp.com" }],
    bcc: [],
    snippet: "周三下午两点可以，会议室我来订。如果改到周四也行，你定。",
    unread: false,
    starred: true,
    hasAttachments: false,
    receivedAt: at(26),
    text: "可以，周三 14:00。\n我订一下 3 号会议室，到时见。\n如果和预算会撞车，改周四上午也行。",
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7">
      <p>可以，<strong>周三 14:00</strong>。</p>
      <p>我订一下 3 号会议室，到时见。<br>如果和预算会撞车，改周四上午也行。</p>
      <blockquote style="margin:12px 0;padding-left:12px;border-left:3px solid #dadce0;color:#5f6368">
        <p>----- 原始邮件 -----</p>
        <p>下周评审能不能定在周三下午？我这边预算会也要排。</p>
      </blockquote>
    </div>`,
    attachments: [],
  },
  {
    id: "m4",
    folderId: inboxId,
    folder: "收件箱",
    subject: "[doca] 你的检查已经通过",
    from: { name: "GitHub", email: "noreply@github.com" },
    to: [{ email: "ada@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "mail.test.ts、mail-addresses.test.ts 和其他相关检查已全部通过。",
    unread: false,
    starred: false,
    hasAttachments: false,
    receivedAt: at(30),
    text: "All checks have passed.\n\nmail.test.ts\nmail-addresses.test.ts\nsearch-intent.test.ts",
    html: `<pre style="margin:0;padding:16px;background:#0d1117;color:#c9d1d9;border-radius:8px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">All checks have passed.

mail.test.ts
mail-addresses.test.ts
search-intent.test.ts</pre>`,
    attachments: [],
  },
  {
    id: "m5",
    folderId: inboxId,
    folder: "收件箱",
    subject: "邀请你共同管理 support@heyphp.com",
    from: { name: "管理员", email: "admin@heyphp.com" },
    to: [{ name: "Ada", email: "ada@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "把支持邮箱分享给你，权限是管理员，可以改成员和发信。",
    unread: false,
    starred: false,
    hasAttachments: false,
    receivedAt: at(50),
    text: "已经把 support 邮箱加到你的邮箱列表里。\n只读、发邮件、管理员三种权限都可以在分享面板里改。",
    html: "",
    attachments: [],
  },
  {
    id: "m6",
    folderId: sentId,
    folder: "已发送",
    subject: "会议纪要已发",
    from: { name: "Ada", email: "ada@heyphp.com" },
    to: [{ name: "Alice Chen", email: "alice@example.com" }],
    cc: [{ name: "产品周报", email: "weekly@heyphp.com" }],
    bcc: [],
    snippet: "纪要在正文里：先走 mock 验收样式，再接真实 Stalwart。",
    unread: false,
    starred: false,
    hasAttachments: false,
    receivedAt: at(8),
    text: "纪要：\n1. 邮箱先走 mock 验收样式\n2. 再接真实 Stalwart",
    html: "",
    attachments: [],
  },
  {
    id: "m7",
    folderId: draftsId,
    folder: "草稿箱",
    subject: "下周出差行程",
    from: { name: "Ada", email: "ada@heyphp.com" },
    to: [{ email: "hr@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "草稿：周一出发，周三回来，酒店还没订。",
    unread: false,
    starred: false,
    hasAttachments: false,
    receivedAt: at(3),
    text: "周一出发，周三回来。酒店还没订。",
    html: "",
    attachments: [],
  },
  {
    id: "m8",
    folderId: junkId,
    folder: "垃圾邮件",
    subject: "恭喜中奖，点击领取",
    from: { name: "抽奖通知", email: "promo@spam.test" },
    to: [{ email: "ada@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "这是一封垃圾邮件示例，请忽略。",
    unread: true,
    starred: false,
    hasAttachments: false,
    receivedAt: at(12),
    text: "请忽略这封演示垃圾邮件。",
    html: "",
    attachments: [],
  },
  {
    id: "m9",
    folderId: trashId,
    folder: "已删除",
    subject: "过期的验证码",
    from: { name: "安全中心", email: "security@heyphp.com" },
    to: [{ email: "ada@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "验证码 483920，已放入已删除。",
    unread: false,
    starred: false,
    hasAttachments: false,
    receivedAt: at(80),
    text: "你的验证码是 483920，10 分钟内有效。",
    html: "",
    attachments: [],
  },
  {
    id: "m10",
    folderId: archiveId,
    folder: "归档",
    subject: "入职指南",
    from: { name: "HR", email: "hr@heyphp.com" },
    to: [{ email: "ada@heyphp.com" }],
    cc: [],
    bcc: [],
    snippet: "欢迎加入，办公用品在 12 楼前台领取，这封已经归档。",
    unread: false,
    starred: false,
    hasAttachments: true,
    receivedAt: at(200),
    text: "入职当天请带身份证原件。办公用品在 12 楼前台领取。",
    html: "",
    attachments: [{ id: "a10", name: "入职清单.txt", mime: "text/plain", size: 640 }],
  },
];
