(() => {
  const pageIndex = fetch("assets/pages.json").then(response => {
    if (!response.ok) throw new Error("Cannot load the documentation page index");
    return response.json();
  });
  let mermaid;
  function localizeSearch() {
    const chinese = document.documentElement.lang === "zh-CN";
    const search = document.querySelector(".search");
    if (!search) return;
    const clear = search.querySelector(".clear-button");
    clear.title = chinese ? "清空搜索" : "Clear search";
    clear.querySelector("span").textContent = clear.title;
    search.querySelector("input").setAttribute("aria-label", chinese ? "搜索文档" : "Search documentation");
    const status = search.querySelector(".results-status");
    const count = /^(?:Found (\d+) results|找到 (\d+) 条结果)$/.exec(status.textContent);
    if (count) {
      const value = chinese ? `找到 ${count[1] ?? count[2]} 条结果` : `Found ${count[1] ?? count[2]} results`;
      if (status.textContent !== value) status.textContent = value;
    }
  }
  window.$docsify = {
    name: "Doca",
    repo: "smartdoca/doca",
    nameLink: { "/zh-cn/": "#/zh-cn/", "/": "#/en/" },
    skipLink: { "/zh-cn/": "跳到正文", "/": "Skip to main content" },
    loadSidebar: true,
    loadNavbar: true,
    auto2top: true,
    subMaxLevel: 2,
    notFoundPage: "/_404.md",
    alias: {
      "/_sidebar.md": "/en/_sidebar.md",
      "/_navbar.md": "/en/_navbar.md",
      "/en/(?:.*/)?_sidebar.md": "/en/_sidebar.md",
      "/en/(?:.*/)?_navbar.md": "/en/_navbar.md",
      "/zh-cn/(?:.*/)?_sidebar.md": "/zh-cn/_sidebar.md",
      "/zh-cn/(?:.*/)?_navbar.md": "/zh-cn/_navbar.md"
    },
    search: {
      paths: "auto",
      namespace: "doca-0.1.10",
      pathNamespaces: ["/en", "/zh-cn"],
      placeholder: { "/zh-cn/": "搜索文档", "/": "Search documentation" },
      noData: { "/zh-cn/": "没有找到结果", "/": "No results" },
      depth: 6,
      maxAge: 3600000
    },
    plugins: [function (hook, vm) {
      hook.mounted(() => {
        localizeSearch();
        const status = document.querySelector(".search .results-status");
        new MutationObserver(localizeSearch).observe(status, { childList: true });
      });
      hook.beforeEach((markdown, next) => {
        const chinese = vm.route.path.startsWith("/zh-cn/");
        document.documentElement.lang = chinese ? "zh-CN" : "en";
        pageIndex.then(pages => {
          const path = vm.route.path === "/" ? "/en/" : vm.route.path;
          const page = pages.find(page => page.en === path || page.zh === path);
          if (!page) { next(markdown); return; }
          const source = chinese ? page.zhSource : page.enSource;
          const other = chinese ? page.en : page.zh;
          next(`${markdown}\n\n---\n\n[${chinese ? "在 GitHub 编辑此页" : "Edit this page on GitHub"}](https://github.com/smartdoca/doca/edit/main/docs/${source}) · [${chinese ? "English" : "简体中文"}](${other})\n`);
        }).catch(error => {
          console.error(error);
          next(markdown);
        });
      });
      hook.doneEach(async () => {
        localizeSearch();
        const diagrams = [...document.querySelectorAll('.markdown-section pre[data-lang="mermaid"]')];
        if (!diagrams.length) return;
        try {
          mermaid ??= import("https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs").then(module => {
            module.default.initialize({ startOnLoad: false, securityLevel: "strict" });
            return module.default;
          });
          const renderer = await mermaid;
          for (const pre of diagrams) {
            if (!pre.isConnected) continue;
            const node = document.createElement("div");
            node.className = "mermaid";
            node.textContent = pre.querySelector("code")?.textContent ?? pre.textContent;
            pre.replaceWith(node);
            await renderer.run({ nodes: [node] });
          }
        } catch (error) { console.error("Mermaid rendering failed", error); }
      });
    }]
  };
})();
