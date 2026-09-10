"""Build a standalone UTF-8 guide from the maintained skill references.

Run with the TextGen environment (requires Python-Markdown).
"""
from pathlib import Path
import html
import re
import markdown

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'skills' / 'app-keyboard-workflows' / 'references'
OUTPUT = ROOT / 'guidebooks'
CHAPTERS = [
    'navigation-and-recovery', 'office-common', 'word', 'excel',
    'powerpoint', 'outlook', 'onenote', 'access',
    'vscode', 'firefox', 'qq', 'altium',
]
TITLE = 'Windows 应用键盘操作指南'
INTRO = ('Office · QQ · VS Code · Firefox · Altium Designer。'
         '按应用、焦点和任务查找快捷键；包含命令入口、操作流程、结果检查与故障恢复。')
STATUS = ('版本 2026-09-09 · Windows 桌面版为主。Microsoft 与 Altium 章节核对官方资料；'
          'Firefox 官方页面本次返回验证页，QQ 按版本与本机设置确认。'
          '这是默认键位与工作流指南，不代表所有应用、插件和自定义键位已逐项实机测试。')

STYLE = '''
:root {color-scheme: light; --ink:#172c3d; --muted:#50677a; --line:#d5e0e7; --accent:#006878}
* {box-sizing:border-box} html {scroll-behavior:smooth;scroll-padding-top:1rem}
body {margin:0;background:#f3f6f8;color:var(--ink);font:16px/1.75 "Segoe UI","Microsoft YaHei",sans-serif}
a {color:var(--accent)} header {background:#122f40;color:white;padding:3rem max(2rem,calc((100% - 1300px)/2))}
header h1 {font-size:2.5rem;line-height:1.3;margin:0 0 1rem} header p {max-width:85ch}
.badge {font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:#8dd7dc}
.layout {max-width:1400px;margin:auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:2rem;padding:2rem}
aside {position:sticky;top:1rem;align-self:start;max-height:95vh;overflow:auto}
nav a {display:block;padding:.3rem .6rem;text-decoration:none;border-radius:4px}
nav a:hover,nav a:focus {background:#dceef0} label {font-weight:700} input {width:100%;font:inherit;padding:.6rem;border:1px solid #869eac;border-radius:6px;margin:.5rem 0}
button {font:inherit;border:1px solid #869eac;border-radius:5px;background:white;padding:.35rem .65rem;cursor:pointer;margin:.3rem .2rem .3rem 0}
.hint,#count {font-size:.85rem;color:var(--muted)} article {background:white;padding:2rem;margin-bottom:2rem;border:1px solid var(--line);border-radius:10px;overflow-wrap:anywhere}
h2 {font-size:1.8rem;border-bottom:3px solid #178899;padding-bottom:.6rem;line-height:1.4}
h3 {margin-top:2rem;font-size:1.25rem} .table-wrap {overflow-x:auto;margin:1rem 0}
table {border-collapse:collapse;width:100%;font-size:.92rem} th,td {border:1px solid var(--line);padding:.65rem .8rem;text-align:left;vertical-align:top}
th {background:#e7f0f3} tr:nth-child(even) {background:#f8fafb} code {font:.88em/1.5 Consolas,monospace;background:#edf2f5;padding:.12rem .3rem;border-radius:3px}
[hidden] {display:none!important} .toplink {font-size:.85rem} :focus-visible {outline:3px solid #b66000;outline-offset:3px}
@media(max-width:850px){.layout{display:block;padding:1rem}aside{position:static;max-height:none;margin-bottom:1rem}nav{columns:2}article{padding:1rem}header{padding:2rem 1rem}header h1{font-size:2rem}}
@media print {@page{size:A4;margin:15mm} body{background:white;font:10pt/1.5 "Microsoft YaHei",sans-serif}header{background:white;color:black;padding:0}.badge{color:#333}.layout{display:block;padding:0}aside,.toplink{display:none}article{display:block!important;border:0;border-radius:0;padding:0;margin:0;break-before:page}.table-wrap{overflow:visible}th,td{padding:4pt}tr{break-inside:avoid}thead{display:table-header-group}h2,h3{break-after:avoid}a{color:inherit;text-decoration:none}code{white-space:normal}header h1{font-size:23pt}}
'''
STYLE += '\n@media print { article[hidden] { display:block!important } }\n'

SCRIPT = '''
const box=document.getElementById('search');
const chapters=[...document.querySelectorAll('article')];
const links=[...document.querySelectorAll('nav a')];
function filter(){
 const terms=box.value.trim().toLocaleLowerCase().split(/\\s+/).filter(Boolean);
 let count=0;
 chapters.forEach((chapter,i)=>{
  const visible=terms.every(term=>chapter.textContent.toLocaleLowerCase().includes(term));
  chapter.hidden=!visible; links[i].hidden=!visible; count+=visible?1:0;
 });
 document.getElementById('count').textContent=`显示 ${count} / ${chapters.length} 章`;
}
box.addEventListener('input',filter);
document.getElementById('clear').addEventListener('click',()=>{box.value='';filter();box.focus()});
document.getElementById('print').addEventListener('click',()=>window.print());
document.querySelector('main').addEventListener('click',event=>{
 const anchor=event.target.closest('a[href^="#"]');
 if(anchor){box.value='';filter()}
});
filter();
'''

def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    nav, sections, combined = [], [], []
    for slug in CHAPTERS:
        text = (SOURCE / (slug + '.md')).read_text(encoding='utf-8')
        heading = text.splitlines()[0].removeprefix('# ')
        text = re.sub(r'\]\(([-\w]+)\.md\)', r'](#\1)', text)
        # Shift headings so the guide has one H1; chapter anchors are unique.
        text = re.sub(r'^(#{1,5}) ', r'#\1 ', text, flags=re.M)
        rendered = markdown.markdown(text, extensions=['tables', 'fenced_code'])
        rendered = rendered.replace('<table>', '<div class="table-wrap"><table>').replace('</table>', '</table></div>')
        nav.append(f'<a href="#{slug}">{html.escape(heading)}</a>')
        sections.append(f'<article id="{slug}">{rendered}<a class="toplink" href="#top">返回目录 ↑</a></article>')
        combined.append(f'<a id="{slug}"></a>\n\n{text}')

    document = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{TITLE}</title><style>{STYLE}</style></head><body>
<header id="top"><div class="badge">Keyboard Field Guide · 10 Applications</div><h1>{TITLE}</h1><p>{INTRO}</p><p>{STATUS}</p></header>
<div class="layout"><aside aria-label="指南目录"><label for="search">搜索章节</label>
<input id="search" type="search" placeholder="例如：Excel 公式 / Ctrl+F" autocomplete="off">
<div id="count" role="status" aria-live="polite"></div><button id="clear" type="button">显示全部</button><button id="print" type="button">打印 / 保存 PDF</button>
<p class="hint">输入关键词筛选章节；Ctrl+F 在可见正文中定位。打印包含全部章节。</p>
<nav>{''.join(nav)}</nav></aside><main>{''.join(sections)}</main></div><script>{SCRIPT}</script></body></html>'''
    (OUTPUT / 'application-keyboard-guidebook.html').write_text(document, encoding='utf-8')
    toc = '\n'.join(f'- [{(SOURCE / (slug + ".md")).read_text(encoding="utf-8").splitlines()[0][2:]}](#{slug})' for slug in CHAPTERS)
    (OUTPUT / 'application-keyboard-guidebook.md').write_text(
        f'# {TITLE}\n\n{INTRO}\n\n{STATUS}\n\n## 目录\n\n{toc}\n\n' + '\n\n'.join(combined), encoding='utf-8')
    print(f'Built {len(CHAPTERS)} chapters in {OUTPUT}')

if __name__ == '__main__':
    build()
