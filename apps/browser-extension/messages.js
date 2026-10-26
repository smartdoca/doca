export const messages = {
  zh: {
    "updates.installed": "当前版本 v{version}",
    "updates.check": "检查更新",
    "updates.checking": "正在检查更新…",
    "updates.unconfigured": "填写 Doca 服务地址后可检查更新。",
    "updates.available":
      "发现新版 v{latest}，当前安装 v{current}。下载新包后需重新加载扩展。",
    "updates.current": "已是本站提供的最新版本。",
    "updates.ahead": "当前 v{current} 高于本站提供的 v{latest}。",
    "updates.failed": "无法检查更新，请稍后重试。",
    "updates.download": "前往 Doca 下载新包",
    "updates.downloadPage": "打开插件下载页",
    imagePlaceholder: "图片未保存：{name}（{reason}）",
    imageUnsupported: "格式不支持或图片内容无效",
    imageReadFailed: "原图无法读取",
    imageCompressionFailed: "图片转换失败",
    imageProcessingFailed: "图片处理失败",
    imageAnimationTooLarge: "动图超出大小上限",
    selectProfile: "选择收录规则",
    extensionSettings: "插件设置",
    back: "返回",
    manageProfiles: "设置收录规则",
    profileSettingsHelp:
      "在 Doca 设置保存位置、追加或新建策略，可配置多套规则。",
    handoff: "交给 AI",
    imagesHelp:
      "大图自动压缩，SVG 转为图片；无法保存的图片保留占位。AI 助手将在浏览器右侧打开。",
    captureImagePolicy: "SVG 转为图片 · 无法保存的图片保留占位",
    clipper_image_compression_failed: "图片压缩失败，收录尚未完成，请重试。",
    clipper_animated_image_too_large:
      "动图超过 20 MiB 或 2500 万像素，不会转成静态图，请选择更小的图片。",
    saveNow: "立即收录",
    analyze: "交给 AI 分析",
    browserSource: "浏览器会话",
    defaultProfile: "默认",
    quickCapture: "收录当前页",
    quickOrganize: "AI 整理后收录",
    organizePrompt:
      "请先阅读当前附加材料，判断是否需要整理。先按所选收录方案完整保存原文和原图；适合原样保存就结束，需要整理则在刚保存的文档中优化结构，保留事实、来源和原图。需要审批时请等待我的确认。",
    pageUnavailable: "切换到要引用的网页",
    selectionReference: "已选网页内容",
    shortcutHelp: "可在浏览器扩展快捷键设置中调整",

    advancedConfig: "粘贴站点配置",
    endpoint: "Doca 服务地址",
    endpointHelp:
      "填写 Doca 根地址，不包含 /api/v1。切换后使用新站点当前登录的账户。",
    saveEndpoint: "保存地址并连接",
    clipper_invalid_origin: "请输入 HTTPS 的 Doca 根地址，本机开发可用 HTTP。",
    login: "登录或重新连接 Doca",
    clipper_login_required: "请在打开的 Doca 页面完成登录，再返回插件。",
    clipper_login_invalid: "登录交接已过期，请重新连接。",
    clipper_token_expired: "正在重新验证 Doca 登录状态，请重试。",
    capture: "网页收录",
    assistant: "AI 助手",
    connection: "连接",
    profile: "收录方案",
    page: "收录当前页面",
    selection: "收录选中区域",
    openAssistant: "打开 AI 侧边栏",
    description: "保存网页内容与原图，随时回到 Doca 继续整理。",
    loadedOnly: "收录当前已加载的内容，包括页面下方已加载的部分。",
    settings: "在 Doca 设置保存位置与策略",
    retry: "重试上次收录",
    saving: "正在保存正文与原图…",
    saved: "已保存到 Doca",
    captureWarnings: "有 {count} 处内容未完整处理，文档已保留占位",
    open: "打开文档",
    connected: "已连接",
    notConnected: "连接你的 Doca",
    setup:
      "跟随当前浏览器的 Doca 登录状态。站点配置只包含地址，不包含账户凭证。",
    config: "Doca 连接配置",
    import: "连接 Doca",
    replace: "替换连接配置",
    importHelp:
      "配置只包含 Doca 地址。切换站点后使用该站点当前登录账户的收录方案。",
    paste: "粘贴 Doca 生成的完整配置",
    noProfiles: "先在 Doca 创建一个收录方案",
    model: "模型",
    prompt: "让 Doca 帮你整理资料…",
    send: "发送",
    attach: "附加当前网页或选区",
    sendHelp: "发送时附加此网页；可取消勾选。打开助手不会发送内容。",
    newChat: "新对话",
    continue: "在 Doca 继续",
    preparing: "正在准备网页材料与图片…",
    working: "正在处理…",
    stopped: "已停止",
    cancel: "停止",
    approve: "允许执行",
    reject: "拒绝",
    approval: "需要确认操作",
    emptyChat: "保持网页在眼前，交给 Doca 整理。",
    emptyChatHelp: "试试：把这篇文章整理成故障现象、原因、排查步骤和解决方案。",
    aiDisabled: "当前连接未启用 AI，请在 Doca 的连接设置中开启。",
    expired: "激活配置已过期，请在 Doca 重新生成。",
    generalError: "操作未完成，请重试。",
    generalErrorWithCode: "操作未完成（错误代码：{code}），请重试。",
    clipper_too_many_pending:
      "未完成的收录任务过多，请重试已有任务或等待旧任务到期后重新收录。",
    account: "当前账户",
    locale: "界面语言",
    clipper_not_connected: "请先粘贴 Doca 配置完成连接。",
    clipper_invalid_config: "配置格式无效或版本不支持，原站点配置已保留。",
    clipper_activation_invalid: "激活配置已过期、已使用或已撤销，请重新生成。",
    clipper_connection_revoked:
      "连接已撤销，请在 Doca 的浏览器连接页面手动恢复。",
    clipper_page_unsupported: "此页面无法收录。已打开的普通网页请刷新后重试。",
    clipper_selection_missing: "请先在网页选择需要收录的内容。",
    clipper_image_failed: "图片读取失败，请保持原网页打开并重试。",
    clipper_image_invalid:
      "图片格式不支持、内容无效或超出处理上限，收录尚未完成。",
    clipper_images_missing: "仍有图片未上传，请重试，正文尚未保存。",
    clipper_conversion_warning:
      "此页面包含当前无法完整转换的内容，收录尚未完成。",
    clipper_profile_changed: "收录方案已修改，请重新选择方案后收录。",
    clipper_profile_unavailable: "收录方案不可用，请在 Doca 检查设置。",
    clipper_request_conflict: "重试内容与原任务不一致，请重新发起收录。",
    clipper_capture_expired: "未完成的收录已到期，请重新收录。",
    clipper_connection_failed: "无法连接 Doca，请检查站点和网络。",
    clipper_scope_denied: "此操作超出当前连接的授权范围。",
    clipper_assistant_disabled: "当前连接未启用 AI 助手。",
    clipper_content_too_large: "页面内容超过本次收录上限，请选择较小范围。",
    clipper_too_many_images: "页面超过 100 张图片，请选择需要的内容。",
    clipper_busy: "另一个收录正在保存，请完成后再试。",
    clipper_session_missing: "会话不可用，请开始新对话。",
    clipper_target_uninitialized:
      "目标文档尚未就绪，请在 Doca 打开一次后重试。",
  },
  en: {
    "updates.installed": "Installed version v{version}",
    "updates.check": "Check for updates",
    "updates.checking": "Checking for updates…",
    "updates.unconfigured":
      "Enter your Doca server address to check for updates.",
    "updates.available":
      "Version {latest} is available; {current} is installed. Download the package and reload the extension.",
    "updates.current": "You have the latest version provided by this site.",
    "updates.ahead":
      "Installed version {current} is newer than this site's version {latest}.",
    "updates.failed": "Unable to check for updates. Try again later.",
    "updates.download": "Download the new package in Doca",
    "updates.downloadPage": "Open the extension download page",
    imagePlaceholder: "Image not saved: {name} ({reason})",
    imageUnsupported: "unsupported format or invalid image",
    imageReadFailed: "source image could not be read",
    imageCompressionFailed: "image conversion failed",
    imageProcessingFailed: "image processing failed",
    imageAnimationTooLarge: "animation exceeds the size limit",
    selectProfile: "Choose a capture rule",
    extensionSettings: "Extension settings",
    back: "Back",
    manageProfiles: "Manage capture rules",
    profileSettingsHelp:
      "Configure destinations and append or create strategies in Doca. Multiple rules are supported.",
    handoff: "Ask AI",
    imagesHelp:
      "Large images are compressed and SVG is converted. Unavailable images are marked in the document. AI opens in your browser’s sidebar.",
    captureImagePolicy: "SVG converted · Unavailable images marked",
    clipper_image_compression_failed:
      "Image compression failed. Capture is incomplete; please retry.",
    clipper_animated_image_too_large:
      "The animation exceeds 20 MiB or 25 million pixels. It will not be flattened; choose a smaller image.",
    saveNow: "Save now",
    analyze: "Analyze with AI",
    browserSource: "Browser conversation",
    defaultProfile: "Default",
    quickCapture: "Save current page",
    quickOrganize: "Organize with AI",
    organizePrompt:
      "Read the attached material and decide whether it needs editing. First archive the original content and images using the selected capture profile. If editing is needed, improve that saved document while preserving facts, the source and images. Wait for my confirmation when approval is required.",
    pageUnavailable: "Switch to a page to reference it",
    selectionReference: "Selected page content",
    shortcutHelp:
      "Customize these in your browser’s extension shortcut settings",

    advancedConfig: "Paste site configuration",
    endpoint: "Doca server address",
    endpointHelp:
      "Use the Doca origin without /api/v1. Sign-in follows the account on that site.",
    saveEndpoint: "Save address and connect",
    clipper_invalid_origin:
      "Enter a Doca HTTPS origin. Loopback HTTP is allowed for development.",
    login: "Sign in or reconnect to Doca",
    clipper_login_required:
      "Sign in on the Doca page, then return to the extension.",
    clipper_login_invalid: "Sign-in exchange expired. Reconnect to Doca.",
    clipper_token_expired: "Verify your Doca sign-in and retry.",
    capture: "Web capture",
    assistant: "AI assistant",
    connection: "Connection",
    profile: "Capture profile",
    page: "Save entire page",
    selection: "Save selection",
    openAssistant: "Open AI sidebar",
    description:
      "Save page content and original images, then continue in Doca.",
    loadedOnly:
      "Captures loaded content, including loaded sections below the viewport.",
    settings: "Manage destinations and strategies in Doca",
    retry: "Retry previous capture",
    saving: "Saving content and original images…",
    saved: "Saved to Doca",
    captureWarnings:
      "{count} items could not be fully processed; placeholders were saved",
    open: "Open document",
    connected: "Connected",
    notConnected: "Connect your Doca",
    setup:
      "Uses this browser’s Doca sign-in. Download a site-configured extension or paste a site address configuration.",
    config: "Doca connection configuration",
    import: "Connect Doca",
    replace: "Replace connection",
    importHelp:
      "The configuration contains only a Doca address. Sign-in and capture profiles follow the account used on that site.",
    paste: "Paste the complete configuration generated by Doca",
    noProfiles: "Create a capture profile in Doca first",
    model: "Model",
    prompt: "Ask Doca to organize your material…",
    send: "Send",
    attach: "Attach current page or selection",
    sendHelp:
      "This page is attached when you send. Uncheck to exclude it. Opening the assistant sends nothing.",
    newChat: "New conversation",
    continue: "Continue in Doca",
    preparing: "Preparing page material and images…",
    working: "Working…",
    stopped: "Stopped",
    cancel: "Stop",
    approve: "Allow",
    reject: "Reject",
    approval: "Confirm operation",
    emptyChat: "Keep your page in view. Let Doca organize it.",
    emptyChatHelp:
      "Try: organize this article into symptoms, causes, diagnostic steps and solutions.",
    aiDisabled:
      "AI is disabled for this connection. Enable it in Doca’s connection settings.",
    expired:
      "The activation has expired. Generate a new configuration in Doca.",
    generalError: "The operation did not complete. Please retry.",
    generalErrorWithCode: "The operation did not complete (error code: {code}). Please retry.",
    clipper_too_many_pending:
      "Too many unfinished captures. Retry an existing capture or wait for old tasks to expire.",
    account: "Current account",
    locale: "Language",
    clipper_not_connected: "Paste a Doca configuration to connect.",
    clipper_invalid_config:
      "Invalid or unsupported configuration. Your current site was kept.",
    clipper_activation_invalid:
      "Activation expired, used or revoked. Generate a new configuration.",
    clipper_connection_revoked:
      "Connection revoked. Restore this connection explicitly in Doca.",
    clipper_page_unsupported:
      "This page cannot be captured. Refresh an ordinary web page and retry.",
    clipper_selection_missing: "Select content on the page first.",
    clipper_image_failed:
      "An image could not be read. Keep the source page open and retry.",
    clipper_image_invalid:
      "An image is unsupported, invalid or exceeds the processing limit. Capture is incomplete.",
    clipper_images_missing:
      "Some images have not uploaded. Retry; content has not been saved.",
    clipper_conversion_warning:
      "Some page content cannot be converted completely. Capture is incomplete.",
    clipper_profile_changed:
      "The capture profile changed. Select it again and restart.",
    clipper_profile_unavailable:
      "The capture profile is unavailable. Check Doca settings.",
    clipper_request_conflict:
      "Retry differs from the original task. Start a new capture.",
    clipper_capture_expired: "The unfinished capture expired. Start again.",
    clipper_connection_failed:
      "Doca is unreachable. Check your site and network.",
    clipper_scope_denied:
      "This operation is outside the connection’s authorization.",
    clipper_assistant_disabled: "AI is disabled for this connection.",
    clipper_content_too_large:
      "Content exceeds the capture limit. Select a smaller portion.",
    clipper_too_many_images:
      "Page contains over 100 images. Select the content you need.",
    clipper_busy: "Another capture is saving. Wait for it to finish.",
    clipper_session_missing:
      "Conversation unavailable. Start a new conversation.",
    clipper_target_uninitialized:
      "Open the target document in Doca once and retry.",
  },
};
export const translate = (locale, key, params = {}) =>
  (messages[locale]?.[key] || messages.en[key] || key).replace(
    /\{(\w+)\}/g,
    (match, name) =>
      params[name] === undefined ? match : String(params[name]),
  );
