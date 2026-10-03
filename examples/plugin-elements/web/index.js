const messages = {
  zh: {
    "countdown.title": "倒计时",
    "countdown.label": "名称",
    "countdown.target": "目标时间",
    "countdown.finished": "已到期",
    "news.title": "新闻链接",
    "news.label": "新闻标题",
    "news.url": "链接地址",
    "form.save": "插入 / 保存",
    "form.cancel": "取消",
  },
  en: {
    "countdown.title": "Countdown",
    "countdown.label": "Label",
    "countdown.target": "Target time",
    "countdown.finished": "Time reached",
    "news.title": "News link",
    "news.label": "News title",
    "news.url": "URL",
    "form.save": "Insert / save",
    "form.cancel": "Cancel",
  },
};
export function countdownValid(data) {
  return (
    Object.keys(data).sort().join(",") === "label,targetAt" &&
    typeof data.label === "string" &&
    data.label.trim().length > 0 &&
    data.label.length <= 200 &&
    typeof data.targetAt === "string" &&
    Number.isFinite(Date.parse(data.targetAt)) &&
    new Date(data.targetAt).toISOString() === data.targetAt
  );
}
export function newsValid(data) {
  if (
    Object.keys(data).sort().join(",") !== "title,url" ||
    typeof data.title !== "string" ||
    !data.title.trim() ||
    data.title.length > 200 ||
    typeof data.url !== "string" ||
    data.url.length > 2000 ||
    /[\x00-\x20\\]/.test(data.url)
  )
    return false;
  try {
    const url = new URL(data.url);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function remaining(data, locale) {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(data.targetAt) - Date.now()) / 1000),
  );
  if (!seconds)
    return `${data.label} · ${messages[locale]["countdown.finished"]}`;
  const days = Math.floor(seconds / 86400),
    hours = Math.floor(seconds / 3600) % 24,
    minutes = Math.floor(seconds / 60) % 60;
  return `${data.label} · ${days ? `${days}${locale === "zh" ? "天" : "d"} ` : ""}${[hours, minutes, seconds % 60].map((v) => String(v).padStart(2, "0")).join(":")}`;
}
/** @param {import('@smartdoca/plugin-sdk/web').PluginWebHost<typeof import('react')>} host */
export default function elementsPlugin(host) {
  const R = host.React,
    h = R.createElement,
    pluginId = "example.elements";
  function Countdown({ payload, context }) {
    const [, tick] = R.useState(0);
    R.useEffect(() => {
      const timer = setInterval(() => {
        if (!context.signal.aborted) tick((v) => v + 1);
      }, 1000);
      return () => clearInterval(timer);
    }, [context.signal]);
    return h(
      "span",
      { title: payload.data.targetAt },
      remaining(payload.data, context.locale),
    );
  }
  function Config({ context, kind }) {
    const data = context.initialData,
      words = messages[context.locale];
    const [label, setLabel] = R.useState(data?.label ?? data?.title ?? "");
    const [url, setUrl] = R.useState(data?.url ?? "");
    const localDate = (value) => {
      const date = new Date(value);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    };
    const [target, setTarget] = R.useState(
      data?.targetAt
        ? localDate(data.targetAt)
        : localDate(Date.now() + 86400000),
    );
    return h(
      "form",
      {
        className: "plugin-element-form",
        onSubmit(event) {
          event.preventDefault();
          if (context.signal.aborted) return;
          context.submit(
            kind === "countdown"
              ? {
                  label: label.trim(),
                  targetAt: new Date(target).toISOString(),
                }
              : { title: label.trim(), url: url.trim() },
          );
        },
      },
      h(
        "label",
        null,
        words[`${kind}.label`],
        h("input", {
          required: true,
          maxLength: 200,
          value: label,
          onChange: (event) => setLabel(event.target.value),
        }),
      ),
      kind === "countdown"
        ? h(
            "label",
            null,
            words["countdown.target"],
            h("input", {
              required: true,
              type: "datetime-local",
              value: target,
              onChange: (event) => setTarget(event.target.value),
            }),
          )
        : h(
            "label",
            null,
            words["news.url"],
            h("input", {
              required: true,
              type: "url",
              maxLength: 2000,
              value: url,
              onChange: (event) => setUrl(event.target.value),
            }),
          ),
      h("button", { type: "submit" }, words["form.save"]),
      h(
        "button",
        { type: "button", onClick: context.cancel },
        words["form.cancel"],
      ),
    );
  }
  const cellText = (context, text, color) => {
    const { canvas, rect } = context;
    canvas.fillStyle = color;
    canvas.font = "13px sans-serif";
    canvas.textBaseline = "middle";
    canvas.fillText(
      text,
      rect.x + 6,
      rect.y + rect.height / 2,
      Math.max(1, rect.width - 12),
    );
  };
  return {
    manifest: { pluginId, version: "1.0.0", targets: ["web"] },
    elements: [
      {
        id: `${pluginId}.countdown`,
        pluginId,
        title: {
          zh: messages.zh["countdown.title"],
          en: messages.en["countdown.title"],
        },
        dataVersion: 1,
        formats: ["rich_text", "spreadsheet"],
        validate: countdownValid,
        text: (data) => `${data.label} · ${data.targetAt}`,
        refreshIntervalMs: 1000,
        renderEditor: (context) => h(Config, { context, kind: "countdown" }),
        render: (payload, context) => h(Countdown, { payload, context }),
        renderCell: (context) =>
          cellText(
            context,
            remaining(context.payload.data, context.locale),
            "#175cd3",
          ),
      },
      {
        id: `${pluginId}.news`,
        pluginId,
        title: { zh: messages.zh["news.title"], en: messages.en["news.title"] },
        dataVersion: 1,
        formats: ["rich_text", "spreadsheet"],
        validate: newsValid,
        text: (data) => `${data.title} · ${data.url}`,
        renderEditor: (context) => h(Config, { context, kind: "news" }),
        render: (payload) =>
          h(
            "a",
            {
              href: payload.data.url,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            payload.data.title,
          ),
        renderCell: (context) =>
          cellText(context, context.payload.data.title, "#175cd3"),
        onCellClick(payload, context) {
          if (!context.signal.aborted && newsValid(payload.data))
            window.open(payload.data.url, "_blank", "noopener,noreferrer");
        },
      },
    ],
  };
}
