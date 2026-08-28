"""Torch dataset over the synthetic scene generator, plus target encoding and
the numpy reference decoder (the TypeScript port must match this exactly)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

from synth import IMG_SIZE, BackgroundPool, Difficulty, Scene, generate_scene

STRIDE = 4
OUT = IMG_SIZE // STRIDE  # 128


def gaussian_radius(side_out: float) -> float:
    """Splat radius for a code of the given side length in output cells."""
    return max(1.0, side_out * 0.18)


def encode_targets(scene: Scene) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Heatmap (1,OUT,OUT), offsets (16,OUT,OUT), mask (1,OUT,OUT).

    Offsets are the 8 ground-truth points (4 corners then 4 edge midpoints)
    in output-grid units relative to the cell origin: off[2k] =
    point_k.x/STRIDE - cell_x (same for y). Supervised on the center cell and
    its 4-neighborhood. The peak location comes from the corner centroid.
    """
    hm = np.zeros((1, OUT, OUT), dtype=np.float32)
    off = np.zeros((16, OUT, OUT), dtype=np.float32)
    mask = np.zeros((1, OUT, OUT), dtype=np.float32)

    for code in scene.codes:
        points_out = code.points / STRIDE  # 8x2 in grid units
        corners_out = points_out[:4]
        cx, cy = corners_out.mean(axis=0)
        if not (0 <= cx < OUT and 0 <= cy < OUT):
            continue
        side_out = float(np.linalg.norm(corners_out[0] - corners_out[2]) / np.sqrt(2))
        r = gaussian_radius(side_out)
        # Gaussian splat.
        x0, x1 = max(0, int(cx - 3 * r)), min(OUT, int(cx + 3 * r) + 1)
        y0, y1 = max(0, int(cy - 3 * r)), min(OUT, int(cy + 3 * r) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        g = np.exp(-(((xs - cx) ** 2 + (ys - cy) ** 2) / (2 * (r / 1.5) ** 2)))
        hm[0, y0:y1, x0:x1] = np.maximum(hm[0, y0:y1, x0:x1], g)

        icx, icy = int(cx), int(cy)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                gx, gy = icx + dx, icy + dy
                if not (0 <= gx < OUT and 0 <= gy < OUT):
                    continue
                hm[0, gy, gx] = max(hm[0, gy, gx], 1.0 if (dx == 0 and dy == 0) else hm[0, gy, gx])
                for k in range(8):
                    off[2 * k, gy, gx] = points_out[k, 0] - gx
                    off[2 * k + 1, gy, gx] = points_out[k, 1] - gy
                mask[0, gy, gx] = 1.0
    return hm, off, mask


def decode_np(
    hm_logits: np.ndarray,
    off: np.ndarray,
    *,
    threshold: float = 0.35,
    top_k: int = 8,
) -> list[dict]:
    """Reference decoder over raw head outputs (1,OUT,OUT)/(16,OUT,OUT).

    3x3 max-pool NMS on the sigmoid heatmap, then point reconstruction: 4
    corners followed by 4 edge midpoints. The TypeScript implementation in
    src/tools/qr-code-scanner/detector.ts mirrors this function; if one
    changes, the other must.
    """
    prob = 1.0 / (1.0 + np.exp(-hm_logits[0]))
    h, w = prob.shape
    padded = np.pad(prob, 1, constant_values=0)
    windows = np.lib.stride_tricks.sliding_window_view(padded, (3, 3))
    is_peak = (prob >= windows.max(axis=(2, 3))) & (prob >= threshold)
    ys, xs = np.nonzero(is_peak)
    scores = prob[ys, xs]
    order = np.argsort(-scores)[:top_k]
    out = []
    for i in order:
        y, x = int(ys[i]), int(xs[i])
        points = np.empty((8, 2), dtype=np.float32)
        for k in range(8):
            points[k, 0] = (x + off[2 * k, y, x]) * STRIDE
            points[k, 1] = (y + off[2 * k + 1, y, x]) * STRIDE
        out.append({"score": float(scores[i]), "corners": points[:4], "points": points})
    return out


class SynthDataset(Dataset):
    """Infinite-ish deterministic synthetic dataset."""

    def __init__(
        self,
        length: int,
        seed_base: int,
        difficulty: Difficulty,
        backgrounds: Path | None,
        fixed_indices: list[int] | None = None,
    ):
        self.length = length
        self.seed_base = seed_base
        self.difficulty = difficulty
        self.backgrounds = backgrounds
        self.fixed_indices = fixed_indices
        self._pool: BackgroundPool | None = None  # lazy per-worker init

    def __len__(self) -> int:
        return self.length

    def pool(self) -> BackgroundPool:
        if self._pool is None:
            self._pool = BackgroundPool(self.backgrounds)
        return self._pool

    def __getitem__(self, index: int):
        if self.fixed_indices is not None:
            index = self.fixed_indices[index % len(self.fixed_indices)]
        scene = generate_scene(index, self.seed_base, self.difficulty, self.pool())
        # uint8 CHW: a queued sample is 4x smaller than float32. The training
        # loop normalizes on the GPU.
        img = torch.from_numpy(scene.image).permute(2, 0, 1).contiguous()
        hm, off, mask = encode_targets(scene)
        return img, torch.from_numpy(hm), torch.from_numpy(off), torch.from_numpy(mask)
