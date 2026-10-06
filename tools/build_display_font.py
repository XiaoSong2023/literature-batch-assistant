#!/usr/bin/env python3
"""Subset Noto Serif SC into the small display font used by the dashboard.

Only glyphs that appear in display elements (titles, seal, numbers) are kept, so
the extension ships a few dozen kilobytes instead of a 25 MB CJK font. Text in
other elements falls back to the system UI font. Re-run after changing any
heading, the seal or a confirmation-dialog title:

    python tools/build_display_font.py [--source path/to/NotoSerifSC-VF.ttf]

Noto Serif SC is licensed under the SIL Open Font License 1.1. The subset is
renamed "Wenxian Serif" because modified versions should not reuse the
original font name.
"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
import re

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / 'extension'
OUTPUT = EXTENSION / 'fonts' / 'wenxian-serif.woff2'
DISPLAY_CLASSES = {'display', 'seal-text', 'kicker', 'eyebrow', 'step-no', 'stat-value', 'progress-percent', 'nav-meter-label'}
DISPLAY_TAGS = {'h1', 'h2', 'h3'}
# Digits, Latin labels and punctuation used by counters, percentages and version text.
ALWAYS = ''.join(chr(c) for c in range(0x20, 0x7f)) + '·—–%「」“”‘’、，。：；（）！？…'
FAMILY = 'Wenxian Serif'


class DisplayText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.stack: list[bool] = []
        self.text: list[str] = []

    def handle_starttag(self, tag, attrs):
        classes = set((dict(attrs).get('class') or '').split())
        display = tag in DISPLAY_TAGS or bool(classes & DISPLAY_CLASSES)
        if tag in {'br', 'img', 'input', 'link', 'meta', 'use', 'path', 'circle', 'rect', 'stop'}:
            return
        self.stack.append(display)
        self.depth += display

    def handle_endtag(self, tag):
        if self.stack and tag not in {'br', 'img', 'input', 'link', 'meta', 'use', 'path', 'circle', 'rect', 'stop'}:
            self.depth -= self.stack.pop()

    def handle_data(self, data):
        if self.depth > 0:
            self.text.append(data)


def collect_text() -> str:
    parser = DisplayText()
    parser.feed((EXTENSION / 'dashboard.html').read_text(encoding='utf-8'))
    text = ''.join(parser.text)
    # Dialog titles are set from script: confirmAction({title: '…'}).
    for name in ['dashboard.js', 'cleanup-ui.js', 'ui-effects.js']:
        path = EXTENSION / name
        if path.exists():
            text += ''.join(re.findall(r"title\s*:\s*['\"`]([^'\"`]+)['\"`]", path.read_text(encoding='utf-8')))
    return text + ALWAYS


def rename(font: TTFont) -> None:
    names = {1: FAMILY, 2: 'Regular', 3: f'{FAMILY} Subset', 4: FAMILY, 6: 'WenxianSerif', 16: FAMILY, 17: 'Regular'}
    table = font['name']
    for record in list(table.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17, 25):
            table.removeNames(nameID=record.nameID)
    for name_id, value in names.items():
        table.setName(value, name_id, 3, 1, 0x409)
        table.setName(value, name_id, 1, 0, 0)
    if 'STAT' in font:
        # Axis value labels still describe weights; only family names change.
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default='C:/Windows/Fonts/NotoSerifSC-VF.ttf',
                        help='Noto Serif SC variable TTF (Windows 11 ships it; also on github.com/notofonts/noto-cjk)')
    args = parser.parse_args()
    text = collect_text()
    font = TTFont(args.source)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['kern', 'liga', 'tnum', 'pnum', 'locl', 'vert', 'vrt2']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    options.hinting = False
    options.desubroutinize = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    rename(font)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(OUTPUT)
    chars = sorted({c for c in text if ord(c) > 0x7f})
    print(f'{OUTPUT.relative_to(ROOT)}: {OUTPUT.stat().st_size} bytes, {len(chars)} non-ASCII characters')
    print(''.join(chars))


if __name__ == '__main__':
    main()
