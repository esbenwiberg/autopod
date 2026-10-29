#!/usr/bin/env python3
"""Regenerate the macOS icon catalog: python3 scripts/generate-desktop-icon.py.

Requires Pillow (python3 -m pip install Pillow). The transparent brand mark stays
unchanged; only the desktop tile uses the redesign's emerald accent.
"""

import json
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'packages/desktop/Autopod/Assets.xcassets/AppIcon.appiconset'
BACKGROUND = '#277D68'  # DesktopTheme.accent (light appearance)
MASTER_SIZE = 1024
MARK_SIZE = 900  # Breathing room so the green surround reads at Dock sizes.


def main():
    with Image.open(ROOT / 'assets/icon.png') as source:
        mark = ImageOps.contain(
            source.convert('RGBA'), (MARK_SIZE, MARK_SIZE), Image.Resampling.LANCZOS
        )
    master = Image.new('RGBA', (MASTER_SIZE, MASTER_SIZE), BACKGROUND)
    master.alpha_composite(
        mark, ((MASTER_SIZE - mark.width) // 2, (MASTER_SIZE - mark.height) // 2)
    )

    catalog = json.loads((CATALOG / 'Contents.json').read_text())
    for filename in sorted({entry['filename'] for entry in catalog['images']}):
        size = int(filename.removeprefix('icon_').split('x')[0])
        master.resize((size, size), Image.Resampling.LANCZOS).save(CATALOG / filename)
        print(f'{CATALOG.relative_to(ROOT) / filename}: {size}×{size}')


if __name__ == '__main__':
    main()
