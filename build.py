"""Build the single-file app:  python build.py

Inlines src/ (HTML, CSS, JS) and data/ (reference data + example meet)
into app/XC-Meet-Manager.html, which runs offline in Edge or Chrome.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC, DATA = ROOT / 'src', ROOT / 'data'
OUT = ROOT / 'app' / 'XC-Meet-Manager.html'


def read(p):
    return p.read_text(encoding='utf-8')


def script(s):
    return s.replace('</script', '<\\/script')


def data(p):
    return json.dumps(json.loads(read(p)), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')


html = read(SRC / 'index.html')
html = html.replace('/*CSS*/', read(SRC / 'styles.css'))
html = html.replace('/*SEED*/', data(DATA / 'seed.json'))
html = html.replace('/*SAMPLE*/', data(DATA / 'sample-event.json'))
html = html.replace('/*CORE*/', script(read(SRC / 'core.js')))
html = html.replace('/*APP*/', script(read(SRC / 'app.js')))
OUT.write_text(html, encoding='utf-8')
print(f'Built {OUT.relative_to(ROOT)} ({len(html) // 1024} KB)')
