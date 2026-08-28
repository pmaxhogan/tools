"""One-time: decode every background photo into a single memory-mapped uint8
array (N, 560, 560, 3, RGB). Workers then random-crop from the memmap instead
of paying a JPEG decode per sample; the OS page cache shares the bytes across
all DataLoader processes.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm

SIDE = 560
ROOT = Path(__file__).parent
SRC = ROOT / "data" / "backgrounds" / "val2017"
OUT = ROOT / "data" / "backgrounds" / f"bg{SIDE}.npy"


def main() -> None:
    paths = sorted(SRC.glob("*.jpg"))
    if not paths:
        raise SystemExit(f"no backgrounds in {SRC}")
    arr = np.lib.format.open_memmap(OUT, mode="w+", dtype=np.uint8, shape=(len(paths), SIDE, SIDE, 3))
    kept = 0
    for path in tqdm(paths, unit="img"):
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            continue
        h, w = img.shape[:2]
        s = SIDE / min(h, w)
        img = cv2.resize(img, (max(SIDE, int(w * s)), max(SIDE, int(h * s))), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        y = (h - SIDE) // 2
        x = (w - SIDE) // 2
        arr[kept] = cv2.cvtColor(img[y : y + SIDE, x : x + SIDE], cv2.COLOR_BGR2RGB)
        kept += 1
    arr.flush()
    if kept != len(paths):
        # Rewrite trimmed so no black frames remain at the tail.
        trimmed = np.lib.format.open_memmap(
            OUT.with_suffix(".tmp.npy"), mode="w+", dtype=np.uint8, shape=(kept, SIDE, SIDE, 3)
        )
        trimmed[:] = arr[:kept]
        trimmed.flush()
        del arr, trimmed
        OUT.unlink()
        OUT.with_suffix(".tmp.npy").rename(OUT)
    print(f"staged {kept} backgrounds into {OUT}")


if __name__ == "__main__":
    main()
