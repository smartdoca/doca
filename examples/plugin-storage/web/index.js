export default (host) => {
  const { createElement: h, useState } = host.React;
  function Page() {
    const [text, setText] = useState("SDK browser note"),
      [result, setResult] = useState(""),
      [error, setError] = useState("");
    const run = async (path, method = "GET", body) => {
      setError("");
      try {
        const value = await host.request(path, {
          method,
          ...(body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
        setResult(JSON.stringify(value, null, 2));
      } catch (e) {
        setError(e.message);
      }
    };
    return h(
      "section",
      { style: { padding: 24 } },
      h("h1", null, "Storage SDK acceptance"),
      h(
        "p",
        null,
        "Plugin-owned database, normal user files and private objects through public SDK services.",
      ),
      h("input", {
        value: text,
        onChange: (e) => setText(e.target.value),
        "aria-label": "Note text",
      }),
      h(
        "button",
        { onClick: () => run("/note", "POST", { text }) },
        "Write database",
      ),
      h("button", { onClick: () => run("/notes") }, "Read database"),
      h(
        "button",
        { onClick: () => run("/private-roundtrip", "POST") },
        "Private object roundtrip",
      ),
      h(
        "button",
        { onClick: () => run("/folder-file", "POST") },
        "Create folder and file",
      ),
      h(
        "button",
        { onClick: () => run("/sources") },
        "Discover content sources",
      ),
      error && h("p", { role: "alert" }, error),
      h(
        "pre",
        { "aria-label": "SDK result", style: { whiteSpace: "pre-wrap" } },
        result,
      ),
    );
  }
  return {
    manifest: {
      pluginId: "example.storage",
      version: "1.0.3",
      targets: ["web"],
    },
    routes: [
      {
        id: "example.storage.page",
        pluginId: "example.storage",
        path: "/plugins/example.storage/",
        render: () => h(Page),
      },
    ],
  };
};
