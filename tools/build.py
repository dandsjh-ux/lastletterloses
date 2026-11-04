#!/usr/bin/env python3
"""Builds public/index.html from src/game.src.html (inlines the font, the dictionary and shared/rules.js).
Run from anywhere:  python3 tools/build.py"""
import os, re, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda *p: open(os.path.join(root, *p), encoding='utf-8').read()
src = rd('src', 'game.src.html')
src = src.replace('__FONT__', rd('assets', 'font.b64').strip())
src = src.replace('__DICT__', rd('assets', 'dict.b64').strip())
src = src.replace('__RULES__', rd('shared', 'rules.js'))
out = os.path.join(root, 'public', 'index.html')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(src)
print('built public/index.html', len(src), 'bytes')
if '--check' in sys.argv:
    os.makedirs('/tmp/lll_scripts', exist_ok=True)
    for i, sc in enumerate(re.findall(r'<script>(.*?)</script>', src, re.S)):
        open('/tmp/lll_scripts/s%d.js' % i, 'w', encoding='utf-8').write(sc)
