"""Render five visual treatments over one unchanged Doca workspace layout."""

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "style-round"

ICONS = {
    "book": '<path d="M12 7v14m0-14C9 4 5 4 2 5v15c3-1 7-1 10 1m0-14c3-3 7-3 10-2v15c-3-1-7-1-10 1"/>',
    "home": '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/>',
    "sparkles": '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7zM20 2v4m-2-2h4"/>',
    "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
    "folder": '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9"/><circle cx="9" cy="7" r="4"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    "search": '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    "pin": '<path d="M16 3H8m1 0v5l-3 4v3h12v-3l-3-4V3m-3 12v7"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "trash": '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    "bell": '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-11 9a2 2 0 0 0 4 0"/>',
    "clipboard": '<rect x="5" y="4" width="14" height="18" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 11h6m-6 5h6"/>',
    "panel": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    "refresh": '<path d="M3 10a9 9 0 0 1 15-6l3 3m0-5v5h-5M21 14A9 9 0 0 1 6 20l-3-3m0 5v-5h5"/>',
    "arrow": '<path d="M7 17 17 7M7 7h10v10"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    "todo": '<path d="m3 5 2 2 3-3m3 2h10M3 12h4m4 0h10M3 18h4m4 0h10"/>',
}


def icon(name, extra=""):
    return f'<svg class="glyph {extra}" aria-hidden="true" viewBox="0 0 24 24">{ICONS[name]}</svg>'


NAV = [
    ("home", "首页"), ("sparkles", "AI 助手"), ("file", "文档"),
    ("book", "知识库"), ("book", "知识册"), ("folder", "文件夹"),
    ("users", "共享文件夹"), ("search", "公共资源"),
]

RECENT = [
    ("file", "调研", "文档", "8 分钟前"),
    ("file", "新的需求", "文档", "8 分钟前"),
    ("file", "问题记录", "文档", "8 分钟前"),
    ("file", "千问与火山引擎产品对比分析", "文档", "2 小时前"),
    ("book", "我的", "知识库", "5 小时前"),
    ("book", "计算机网络详解", "知识库", "今天 15:04"),
    ("file", "image.png", "文件", "今天 14:12"),
]

CSS = """* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { color: var(--text); background: var(--bg); font-family: var(--body-font); font-size: 14px; line-height: 1.5; }
button, a { font: inherit; color: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0; border: 0; background: transparent; cursor: default; }
a { text-decoration: none; }
.glyph { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.app-shell { height: 100dvh; display: grid; grid-template-columns: 254px minmax(0, 1fr); overflow: hidden; }
.sidebar { display: flex; flex-direction: column; min-height: 0; padding: 12px 10px 8px; background: var(--sidebar); border-right: 1px solid var(--line); }
.library-brand-row { display: flex; align-items: center; gap: 4px; padding-bottom: 12px; flex: none; }
.brand { display: flex; flex: 1; align-items: center; gap: 8px; padding: 0 6px; font-size: 16px; font-weight: 650; }
.brand-symbol { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-text); border-radius: var(--control-radius); }
.icon { width: 28px; height: 28px; color: var(--muted); flex: none; }
.sidebar-search { display: flex; height: 38px; min-height: 38px; padding: 7px 10px; margin: 0 2px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--control-radius); color: var(--muted); }
.sidebar-search span { flex: 1; text-align: left; }
.sidebar-search kbd { font-size: 10px; font-family: inherit; }
.sidebar nav { display: grid; gap: 4px; flex: none; }
.sidebar nav > a, .sidebar nav > button { display: flex; height: 40px; min-height: 40px; align-items: center; justify-content: flex-start; padding: 8px 12px; gap: 10px; font-size: 15px; font-weight: 500; color: var(--muted); border-radius: var(--control-radius); }
.sidebar nav > .create, .sidebar nav > .pinned { border: 1px solid var(--line); background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--button-shadow); }
.sidebar nav > .create { margin-bottom: 6px; }
.create-plus { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-text); border-radius: var(--control-radius); }
.create-plus svg { width: 14px; height: 14px; }
.sidebar nav > .pinned { margin-bottom: 10px; }
.pinned .glyph { color: var(--accent); }
.sidebar nav > .active { color: var(--accent); background: var(--selected); font-weight: 600; }
.sidebar nav > .assistant { color: var(--accent); font-weight: 600; }
.sidebar nav > .trash { height: 52px; min-height: 52px; margin-top: 8px; padding-top: 19px; border-top: 1px solid var(--line); border-radius: 0; }
.workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
.topbar { height: 56px; min-height: 56px; display: flex; align-items: center; justify-content: flex-end; padding: 0 16px; gap: 18px; flex: none; }
.topbar .glyph { width: 20px; height: 20px; }
.topbar button { color: var(--text); }
.topbar .avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--selected); color: var(--accent); font-weight: 600; }
.main-scroll { overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0; scrollbar-gutter: stable; }
.workspace-home { width: 100%; max-width: 1320px; min-width: 0; margin: 0 auto; padding: 32px 36px 64px; }
.workspace-welcome { display: flex; align-items: center; justify-content: space-between; margin-bottom: 26px; }
.workspace-welcome p { color: var(--muted); font-size: 13px; line-height: 20px; margin: 0 0 10px; }
.workspace-welcome h1 { font-family: var(--display-font); font-size: 26px; line-height: 36px; margin: 0 0 8px; font-weight: var(--display-weight); }
.workspace-welcome span { color: var(--muted); font-size: 14px; line-height: 21px; }
.workspace-columns { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: start; }
.workspace-columns > * { min-width: 0; }
.workspace-panel { background: var(--surface); border: 1px solid var(--panel-line); border-radius: var(--panel-radius); overflow: hidden; padding: 20px; box-shadow: var(--panel-shadow); }
.workspace-panel header h2 { display: flex; align-items: center; gap: 9px; margin: 0 0 18px; font-size: 16px; line-height: 24px; font-weight: 600; }
.home-tabs { display: flex; gap: 28px; border-bottom: 1px solid var(--line); margin: 4px 0 0; overflow-x: auto; white-space: nowrap; }
.home-tabs button { padding: 14px 0; font-size: 14px; line-height: 21px; position: relative; color: var(--muted); }
.home-tabs .active { color: var(--accent); font-weight: 600; }
.home-tabs .active:after { content: ''; position: absolute; height: 3px; background: var(--accent); bottom: 0; left: 0; right: 0; border-radius: 2px; }
.workspace-recent > div { display: flex; align-items: center; gap: 12px; padding: 15px 0; border-bottom: 1px solid var(--line); }
.file-glyph { width: 30px; height: 32px; display: inline-flex; align-items: center; justify-content: center; flex: none; border-radius: var(--control-radius); background: var(--doc-bg); color: var(--doc-ink); }
.file-glyph.library { background: var(--library-bg); color: var(--library-ink); }
.file-glyph.file { background: var(--selected); color: var(--muted); }
.file-glyph .glyph { width: 20px; height: 20px; }
.recent-title { min-width: 0; flex: 1; }
.recent-title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 21px; font-weight: 500; }
.recent-title small { display: flex; gap: 10px; margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 18px; }
.workspace-recent .icon { width: 28px; height: 28px; }
.workspace-recent .icon .glyph { width: 16px; height: 16px; }
.workspace-ai { display: block; position: relative; background: var(--ai-bg); border: 1px solid var(--ai-line); border-radius: var(--panel-radius); padding: 22px; color: var(--accent); margin-bottom: 20px; }
.workspace-ai > .glyph:first-child { width: 24px; height: 24px; }
.workspace-ai h2 { font-size: 18px; line-height: 27px; margin: 14px 0 8px; font-weight: 650; }
.workspace-ai p { font-size: 13px; line-height: 1.7; margin: 0; }
.workspace-ai > .arrow { width: 20px; height: 20px; position: absolute; right: 20px; top: 24px; }
.workspace-todos h3 { display: flex; justify-content: space-between; font-size: 13px; line-height: 20px; margin: 22px 0 10px; font-weight: 600; }
.workspace-todos h3 span { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.workspace-todos p { font-size: 13px; line-height: 20px; margin: 13px 0; color: var(--muted); }
.workspace-todos .task { display: flex; justify-content: flex-end; padding: 10px 0; line-height: 20px; }
.workspace-todos .task .glyph { width: 16px; height: 16px; }
@media (max-width: 950px) {
  .workspace-columns { grid-template-columns: 1fr; }
  .workspace-columns > aside { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .workspace-home { padding: 24px 18px; }
}
@media (max-width: 700px) {
  .app-shell { grid-template-columns: 64px minmax(0, 1fr); }
  .sidebar { padding: 12px 6px 8px; }
  .library-brand-row { justify-content: center; }
  .brand { flex: 0; padding: 0; }
  .brand > span:last-child, .library-brand-row > button, .sidebar-search span, .sidebar-search kbd, .sidebar nav > a > span, .sidebar nav > button > span:last-child { display: none; }
  .sidebar-search, .sidebar nav > a, .sidebar nav > button { justify-content: center; padding-left: 0; padding-right: 0; }
  .sidebar nav .create-plus { display: inline-flex; }
}
@media (max-width: 600px) {
  .workspace-columns > aside { grid-template-columns: 1fr; }
  .home-tabs { gap: 18px; }
}
"""


def markup():
    navigation = "".join(
        f'<a href="#" class="{"active" if label == "首页" else "assistant" if label == "AI 助手" else ""}">{icon(kind)}<span>{label}</span></a>'
        for kind, label in NAV
    )
    rows = "".join(
        f'<div><span class="file-glyph {"library" if kind == "book" else "file" if label == "文件" else ""}">{icon(kind)}</span>'
        f'<a class="recent-title" href="#" title="{html.escape(title)}"><strong>{html.escape(title)}</strong><small><span>{label}</span><span>{time}</span></small></a>'
        f'<a href="#" class="icon" aria-label="打开{html.escape(title)}">{icon("arrow")}</a></div>'
        for kind, title, label, time in RECENT
    )
    tabs = "".join(f'<button class="{"active" if label == "全部" else ""}" type="button">{label}</button>' for label in ["全部", "文档", "知识库", "文件夹", "文件"])
    return f"""
<div class="app-shell">
  <aside class="sidebar">
    <div class="library-brand-row"><a class="brand" href="#"><span class="brand-symbol">{icon('book')}</span><span>Doca</span></a><button class="icon" aria-label="收起侧边导航">{icon('panel')}</button></div>
    <button class="sidebar-search">{icon('search')}<span>搜索</span><kbd>⌘ K</kbd></button>
    <nav aria-label="主导航">
      <button class="create"><span class="create-plus">{icon('plus')}</span><span>创作</span></button>
      <button class="pinned">{icon('pin')}<span>置顶</span></button>
      {navigation}
      <a class="trash" href="#">{icon('trash')}<span>回收站</span></a>
    </nav>
  </aside>
  <main class="workspace">
    <header class="topbar"><button aria-label="工单">{icon('clipboard')}</button><button aria-label="通知">{icon('bell')}</button><button>中文</button><button class="avatar" aria-label="用户菜单">我</button></header>
    <div class="main-scroll"><section class="workspace-home">
      <header class="workspace-welcome"><div><p>10月9日星期五</p><h1>你好，管理员</h1><span>从上次停下的地方继续。</span></div><button class="icon" aria-label="刷新">{icon('refresh')}</button></header>
      <div class="workspace-columns">
        <section class="workspace-panel"><header><h2>{icon('clock')}最近访问</h2></header><div class="home-tabs">{tabs}</div><div class="workspace-recent">{rows}</div></section>
        <aside><a class="workspace-ai" href="#">{icon('sparkles')}<h2>AI 助手</h2><p>查找资料、梳理思路，让 AI 帮你继续推进工作。</p>{icon('arrow', 'arrow')}</a>
          <section class="workspace-panel workspace-todos"><header><h2>{icon('todo')}待我处理</h2></header><h3>待处理工单<span>0</span></h3><p>暂无待处理事项</p><h3>人工待办<span>1</span></h3><a class="task" href="#" aria-label="打开人工待办">{icon('arrow')}</a></section>
        </aside>
      </div>
    </section></div>
  </main>
</div>
"""


def mix(a, b, weight):
    aa = [int(a[i:i+2], 16) for i in (1, 3, 5)]
    bb = [int(b[i:i+2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x * weight + y * (1-weight)):02X}" for x, y in zip(aa, bb))


def contrast(a, b):
    def luminance(color):
        channels = [int(color[i:i+2], 16) / 255 for i in (1, 3, 5)]
        linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
        return sum(x * y for x, y in zip(linear, [.2126, .7152, .0722]))
    hi, lo = sorted([luminance(a), luminance(b)], reverse=True)
    return (hi + .05) / (lo + .05)


def readable_muted(color, backgrounds):
    """Keep the proposed muted hue readable on every proposed surface."""
    channels = [int(color[i:i+2], 16) for i in (1, 3, 5)]
    dark_surface = sum(int(backgrounds[0][i:i+2], 16) for i in (1, 3, 5)) < 384
    delta = 1 if dark_surface else -1
    while min(contrast(color, bg) for bg in backgrounds) < 4.7:
        channels = [min(255, max(0, v + delta)) for v in channels]
        color = "#" + "".join(f"{v:02X}" for v in channels)
    return color


def build():
    cfg = json.loads((ROOT / "cards.json").read_text())
    source_manifest = json.loads((OUT / "manifest.json").read_text())
    old_preview = OUT / "style-explorer.html"
    archive = OUT / "round-01-style-cards.html"
    if not archive.exists():
        archive.write_bytes(old_preview.read_bytes())
    manifest = {
        "schemaVersion": 1, "lang": "zh", "project": "Doca · 保留布局，重做视觉",
        "brief": "左侧导航、顶部工具区、最近访问列表、右侧 AI 与待办保持现有布局。五个方向只比较配色、字体、圆角和表面处理。",
        "round": "同布局视觉风格", "candidates": [source_manifest["candidates"][0]],
    }
    body = markup()
    for card in cfg["cards"]:
        c = card["colors"]
        soft = mix(c["accent"], c["bg"], .10 if card["id"] != "night-desk" else .16)
        sidebar = mix(c["accent"], c["bg"], .055)
        muted = readable_muted(c["muted"], [c["bg"], c["surface"], sidebar, soft])
        control_radius = min(card["radius"], 8)
        tokens = {
            "bg": c["bg"], "surface": c["surface"], "text": c["text"], "muted": muted,
            "accent": c["accent"], "accent-text": c["accent_text"], "line": c["line"],
            "sidebar": sidebar, "selected": soft, "control-radius": f"{control_radius}px",
            "panel-radius": f"{card['radius']}px", "panel-line": c["line"],
            "body-font": card["fonts"]["body"], "display-font": card["fonts"]["display"],
            "display-weight": card["display_weight"], "ai-bg": soft, "ai-line": c["line"],
            "doc-bg": c["accent"], "doc-ink": c["accent_text"],
            "library-bg": soft, "library-ink": c["accent"],
            "button-shadow": "none", "panel-shadow": "none",
        }
        if card["shadow"] == "soft":
            tokens["panel-shadow"] = "0 3px 12px #213E3B08"
            tokens["button-shadow"] = "0 1px 3px #213E3B0A"
        token_css = ":root {\n" + "\n".join(f"  --{k}: {v};" for k,v in tokens.items()) + "\n}"
        source = f"fixed-{card['id']}.html"
        (OUT / source).write_text(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>Doca · {html.escape(card["name"])}</title><style>{token_css}\n{CSS}</style></head><body>{body}</body></html>',
            encoding="utf-8",
        )
        manifest["candidates"].append({
            "id": card["id"], "name": card["name"], "concept": card["concept"],
            "typography": f'标题 {card["fonts"]["display"]} · 正文 {card["fonts"]["body"]} · 字号与现状一致',
            "palette": [c["bg"], c["surface"], c["text"], c["accent"]],
            "traits": ["保留现有布局", "相同控件位置与密度", *card["traits"][:3]],
            "kind": "html", "source": source,
        })
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n")
    print(f"生成 {len(cfg['cards'])} 个同布局预览；所有候选使用完全相同的 DOM 和布局 CSS。")


if __name__ == "__main__":
    build()
