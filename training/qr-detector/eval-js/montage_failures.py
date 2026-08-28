"""Contact sheet of the dumped decode failures: primary crop (a) beside the
refined-pass crop (b), captioned with category, size, and score."""

import json
from pathlib import Path

import cv2
import numpy as np

OUT = Path(__file__).parent / "failures"
meta = json.loads((OUT / "meta.json").read_text())

TILE = 240
tiles = []
for i, m in enumerate(meta):
    stem = f"{i:03d}-{m['category']}"
    pair = []
    for suffix in ("a", "b"):
        img = cv2.imread(str(OUT / f"{stem}-{suffix}.png"))
        if img is None:
            img = np.full((TILE, TILE, 3), 30, np.uint8)
        pair.append(cv2.resize(img, (TILE, TILE), interpolation=cv2.INTER_AREA))
    tile = np.hstack(pair)
    label = f"{i:03d} {m['category'][:14]} {m['sidePx']}px s{m['score']}"
    cv2.putText(tile, label, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
    cv2.putText(tile, label, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
    tiles.append(tile)

COLS = 4
while len(tiles) % COLS:
    tiles.append(np.full((TILE, TILE * 2, 3), 255, np.uint8))
rows = [np.hstack(tiles[r * COLS : (r + 1) * COLS]) for r in range(len(tiles) // COLS)]
sheet = np.vstack(rows)
# Split into pages that stay readable when viewed.
page_h = 6 * TILE
for p in range(0, sheet.shape[0], page_h):
    cv2.imwrite(str(OUT / f"_sheet-{p // page_h}.png"), sheet[p : p + page_h])
print(f"{len(meta)} failures, {int(np.ceil(sheet.shape[0] / page_h))} sheets")
