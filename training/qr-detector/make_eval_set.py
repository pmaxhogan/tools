"""Export the held-out evaluation sets as PNGs plus ground-truth JSONL.

Two sets, both with seed bases disjoint from training (1e9) and from the
quick-val slice (3e9):
  eval/hard       base 2_000_000_000, shifted-harder ranges (EVAL_HARD)
  eval/liketrain  base 4_000_000_000, training-distribution ranges

The JS harness (eval-js/run.mjs) consumes these to score jsQR, zxing, and the
deep-scan pipeline against the same ground truth.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
from tqdm import tqdm

from synth import EVAL_HARD, EVAL_LIKE_TRAIN, LOOKALIKE, BackgroundPool, generate_scene

ROOT = Path(__file__).parent
BACKGROUNDS = ROOT / "data" / "backgrounds" / "val2017"

SETS = [
    ("hard", 2_000_000_000, EVAL_HARD, 800),
    ("liketrain", 4_000_000_000, EVAL_LIKE_TRAIN, 400),
    # Field-failure lookalikes: metal plates, glare bands, off-center tilted
    # wraps, zoomed screenshots, captions against the code.
    ("lookalike", 5_000_000_000, LOOKALIKE, 400),
]


def main() -> None:
    pool = BackgroundPool(BACKGROUNDS)
    for name, base, diff, count in SETS:
        out = ROOT / "data" / "eval" / name
        out.mkdir(parents=True, exist_ok=True)
        rows = []
        for i in tqdm(range(count), desc=name, unit="img"):
            scene = generate_scene(i, base, diff, pool)
            cv2.imwrite(
                str(out / f"{i:05d}.png"), cv2.cvtColor(scene.image, cv2.COLOR_RGB2BGR)
            )
            rows.append(
                {
                    "index": i,
                    "blur_sigma": round(scene.blur_sigma, 3),
                    "noise_std": round(scene.noise_std, 4),
                    "jpeg_q": scene.jpeg_q,
                    "codes": [
                        {
                            "payload": c.payload,
                            "points": [[round(float(x), 2), round(float(y), 2)] for x, y in c.points],
                            "side_px": round(c.side_px, 1),
                            "n_modules": c.n_modules,
                            "ecc": c.ecc,
                            "logo_frac": round(c.logo_frac, 4),
                            "cylinder": c.cylinder,
                            "occluded": c.occluded,
                        }
                        for c in scene.codes
                    ],
                }
            )
        with (out / "gt.jsonl").open("w", encoding="utf8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        n_codes = sum(len(r["codes"]) for r in rows)
        print(f"{name}: {count} images, {n_codes} codes -> {out}")


if __name__ == "__main__":
    main()
