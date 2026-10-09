"""A restrained visual refinement of the existing Doca workspace, without layout changes."""

import json
import re
import runpy
from copy import deepcopy
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "style-round"
SHARED = runpy.run_path(str(ROOT / "build_fixed_styles.py"))
TOKENS = {
    "bg": "#FFFFFF", "surface": "#FFFFFF", "text": "#252A35", "muted": "#68707F",
    "accent": "#465FCE", "accent-text": "#FFFFFF", "line": "#EBEDF2",
    "sidebar": "#F5F6F8", "selected": "#EDF1F8", "control-radius": "6px",
    "panel-radius": "12px", "panel-line": "#EAECF2",
    "body-font": '"PingFang SC", "Helvetica Neue", sans-serif',
    "display-font": '"PingFang SC", "Helvetica Neue", sans-serif',
    "display-weight": "650", "ai-bg": "#F5F2FC", "ai-line": "#E7E2F3",
    "doc-bg": "transparent", "doc-ink": "#3F67D5",
    "library-bg": "transparent", "library-ink": "#7762BF",
    "button-shadow": "0 1px 2px #26304B08", "panel-shadow": "none",
}
DETAILS_CSS = """
.sidebar nav > .active {
  color: #34405C;
  background: #FFFFFF;
  box-shadow: inset 0 0 0 1px #E2E6EF, 0 1px 3px #26304B05;
}
.sidebar nav > .assistant { color: #6953AD; }
.workspace-ai { color: #6953AD; }
.home-tabs button { isolation: isolate; }
.home-tabs button:hover { background: transparent; }
.home-tabs button:before {
  content: '';
  position: absolute;
  top: 50%;
  left: -8px;
  right: -8px;
  height: 28px;
  transform: translateY(-50%);
  z-index: -1;
  border-radius: 4px;
  pointer-events: none;
}
.home-tabs button:hover:before { background: #F0F2F7; }
.home-tabs button:focus-visible { outline: none; }
.home-tabs button:focus-visible:before { outline: 2px solid #465FCE; outline-offset: 2px; }
.home-tabs .active { color: #34405C; }
.home-tabs .active:after { display: none; }
.home-tabs button.active:before { background: #EDF1F8; }
.file-glyph { background: transparent; color: #3F67D5; border-radius: 0; }
.file-glyph.library { background: transparent; color: #7762BF; }
.file-glyph.file { background: transparent; color: #6084A8; }
.file-glyph > svg.lucide-file > path:first-child,
.file-glyph > svg.lucide-file-text > path:first-child,
.file-glyph > svg.lucide-book-open > path:last-child {
  fill: currentColor;
  fill-opacity: 0.12;
}
"""


def icon_shapes():
    return json.loads((ROOT / 'icon-shapes.json').read_text())


def tinted_paths(kind):
    root = ET.fromstring(icon_shapes()[kind])
    children = [deepcopy(child) for child in root]
    ns = '{http://www.w3.org/2000/svg}'
    paths = [child for child in children if child.tag == ns+'path']
    fill_target = paths[-1] if kind == 'library' else paths[1] if kind == 'presentation' else paths[0] if kind != 'spreadsheet' else None
    for child in children:
        if child.tag == ns+'rect' or child is fill_target:
            child.set('fill', 'currentColor')
            child.set('fill-opacity', '0.12')
    return children


def preview_markup():
    shapes = icon_shapes()
    def replace(match):
        kind = 'library' if match.group('kind') == 'library' else 'file' if match.group('kind') == 'file' else 'rich_text'
        glyph = shapes[kind].replace('class="lucide ', 'class="glyph lucide ')
        return match.group(1) + glyph + match.group(3)
    return re.sub(r'(<span class="file-glyph (?P<kind>[^\"]*)">)<svg.*?</svg>(</span>)', replace, SHARED['markup'](), flags=re.S)


def create_svg():
    """Generate a vector design board from the shared geometry, not an HTML screenshot."""
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    doc = ET.parse(OUT / "black-white-design.svg")
    svg = doc.getroot()
    ns = '{http://www.w3.org/2000/svg}'
    for element in list(svg):
        tag = element.tag.removeprefix(ns)
        if tag == 'title':
            element.text = 'Doca 现有风格精修 · 静态效果稿'
        elif tag == 'desc':
            element.text = '保留现有布局、白灰底色与彩色文档图标，微调导航选中态、页签和边框。'
        elif tag == 'rect':
            x, y = float(element.get('x')), float(element.get('y'))
            if x == 0 and float(element.get('width')) == 254:
                element.set('fill', TOKENS['sidebar'])
            elif x == 16 and y == 12:
                element.set('fill', TOKENS['accent'])
            elif x == 12 and y == 52:
                element.set('fill', '#FFFFFF')
                element.set('stroke', '#E2E6EF')
            elif x == 10 and y in (106, 156):
                element.set('fill', '#FFFFFF')
                element.set('stroke', '#E2E6EF')
                element.set('stroke-width', '1')
            elif x == 22 and y == 115:
                element.set('fill', TOKENS['accent'])
            elif x == 10 and y == 210:
                element.set('fill', '#FFFFFF')
                element.set('stroke', '#E2E6EF')
                element.set('stroke-width', '1')
            elif x == 310 and y == 313:
                element.set('x', '302')
                element.set('y', '280')
                element.set('width', '44')
                element.set('height', '28')
                element.set('rx', '4')
                element.set('fill', TOKENS['selected'])
            elif x == 310 and y >= 337:
                svg.remove(element)
            elif x == 290:
                element.set('rx', '12')
                element.set('stroke', TOKENS['panel-line'])
            elif x == 1104 and y == 209:
                element.set('fill', TOKENS['ai-bg'])
                element.set('stroke', TOKENS['ai-line'])
                element.set('rx', '12')
            elif x == 1104 and y == 402:
                element.set('stroke', TOKENS['panel-line'])
                element.set('rx', '12')
        elif tag == 'text':
            x, y = float(element.get('x')), float(element.get('y'))
            old = element.get('fill')
            if x < 254:
                color = '#34405C' if y == 236 else '#6953AD' if y == 280 else TOKENS['text'] if y in (32,132,182) else TOKENS['muted']
            elif x >= 1104 and 209 <= y < 382:
                color = '#6953AD'
            else:
                color = TOKENS['muted'] if old == '#686868' else TOKENS['text']
            element.set('fill', color)
        elif tag == 'g':
            match = re.search(r'translate\(([\d.]+) ([\d.]+)\)', element.get('transform',''))
            if not match:
                continue
            x,y = map(float,match.groups())
            old = element.get('stroke')
            if x < 254:
                color = '#FFFFFF' if (x,y) in ((21,17),(26,119)) else TOKENS['accent'] if (x,y)==(22,167) else '#34405C' if y==221 else '#6953AD' if y==265 else TOKENS['muted']
            elif x == 315 and y >= 343:
                index = round((y-343)/75)
                kind = 'library' if index in (4,5) else 'file' if index == 6 else 'rich_text'
                color = '#7762BF' if kind=='library' else '#6084A8' if kind=='file' else '#3F67D5'
                for child in list(element):
                    element.remove(child)
                for child in tinted_paths(kind):
                    element.append(child)
                element.set('color',color)
            elif x >= 1104 and 209 <= y < 382:
                color = '#6953AD'
            else:
                color = TOKENS['muted'] if old=='#686868' else TOKENS['text']
            element.set('stroke',color)
        elif tag == 'path' and element.get('stroke'):
            element.set('stroke', '#E2E6EF' if element.get('stroke')=='#343434' else TOKENS['line'])
        elif tag == 'circle':
            element.set('fill', TOKENS['selected'])

    # Place the selected-tab background behind the tab text.
    selected = next(e for e in svg if e.tag==ns+'rect' and e.get('x')=='302' and e.get('y')=='280')
    first_tab = next(e for e in svg if e.tag==ns+'text' and e.text=='全部')
    svg.remove(selected)
    svg.insert(list(svg).index(first_tab), selected)
    doc.write(OUT / 'baseline-refined-design.svg', encoding='utf-8', xml_declaration=True)


def create_icon_detail():
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ns = '{http://www.w3.org/2000/svg}'
    svg = ET.Element(ns+'svg',width='760',height='132',viewBox='0 0 760 132')
    ET.SubElement(svg,ns+'rect',width='760',height='132',fill='#FFFFFF')
    types = [
        ('rich_text','文档','#3F67D5'), ('spreadsheet','表格','#24865A'),
        ('presentation','幻灯片','#BF6B20'), ('markdown','Markdown','#7950B8'),
        ('canvas','画布','#AB7A21'), ('library','知识库','#7762BF'),
    ]
    for index,(kind,label,color) in enumerate(types):
        center = 80+index*120
        group = ET.SubElement(svg,ns+'g',transform=f'translate({center-20} 26) scale({40/24})',fill='none',stroke=color,color=color,
                              **{'stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'})
        for child in tinted_paths(kind):
            group.append(child)
        text = ET.SubElement(svg,ns+'text',x=str(center),y='103',fill='#68707F',
                             **{'text-anchor':'middle','font-size':'14','font-family':'PingFang SC,Arial Unicode MS,sans-serif'})
        text.text = label
    ET.ElementTree(svg).write(OUT/'document-icon-detail.svg',encoding='utf-8',xml_declaration=True)


def build():
    token_css = ':root {\n' + '\n'.join(f'  --{key}: {value};' for key,value in TOKENS.items()) + '\n}'
    doc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    doc += f'<title>Doca · 现有风格精修</title><style>{token_css}\n{SHARED["CSS"]}\n{DETAILS_CSS}</style></head><body>{preview_markup()}</body></html>'
    (OUT / 'fixed-baseline-refined.html').write_text(doc, encoding='utf-8')
    create_svg()
    create_icon_detail()
    for current, archive in [('style-explorer.html','round-03-black-white.html'), ('manifest.json','round-03-black-white-manifest.json')]:
        dest = OUT/archive
        if not dest.exists():
            dest.write_bytes((OUT/current).read_bytes())
    manifest = {
        'schemaVersion':1, 'lang':'zh', 'project':'Doca · 现有风格精修',
        'brief':'保留布局与现有风格；文档图标去掉外部大色块，只在图标自身形状内带浅色底。',
        'round':'现有风格精修样张',
        'candidates':[{
            'id':'baseline-refined','name':'现有风格 · 轻量精修',
            'concept':'延续现有页面的轻快感与清晰层次，让细节成为 Doca 的识别。',
            'typography':'保留系统黑体、字号和密度；26px 问候标题、14px 列表',
            'palette':['#FFFFFF','#F5F6F8','#465FCE','#8270C9'],
            'traits':['保持现有布局','白底导航选中态','柔和页签选择','图标自身带底色，无外部色块'],
            'kind':'html','source':'fixed-baseline-refined.html'
        }]
    }
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print('已生成现有风格精修的单个 HTML 样张与静态 SVG 效果稿。')


if __name__ == '__main__':
    build()
