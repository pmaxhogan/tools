"""Render a QR code matrix to a styled RGB image with known corner geometry.

The renderer works from segno's raw module matrix so module style, colors, and
quiet zone width are all controllable. Ground truth corners are the outer
corners of the module region (quiet zone excluded), in the canonical QR frame:
order TL, TR, BR, BL where the finder patterns sit at TL, TR, and BL.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
import segno


@dataclass
class RenderedQr:
    """A rendered code plus the geometry the compositor needs."""

    image: np.ndarray  # HxWx3 float32 in [0,1]
    corners: np.ndarray  # 4x2 float32, module-region corners TL,TR,BR,BL, px
    n_modules: int
    payload: str


def make_matrix(payload: str, ecc: str, mask: int | None = None) -> np.ndarray | None:
    """Encode a payload; returns the module matrix as a bool array or None.

    A fixed mask skips segno's 8-way mask evaluation (a top data-gen cost);
    any mask still yields a spec-valid, decodable code.
    """
    try:
        qr = segno.make_qr(payload, error=ecc, mask=mask)
    except (segno.DataOverflowError, ValueError):
        return None
    if qr.version > 20:  # keep sizes realistic for photographed codes
        return None
    rows = list(qr.matrix_iter(scale=1, border=0))
    return np.array(rows, dtype=np.uint8).astype(bool)


def render_qr(
    matrix: np.ndarray,
    payload: str,
    rng: np.random.Generator,
    *,
    module_px: int,
    border_modules: int,
    dark: np.ndarray,
    light: np.ndarray,
    style: str,
) -> RenderedQr:
    """Draw the matrix at module_px per module with the given colors/style."""
    n = matrix.shape[0]
    full = n + 2 * border_modules
    size = full * module_px

    img = np.empty((size, size, 3), dtype=np.float32)
    img[:] = light

    if style == "square" or module_px < 4:
        # Fast path: block replication of the matrix.
        block = np.kron(matrix, np.ones((module_px, module_px), dtype=bool))
        o = border_modules * module_px
        region = img[o : o + n * module_px, o : o + n * module_px]
        region[block] = dark
    else:
        # Rounded or dot modules, drawn individually. Finder patterns stay
        # square so their ratio signature survives the styling.
        canvas = np.zeros((size, size), dtype=np.uint8)
        o = border_modules * module_px
        radius_f = 0.62 if style == "rounded" else 0.48
        radius = max(1, int(module_px * radius_f))
        finder = np.zeros((n, n), dtype=bool)
        finder[:7, :7] = finder[:7, -7:] = finder[-7:, :7] = True
        ys, xs = np.nonzero(matrix)
        for y, x in zip(ys.tolist(), xs.tolist()):
            if finder[y, x]:
                y0 = o + y * module_px
                x0 = o + x * module_px
                canvas[y0 : y0 + module_px, x0 : x0 + module_px] = 255
            else:
                cx = o + x * module_px + module_px // 2
                cy = o + y * module_px + module_px // 2
                cv2.circle(canvas, (cx, cy), radius, 255, -1, lineType=cv2.LINE_AA)
        alpha = (canvas.astype(np.float32) / 255.0)[..., None]
        img = light * (1 - alpha) + dark * alpha

    o = float(border_modules * module_px)
    e = float((border_modules + n) * module_px)
    corners = np.array([[o, o], [e, o], [e, e], [o, e]], dtype=np.float32)
    return RenderedQr(image=img.astype(np.float32), corners=corners, n_modules=n, payload=payload)


def _qr_finder(grid: np.ndarray, y: int, x: int) -> None:
    """Stamp a 7x7 QR finder pattern into a bool module grid."""
    grid[y : y + 7, x : x + 7] = True
    grid[y + 1 : y + 6, x + 1 : x + 6] = False
    grid[y + 2 : y + 5, x + 2 : x + 5] = True


def render_negative(
    rng: np.random.Generator, kind: str | None = None, force_aztec: bool | None = None
) -> np.ndarray:
    """A QR lookalike that is NOT a QR code, as an HxWx3 float tile.

    These are composited exactly like real codes but carry no labels, so the
    detector is explicitly punished for responding to barcode texture, matrix
    codes without QR geometry, or high contrast logo shapes. The kind and
    force_aztec overrides exist for demo pages; production passes neither.
    """
    if kind is None:
        kind = str(
            rng.choice(["barcode", "matrix", "fakeqr", "logo", "checker"], p=[0.26, 0.24, 0.2, 0.2, 0.1])
        )
    dark, light = sample_colors(rng, invert_p=0.1, low_contrast_p=0.15)

    if kind == "barcode":
        # Code128-ish 1D bars with quiet margins.
        n_bars = int(rng.integers(20, 50))
        widths = rng.integers(1, 5, size=n_bars)
        total = int(widths.sum())
        h = int(total * rng.uniform(0.4, 1.1))
        margin = max(4, total // 10)
        img = np.empty((h + 2 * margin, total + 2 * margin, 3), dtype=np.float32)
        img[:] = light
        x = margin
        for i, w in enumerate(widths.tolist()):
            if i % 2 == 0:
                img[margin : margin + h, x : x + w] = dark
            x += w
        return img

    if kind in ("matrix", "fakeqr", "checker"):
        n = int(rng.integers(14, 34))
        if kind == "checker":
            cell = int(rng.integers(1, 4))
            yy, xx = np.mgrid[0:n, 0:n]
            grid = ((yy // cell + xx // cell) % 2).astype(bool)
        else:
            grid = rng.random((n, n)) < rng.uniform(0.4, 0.6)
            if kind == "matrix":
                # DataMatrix-style L border: two solid edges, two dashed.
                grid[:, 0] = True
                grid[-1, :] = True
                grid[0, :] = np.arange(n) % 2 == 0
                grid[:, -1] = np.arange(n) % 2 == 0
                aztec = rng.random() < 0.3 if force_aztec is None else force_aztec
                if aztec and n >= 15:
                    # Aztec-style bullseye instead.
                    c = n // 2
                    for r in range(1, 5):
                        ring = np.zeros((n, n), dtype=bool)
                        ring[c - r : c + r + 1, c - r : c + r + 1] = True
                        ring[c - r + 1 : c + r, c - r + 1 : c + r] = False
                        grid[ring] = r % 2 == 1
            else:
                # Fake QR: right texture, wrong geometry. At most two finder
                # patterns, never the three that define a real code.
                n_finders = int(rng.integers(0, 3))
                spots = [(0, 0), (0, n - 7), (n - 7, 0), (n - 7, n - 7)]
                rng.shuffle(spots)
                for y, x in spots[:n_finders]:
                    _qr_finder(grid, y, x)
        mpx = int(rng.integers(2, 9))
        border = int(rng.integers(1, 4))
        full = n + 2 * border
        img = np.empty((full * mpx, full * mpx, 3), dtype=np.float32)
        img[:] = light
        block = np.kron(grid, np.ones((mpx, mpx), dtype=bool))
        o = border * mpx
        img[o : o + n * mpx, o : o + n * mpx][block] = dark
        return img

    # Logo: bold shapes on a light tile.
    size = int(rng.integers(48, 160))
    img = np.empty((size, size, 3), dtype=np.float32)
    img[:] = light
    for _ in range(int(rng.integers(1, 6))):
        shape = rng.integers(0, 4)
        p = (int(rng.integers(0, size)), int(rng.integers(0, size)))
        r = int(rng.integers(size // 10, size // 2))
        if shape == 0:
            cv2.circle(img, p, r, dark.tolist(), -1)
        elif shape == 1:
            cv2.circle(img, p, r, dark.tolist(), max(1, r // 3))
        elif shape == 2:
            q = (int(rng.integers(0, size)), int(rng.integers(0, size)))
            cv2.rectangle(img, p, q, dark.tolist(), -1)
        else:
            q = (int(rng.integers(0, size)), int(rng.integers(0, size)))
            cv2.line(img, p, q, dark.tolist(), max(2, size // 12))
    return img


def sample_colors(rng: np.random.Generator, invert_p: float, low_contrast_p: float):
    """Pick dark/light module colors with controllable contrast pathology."""
    if rng.random() < 0.6:
        dark = np.zeros(3, dtype=np.float32) + rng.uniform(0.0, 0.15)
        light = np.ones(3, dtype=np.float32) - rng.uniform(0.0, 0.12)
    else:
        # Colored codes: any hue pair with enforced luminance separation.
        dark = rng.uniform(0.0, 0.45, size=3).astype(np.float32)
        light = rng.uniform(0.55, 1.0, size=3).astype(np.float32)
    if rng.random() < low_contrast_p:
        # Pull the endpoints toward each other. Codes fade badly in the wild.
        mid = (dark + light) / 2
        t = rng.uniform(0.35, 0.62)
        dark = mid + (dark - mid) * t
        light = mid + (light - mid) * t
    if rng.random() < invert_p:
        dark, light = light, dark
    return dark, light
