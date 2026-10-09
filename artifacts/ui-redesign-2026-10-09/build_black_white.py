"""Create one fixed-layout HTML preview and a non-browser SVG design board."""

import html
import json
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "style-round"
SHARED = runpy.run_path(str(ROOT / "build_fixed_styles.py"))

TOKENS = {
    "bg": "#FFFFFF", "surface": "#FFFFFF", "text": "#242424", "muted": "#686868",
    "accent": "#242424", "accent-text": "#FFFFFF", "line": "#E9E9E9",
    "sidebar": "#151515", "selected": "#F3F3F3", "control-radius": "6px",
    "panel-radius": "8px", "panel-line": "#E7E7E7",
    "body-font": '"PingFang SC", "Helvetica Neue", sans-serif',
    "display-font": '"Helvetica Neue", "PingFang SC", sans-serif',
    "display-weight": "650", "ai-bg": "#F5F5F5", "ai-line": "#E7E7E7",
    "doc-bg": "#F1F1F1", "doc-ink": "#343434",
    "library-bg": "#F1F1F1", "library-ink": "#343434",
    "button-shadow": "none", "panel-shadow": "none",
}

SIDEBAR_CSS = """
.sidebar {
  --text: #F5F5F5;
  --muted: #B8B8B8;
  --accent: #F5F5F5;
  --accent-text: #151515;
  --surface: #202020;
  --line: #343434;
  --selected: #2D2D2D;
  color: var(--text);
}
.sidebar nav > .create { background: #F2F2F2; color: #1C1C1C; border-color: #F2F2F2; }
.sidebar .create-plus { background: #242424; color: #FFFFFF; }
"""


def create_svg():
    """Draw a static design illustration; this does not execute or screenshot HTML."""
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">',
             '<title>Doca 左黑右白工作台 · 静态效果稿</title>',
             '<desc>采用现有工作台布局，左侧 254 像素黑色导航，右侧白色内容区。</desc>']

    def rect(x, y, w, h, fill, radius=0, stroke=None):
        extra = f' stroke="{stroke}" stroke-width="1"' if stroke else ""
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}"{extra}/>')

    def text(x, y, value, size=14, color="#242424", weight=400):
        parts.append(f'<text x="{x}" y="{y}" fill="{color}" font-family="PingFang SC,Arial Unicode MS,sans-serif" font-size="{size}" font-weight="{weight}">{html.escape(value)}</text>')

    def glyph(name, x, y, size=18, color="#242424"):
        scale = size/24
        paths = SHARED["ICONS"][name]
        parts.append(f'<g transform="translate({x} {y}) scale({scale})" fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{paths}</g>')

    def line(x1, y1, x2, y2, color="#E9E9E9"):
        parts.append(f'<path d="M{x1} {y1}H{x2}" stroke="{color}"/>' if y1 == y2 else f'<path d="M{x1} {y1}L{x2} {y2}" stroke="{color}"/>')

    rect(0, 0, 1440, 900, "#FFFFFF")
    rect(0, 0, 254, 900, "#151515")
    rect(16, 12, 28, 28, "#F5F5F5", 6)
    glyph("book", 21, 17, 18, "#151515")
    text(52, 32, "Doca", 16, "#F5F5F5", 650)
    glyph("panel", 220, 17, 16, "#B8B8B8")
    rect(12, 52, 230, 38, "#202020", 6, "#343434")
    glyph("search", 22, 62, 17, "#B8B8B8")
    text(47, 77, "搜索", 14, "#B8B8B8")
    text(207, 76, "⌘ K", 10, "#B8B8B8")
    rect(10, 106, 234, 40, "#F2F2F2", 6)
    rect(22, 115, 22, 22, "#242424", 6)
    glyph("plus", 26, 119, 14, "#FFFFFF")
    text(54, 132, "创作", 15, "#1C1C1C", 600)
    rect(10, 156, 234, 40, "#202020", 6, "#343434")
    glyph("pin", 22, 167, 18, "#F5F5F5")
    text(50, 182, "置顶", 15, "#F5F5F5", 600)
    y = 210
    for index, (name, label) in enumerate(SHARED["NAV"]):
        color = "#F5F5F5" if index in (0, 1) else "#B8B8B8"
        if index == 0:
            rect(10, y, 234, 40, "#2D2D2D", 6)
        glyph(name, 22, y+11, 18, color)
        text(50, y+26, label, 15, color, 600 if index in (0, 1) else 500)
        y += 44
    line(10, 566, 244, 566, "#343434")
    glyph("trash", 22, 586, 18, "#B8B8B8")
    text(50, 601, "回收站", 15, "#B8B8B8", 500)

    glyph("clipboard", 1259, 18, 20)
    glyph("bell", 1297, 18, 20)
    text(1335, 34, "中文", 14)
    parts.append('<circle cx="1407" cy="28" r="17" fill="#F3F3F3"/>')
    text(1400, 34, "我", 14, "#242424", 600)
    text(290, 104, "10月9日星期五", 13, "#686868")
    text(290, 145, "你好，管理员", 26, "#242424", 650)
    text(290, 178, "从上次停下的地方继续。", 14, "#686868")
    glyph("refresh", 1376, 126, 18, "#686868")

    panel_x, panel_y, panel_w = 290, 209, 790
    rect(panel_x, panel_y, panel_w, 659, "#FFFFFF", 8, "#E7E7E7")
    glyph("clock", 310, 232, 18)
    text(337, 249, "最近访问", 16, "#242424", 600)
    tab_x = 310
    for label in ["全部", "文档", "知识库", "文件夹", "文件"]:
        text(tab_x, 298, label, 14, "#242424" if label == "全部" else "#686868", 600 if label == "全部" else 400)
        if label == "全部":
            rect(tab_x, 313, 28, 3, "#242424", 1)
        tab_x += len(label)*14+28
    line(310, 316, 1060, 316)
    row_y = 316
    for kind, title, label, timestamp in SHARED["RECENT"]:
        rect(310, row_y+21, 30, 32, "#F1F1F1", 6)
        glyph(kind, 315, row_y+27, 20, "#343434")
        text(352, row_y+35, title, 14, "#242424", 500)
        text(352, row_y+59, label, 12, "#686868")
        text(352+len(label)*12+10, row_y+59, timestamp, 12, "#686868")
        glyph("arrow", 1038, row_y+30, 16, "#686868")
        line(310, row_y+75, 1060, row_y+75)
        row_y += 75

    right = 1104
    rect(right, 209, 300, 173, "#F5F5F5", 8, "#E7E7E7")
    glyph("sparkles", right+22, 231, 24)
    glyph("arrow", right+260, 233, 20)
    text(right+22, 287, "AI 助手", 18, "#242424", 650)
    text(right+22, 321, "查找资料、梳理思路，让 AI 帮你继续", 13)
    text(right+22, 343, "推进工作。", 13)
    rect(right, 402, 300, 244, "#FFFFFF", 8, "#E7E7E7")
    glyph("todo", right+20, 425, 18)
    text(right+47, 442, "待我处理", 16, "#242424", 600)
    text(right+20, 490, "待处理工单", 13, "#242424", 600)
    text(right+273, 490, "0", 13, "#686868")
    text(right+20, 522, "暂无待处理事项", 13, "#686868")
    text(right+20, 570, "人工待办", 13, "#242424", 600)
    text(right+273, 570, "1", 13, "#686868")
    glyph("arrow", right+264, 602, 16)
    parts.append('</svg>')
    (OUT / "black-white-design.svg").write_text("\n".join(parts), encoding="utf-8")


def build():
    token_css = ":root {\n" + "\n".join(f"  --{key}: {value};" for key, value in TOKENS.items()) + "\n}"
    doc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    doc += f'<title>Doca · 左黑右白</title><style>{token_css}\n{SHARED["CSS"]}\n{SIDEBAR_CSS}</style></head><body>{SHARED["markup"]()}</body></html>'
    (OUT / "fixed-black-white.html").write_text(doc, encoding="utf-8")
    create_svg()
    for current, archive in (("style-explorer.html", "round-02-fixed-styles.html"), ("manifest.json", "round-02-fixed-styles-manifest.json")):
        archive_path = OUT / archive
        if not archive_path.exists():
            archive_path.write_bytes((OUT / current).read_bytes())
    manifest = {
        "schemaVersion": 1, "lang": "zh", "project": "Doca · 左黑右白",
        "brief": "保留现有布局：左侧黑色导航，右侧白色工作区；只看这一个方向。",
        "round": "左黑右白样张",
        "candidates": [{
            "id": "black-white", "name": "黑白工作台",
            "concept": "黑色导航把工具收在左边，白色内容区承托阅读与工作。",
            "typography": "原有字号与密度，系统无衬线字体，26px 问候标题",
            "palette": ["#151515", "#FFFFFF", "#242424", "#F5F5F5"],
            "traits": ["保留现有布局", "黑色左侧导航", "白色内容区", "灰阶图标与状态"],
            "kind": "html", "source": "fixed-black-white.html"
        }]
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n")
    print("已生成左黑右白单个 HTML 样张与 SVG 静态效果稿。")


if __name__ == "__main__":
    build()
