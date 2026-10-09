import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, Search, Plus, PanelLeft, Bell, ClipboardList } from "lucide-react";
import { LocaleProvider } from "@web/shared/i18n.js";
import { WorkspaceHome } from "@web/features/workspace/home.js";
import { Dashboard } from "@web/features/workspace/dashboard.js";
import { LeftNavigation } from "@web/plugins/navigation.js";
import { PinnedDocuments } from "@web/features/workspace/pinned-nav.js";
import { CreatePopover } from "@web/features/documents/document-experience.js";
import { DocumentTree } from "@web/features/documents/tree.js";
import "@web/styles/globals.css";
import "@web/features/workspace/workspace.css";
import "@web/styles/theme.css";
import "@web/features/documents/document-experience.css";
import "@web/styles/platform-polish.css";
import "@web/features/workspace/workspace-density.css";
import "@web/features/documents/document-tree.css";
import "@web/features/workspace/navigation-collapse.css";

const params = new URLSearchParams(location.search);
if (!location.hash) location.hash = "/home";
document.documentElement.dataset.theme = params.get("theme") ?? "light";
document.documentElement.dataset.density = params.get("density") ?? "comfortable";

function WorkspaceFixture() {
  const [hash, setHash] = useState(location.hash);
  const [createRect, setCreateRect] = useState<DOMRect | null>(null);
  const [expanded, setExpanded] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const tree = params.get("tree") === "1";
  useEffect(() => {
    const changed = () => setHash(location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const section = hash.startsWith("#/libraries") ? "libraries" : "documents";
  const home = hash === "#/home";
  const openCreate = () => {
    if (createButton.current) setCreateRect(createButton.current.getBoundingClientRect());
  };
  return <div className={`app-shell${expanded ? " navigation-expanded" : ""}`}>
    <aside className={`sidebar${tree ? " library-sidebar" : ""}`}>
      <div className="library-brand-row">
        <a className="brand" href="#/home"><span className="brand-symbol"><BookOpen size={22}/></span><span>Doca</span></a>
        <button className="icon navigation-toggle sidebar-navigation-toggle" aria-label="展开侧边导航" onClick={() => setExpanded(!expanded)}><PanelLeft size={16}/></button>
      </div>
      <button className="sidebar-search"><Search size={17}/><span>搜索</span><kbd>⌘ K</kbd></button>
      <nav>
        <button ref={createButton} className="sidebar-create-entry" aria-label="创作" onClick={openCreate}><span className="sidebar-create-plus"><Plus size={16} strokeWidth={2.6}/></span><span className="sidebar-create-label">创作</span></button>
        <PinnedDocuments refresh={0}/>
        {tree ? <DocumentTree refresh={0} userId="qa-user" libraryId="qa-library" selected="qa-rich_text" accountActions={false} create={() => {}}/> : <LeftNavigation/>}
      </nav>
    </aside>
    <main className="workspace">
      <header className="topbar workspace-topbar">
        <div className="document-topbar-title"/>
        <div className="global-header-tools inline"><button className="icon" aria-label="工单"><ClipboardList size={20}/></button><button className="icon" aria-label="通知"><Bell size={20}/></button><button className="quiet-link">中文</button><span className="user-avatar" style={{background:"var(--selected)",color:"var(--brand)"}}>我</span></div>
      </header>
      {home ? <div className="main-scroll workspace-home-scroll"><WorkspaceHome name="管理员"/></div> : <div className="main-scroll dashboard-scroll-host"><Dashboard section={section} refresh={0} currentUserId="qa-user" create={openCreate} changed={() => {}}/></div>}
    </main>
    {createRect && <CreatePopover rect={createRect} close={() => setCreateRect(null)} choose={() => setCreateRect(null)} busy={false}/>}
  </div>;
}

async function prepareBaseline() {
  if (params.get("before") !== "1") return;
  const baselineFiles = new Set([
    "apps/web/src/styles/globals.css", "apps/web/src/styles/theme.css", "apps/web/src/styles/platform-polish.css",
    "apps/web/src/features/workspace/workspace.css", "apps/web/src/features/workspace/workspace-density.css",
    "apps/web/src/features/workspace/home.css", "apps/web/src/features/workspace/navigation-collapse.css",
    "apps/web/src/features/documents/document-icons.css", "apps/web/src/features/documents/document-tree.css",
    "apps/web/src/plugins/navigation.css",
  ]);
  const styles = document.querySelectorAll<HTMLStyleElement>("style[data-vite-dev-id]");
  for (const style of styles) {
    const id = style.dataset.viteDevId ?? "";
    const path = id.slice(id.indexOf("/apps/web/")+1).split("?")[0];
    if (!id.includes("/apps/web/") || !baselineFiles.has(path)) continue;
    const response = await fetch(`/__baseline-css?path=${encodeURIComponent(path)}`);
    if (response.ok) style.textContent = await response.text();
  }
}

await prepareBaseline();
createRoot(document.getElementById("root")!).render(<LocaleProvider><WorkspaceFixture/></LocaleProvider>);
