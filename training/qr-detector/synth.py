"""Synthetic scene generation: composite QR codes into photos with the failure
modes the detector must survive: perspective warp, small scale, blur, low
contrast, occlusion, glare, rotation, noise, print/screen artifacts.

Determinism: every sample is fully determined by (seed_base, index). The train
and eval sets use disjoint seed bases AND different difficulty ranges (eval is
shifted harder) so the held-out numbers are not a memorization artifact.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from payloads import random_payload
from qr_render import make_matrix, render_negative, render_qr, sample_colors

IMG_SIZE = 512

# Cached coordinate grids: allocating fresh mgrids per effect was a top cost in
# the per-sample profile. Views into these are read-only inputs to arithmetic.
_GRID_SIDE = 704
_g = np.mgrid[0:_GRID_SIDE, 0:_GRID_SIDE].astype(np.float32)
_GRID_YY, _GRID_XX = _g[0], _g[1]
del _g
_R2 = ((_GRID_XX[:IMG_SIZE, :IMG_SIZE] - IMG_SIZE / 2) ** 2 + (_GRID_YY[:IMG_SIZE, :IMG_SIZE] - IMG_SIZE / 2) ** 2) / (
    IMG_SIZE / 2
) ** 2


def _grids(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    if h <= _GRID_SIDE and w <= _GRID_SIDE:
        return _GRID_YY[:h, :w], _GRID_XX[:h, :w]
    g = np.mgrid[0:h, 0:w].astype(np.float32)
    return g[0], g[1]


@dataclass
class Difficulty:
    """Parameter ranges for scene synthesis. All probabilities are per-code or
    per-image as noted. Eval uses a shifted-harder copy of these ranges."""

    # Destination side length of a code, sampled log-uniformly, px in a 512 image.
    size_min: float = 26.0
    size_max: float = 400.0
    # Per-corner perspective jitter as a fraction of the side length.
    persp_jitter: float = 0.22
    # Per-code appearance
    invert_p: float = 0.10
    low_contrast_p: float = 0.18
    styled_module_p: float = 0.15
    occlusion_p: float = 0.14
    glare_p: float = 0.18
    shadow_p: float = 0.25
    # Global photo degradation
    blur_sigma_max: float = 2.6
    motion_blur_p: float = 0.22
    motion_len_max: int = 13
    noise_std_max: float = 0.09
    jpeg_p: float = 0.55
    jpeg_q_min: int = 28
    lowres_p: float = 0.30
    lowres_min: float = 0.35
    moire_p: float = 0.12
    vignette_p: float = 0.3
    # Formerly hardcoded stage probabilities, exposed so single effects can be
    # isolated (demo pages, ablations). Defaults match the original constants.
    code_gradient_p: float = 0.7
    gauss_blur_p: float = 0.75
    exposure_p: float = 0.8
    chroma_p: float = 0.2
    n_codes_p: tuple = (0.08, 0.62, 0.22, 0.08)  # P(0..3 codes)
    # Probability of emulating a letterboxed non-square input: the scene is
    # cropped to a random aspect then padded back to square with clean bars,
    # exactly what the browser does to a non-square upload before inference.
    letterbox_p: float = 0.30
    # P(0..2 QR-lookalike hard negatives): 1D barcodes, DataMatrix/Aztec-style
    # grids, finderless fake QRs, black and white logos, checkerboards. They
    # carry no labels, so any heatmap response on them is punished.
    n_negatives_p: tuple = (0.5, 0.32, 0.18)
    # Cylindrical wrap: the code is on a pole, bottle, or curved poster.
    cylinder_p: float = 0.22
    # A big brand logo dead center on the code, the most common real-world
    # occlusion. Sized up to and slightly past each ECC level's theoretical
    # recovery limit (L 7%, M 15%, Q 25%, H 30% of area).
    center_logo_p: float = 0.18
    # Real-failure lookalikes, modeled on field photos that defeated the
    # deployed scanner: an etched tone-on-tone metal plate, a hard specular
    # band washing modules to white, caption text hugging the code, and the
    # blown-up screenshot of a tiny code.
    metal_p: float = 0.08
    glare_band_p: float = 0.08
    caption_p: float = 0.18
    zoom_p: float = 0.06
    # PNG-8/GIF-style palette banding, optionally with ordered dithering.
    posterize_p: float = 0.15


TRAIN = Difficulty()

# Held-out hard set: smaller codes, stronger blur/noise, worse contrast and
# compression than anything in the training ranges' typical mass.
EVAL_HARD = Difficulty(
    size_min=22.0,
    size_max=340.0,
    persp_jitter=0.26,
    invert_p=0.12,
    low_contrast_p=0.26,
    styled_module_p=0.18,
    occlusion_p=0.18,
    glare_p=0.24,
    shadow_p=0.3,
    blur_sigma_max=3.4,
    motion_blur_p=0.3,
    motion_len_max=17,
    noise_std_max=0.13,
    jpeg_p=0.65,
    jpeg_q_min=20,
    lowres_p=0.4,
    lowres_min=0.28,
    moire_p=0.16,
    n_codes_p=(0.0, 0.76, 0.18, 0.06),
    cylinder_p=0.3,
    posterize_p=0.2,
    center_logo_p=0.25,
    metal_p=0.12,
    glare_band_p=0.14,
    caption_p=0.22,
    zoom_p=0.1,
)

# The field-failure stress set: every knob that mirrors the real photos the
# deployed scanner missed, cranked. Off-center tilted cylinder wraps, etched
# tone-on-tone plates under glare bands, captions against the code, and
# blown-up screenshots of tiny codes.
LOOKALIKE = Difficulty(
    size_min=60.0,
    size_max=380.0,
    persp_jitter=0.16,
    invert_p=0.05,
    low_contrast_p=0.3,
    styled_module_p=0.1,
    occlusion_p=0.05,
    glare_p=0.25,
    shadow_p=0.25,
    blur_sigma_max=2.8,
    motion_blur_p=0.2,
    noise_std_max=0.1,
    jpeg_p=0.7,
    jpeg_q_min=24,
    lowres_p=0.35,
    lowres_min=0.3,
    moire_p=0.1,
    n_codes_p=(0.0, 0.9, 0.1, 0.0),
    letterbox_p=0.25,
    n_negatives_p=(0.7, 0.25, 0.05),
    cylinder_p=0.55,
    posterize_p=0.1,
    center_logo_p=0.25,
    metal_p=0.4,
    glare_band_p=0.45,
    caption_p=0.55,
    zoom_p=0.3,
)

# Held-out set drawn from the training distribution (but disjoint seeds), to
# measure in-distribution performance separately from the stress set.
EVAL_LIKE_TRAIN = Difficulty(n_codes_p=(0.0, 0.7, 0.22, 0.08))


@dataclass
class SceneCode:
    """Ground truth for one composited code.

    points holds 8 rows: the module-region corners TL, TR, BR, BL followed by
    the edge midpoints top, right, bottom, left. Midpoints sit ON the curved
    edge for cylinder-wrapped codes, which is what lets the browser rectify
    the bow. corners is a view of the first four rows.
    """

    points: np.ndarray  # 8x2 float32 in image px
    payload: str
    side_px: float  # nominal destination side length before jitter
    n_modules: int
    occluded: bool
    ecc: str = "m"
    # Fraction of the module area covered by a center logo, 0 when none.
    logo_frac: float = 0.0
    cylinder: bool = False

    @property
    def corners(self) -> np.ndarray:
        return self.points[:4]


@dataclass
class Scene:
    image: np.ndarray  # HxWx3 uint8
    codes: list[SceneCode] = field(default_factory=list)
    # Degradation levels actually applied, for eval bucketing.
    blur_sigma: float = 0.0
    noise_std: float = 0.0
    jpeg_q: int = 100


class BackgroundPool:
    """Random crops from a photo pool, with a procedural fallback.

    Prefers the memory-mapped decoded cache built by build_bg_cache.py: one
    page-cache-shared uint8 array instead of a JPEG decode per sample. Falls
    back to per-file reads, then to procedural backgrounds.
    """

    def __init__(self, root: Path | None):
        self.paths: list[Path] = []
        self.cache_path: Path | None = None
        self._cache: np.ndarray | None = None
        if root is not None and root.exists():
            self.paths = sorted(root.glob("*.jpg"))
            candidate = root.parent / "bg560.npy"
            if candidate.exists():
                self.cache_path = candidate

    def sample(self, rng: np.random.Generator, procedural_p: float = 0.2) -> np.ndarray:
        if rng.random() < procedural_p or (not self.paths and self.cache_path is None):
            return self._procedural(rng)
        if self.cache_path is not None:
            if self._cache is None:
                self._cache = np.load(self.cache_path, mmap_mode="r")
            n, side_full = self._cache.shape[0], self._cache.shape[1]
            idx = int(rng.integers(0, n))
            side = int(side_full * rng.uniform(0.55, 1.0))
            y = int(rng.integers(0, side_full - side + 1))
            x = int(rng.integers(0, side_full - side + 1))
            crop = np.asarray(self._cache[idx, y : y + side, x : x + side])
            crop = cv2.resize(crop, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_AREA)
            return crop.astype(np.float32) / 255.0
        for _ in range(3):
            path = self.paths[int(rng.integers(0, len(self.paths)))]
            img = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if img is None:
                continue
            h, w = img.shape[:2]
            side = int(min(h, w) * rng.uniform(0.55, 1.0))
            y = int(rng.integers(0, h - side + 1))
            x = int(rng.integers(0, w - side + 1))
            crop = img[y : y + side, x : x + side]
            crop = cv2.resize(crop, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_AREA)
            return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        return self._procedural(rng)

    @staticmethod
    def _procedural(rng: np.random.Generator) -> np.ndarray:
        """Gradients, blobs, stripes, and text-like clutter."""
        base = rng.uniform(0.1, 0.9, size=3).astype(np.float32)
        img = np.ones((IMG_SIZE, IMG_SIZE, 3), dtype=np.float32) * base
        gx = np.linspace(0, 1, IMG_SIZE, dtype=np.float32)
        grad = np.outer(gx, rng.uniform(-0.4, 0.4, 1)).astype(np.float32)
        img += grad[..., None] + np.outer(rng.uniform(-0.4, 0.4, 1), gx)[..., None].transpose(1, 0, 2)
        for _ in range(int(rng.integers(0, 14))):
            color = rng.uniform(0, 1, 3).astype(np.float32)
            kind = rng.integers(0, 3)
            p1 = (int(rng.integers(0, IMG_SIZE)), int(rng.integers(0, IMG_SIZE)))
            if kind == 0:
                cv2.circle(img, p1, int(rng.integers(8, 160)), color.tolist(), -1)
            elif kind == 1:
                p2 = (int(rng.integers(0, IMG_SIZE)), int(rng.integers(0, IMG_SIZE)))
                cv2.rectangle(img, p1, p2, color.tolist(), -1)
            else:
                p2 = (int(rng.integers(0, IMG_SIZE)), int(rng.integers(0, IMG_SIZE)))
                cv2.line(img, p1, p2, color.tolist(), int(rng.integers(1, 10)))
        # Text-like rows of small rectangles: hard negatives for module texture.
        if rng.random() < 0.5:
            y = int(rng.integers(0, IMG_SIZE - 40))
            for row in range(int(rng.integers(2, 8))):
                x = int(rng.integers(0, 60))
                yy = y + row * int(rng.integers(10, 18))
                while x < IMG_SIZE - 20 and yy < IMG_SIZE - 8:
                    w = int(rng.integers(6, 30))
                    cv2.rectangle(img, (x, yy), (x + w, yy + 6), rng.uniform(0, 1, 3).tolist(), -1)
                    x += w + int(rng.integers(4, 12))
        noise = rng.normal(0, rng.uniform(0.005, 0.05), size=img.shape).astype(np.float32)
        return np.clip(img + noise, 0, 1)


def _dst_quad(rng: np.random.Generator, side: float, jitter: float) -> np.ndarray | None:
    """A convex destination quad for the full rendered tile (with quiet zone)."""
    angle = rng.uniform(0, 2 * np.pi)
    c, s = np.cos(angle), np.sin(angle)
    rot = np.array([[c, -s], [s, c]], dtype=np.float32)
    half = side / 2
    base = np.array([[-half, -half], [half, -half], [half, half], [-half, half]], dtype=np.float32)
    quad = base @ rot.T
    quad += rng.uniform(-jitter, jitter, size=(4, 2)).astype(np.float32) * side
    margin = min(side * 0.55, IMG_SIZE * 0.48)
    cx = rng.uniform(margin, IMG_SIZE - margin)
    cy = rng.uniform(margin, IMG_SIZE - margin)
    quad += np.array([cx, cy], dtype=np.float32)
    # Reject non-convex or degenerate quads: they do not happen to planar codes.
    if not cv2.isContourConvex(quad.reshape(-1, 1, 2)):
        return None
    return quad


def _apply_code_lighting(tile: np.ndarray, rng: np.random.Generator, d: Difficulty) -> np.ndarray:
    """Illumination gradient, glare, and shadow inside the code tile."""
    h, w = tile.shape[:2]
    yy, xx = _grids(h, w)
    out = tile
    # Smooth illumination gradient across the plane of the code.
    if rng.random() < d.code_gradient_p:
        ang = rng.uniform(0, 2 * np.pi)
        ramp = (np.cos(ang) * xx / w + np.sin(ang) * yy / h) * rng.uniform(-0.25, 0.25)
        out = out * (1.0 + ramp[..., None])
    if rng.random() < d.glare_p:
        # Specular blob that washes modules toward white.
        gx, gy = rng.uniform(0.1, 0.9) * w, rng.uniform(0.1, 0.9) * h
        sigma = rng.uniform(0.08, 0.3) * max(h, w)
        blob = np.exp(-(((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * sigma**2)))
        strength = rng.uniform(0.5, 1.0)
        out = out + (1.0 - out) * (blob * strength)[..., None]
    if rng.random() < d.shadow_p:
        # Hard-edged shadow across part of the code.
        ang = rng.uniform(0, 2 * np.pi)
        c, s = np.cos(ang), np.sin(ang)
        dist = (xx - w / 2) * c + (yy - h / 2) * s
        edge = rng.uniform(-0.3, 0.3) * max(h, w)
        soft = rng.uniform(2, 30)
        mask = 1.0 / (1.0 + np.exp(-(dist - edge) / soft))
        out = out * (1.0 - mask[..., None] * rng.uniform(0.2, 0.55))
    if rng.random() < d.glare_band_p:
        # A broad specular band that washes modules nearly to white, the way
        # brushed metal or glossy lamination catches a light source.
        ang = rng.uniform(0, 2 * np.pi)
        c, s = np.cos(ang), np.sin(ang)
        dist = (xx - w / 2) * c + (yy - h / 2) * s
        center = rng.uniform(-0.35, 0.35) * max(h, w)
        width = rng.uniform(0.18, 0.5) * max(h, w)
        band = np.exp(-(((dist - center) / width) ** 2)) * rng.uniform(0.72, 0.97)
        wash = rng.uniform(0.88, 0.98)
        out = out + (wash - out) * band[..., None]
    return np.clip(out, 0, 1)


def _rounded_rect(img: np.ndarray, cx: float, cy: float, half: float, r: float, color) -> None:
    x0, y0, x1, y1 = int(cx - half), int(cy - half), int(cx + half), int(cy + half)
    ri = max(1, min(int(r), int(half)))
    cv2.rectangle(img, (x0 + ri, y0), (x1 - ri, y1), color, -1)
    cv2.rectangle(img, (x0, y0 + ri), (x1, y1 - ri), color, -1)
    for px, py in ((x0 + ri, y0 + ri), (x1 - ri, y0 + ri), (x0 + ri, y1 - ri), (x1 - ri, y1 - ri)):
        cv2.circle(img, (px, py), ri, color, -1, lineType=cv2.LINE_AA)


# How much module area a center logo may cover, per ECC level. Slightly PAST
# the theoretical codeword-recovery limits (L 7%, M 15%, Q 25%, H 30%) so the
# training tail includes codes at and beyond the edge of decodability.
_LOGO_FMAX = {"l": 0.30, "m": 0.42, "q": 0.54, "h": 0.62}


def _draw_center_logo(tile: np.ndarray, corners: np.ndarray, rng: np.random.Generator, ecc: str) -> float:
    """A brand logo dead center on the code, in tile space so it warps along.

    Returns the fraction of module area covered. Two styles: a white knockout
    badge holding a colored glyph (the common generator output), or a glyph
    stamped straight over the modules (harder, also common).
    """
    o = float(corners[0, 0])
    e = float(corners[2, 0])
    s = e - o
    f = float(rng.uniform(0.16, _LOGO_FMAX[ecc]))
    side = f * s
    cx = cy = (o + e) / 2

    def color_dark():
        c = rng.uniform(0.0, 0.55, 3)
        return (float(c[0]), float(c[1]), float(c[2]))

    knockout = rng.random() < 0.65
    glyph_half = side / 2
    if knockout:
        pad = side * rng.uniform(0.06, 0.16)
        box_half = side / 2 + pad
        w = float(rng.uniform(0.92, 1.0))
        white = (w, w, w)
        if rng.random() < 0.4:
            cv2.circle(tile, (int(cx), int(cy)), int(box_half), white, -1, lineType=cv2.LINE_AA)
            glyph_half = side / 2 * 0.85
        else:
            _rounded_rect(tile, cx, cy, box_half, box_half * rng.uniform(0.12, 0.3), white)

    kind = rng.choice(["circle", "ring", "rsquare", "bars", "diamond"])
    color = color_dark()
    if kind == "circle":
        cv2.circle(tile, (int(cx), int(cy)), int(glyph_half * rng.uniform(0.75, 1.0)), color, -1, lineType=cv2.LINE_AA)
    elif kind == "ring":
        r = int(glyph_half * rng.uniform(0.7, 0.95))
        t = max(2, int(glyph_half * rng.uniform(0.25, 0.45)))
        cv2.circle(tile, (int(cx), int(cy)), r, color, t, lineType=cv2.LINE_AA)
    elif kind == "rsquare":
        half = glyph_half * rng.uniform(0.75, 1.0)
        _rounded_rect(tile, cx, cy, half, half * rng.uniform(0.15, 0.4), color)
    elif kind == "bars":
        n_bars = int(rng.integers(2, 5))
        bar_h = glyph_half * 2 / (2 * n_bars - 1)
        y = cy - glyph_half
        for _ in range(n_bars):
            w2 = glyph_half * rng.uniform(0.6, 1.0)
            cv2.rectangle(tile, (int(cx - w2), int(y)), (int(cx + w2), int(y + bar_h)), color, -1)
            y += 2 * bar_h
    else:
        pts = np.array(
            [[cx, cy - glyph_half], [cx + glyph_half, cy], [cx, cy + glyph_half], [cx - glyph_half, cy]],
            np.int32,
        )
        cv2.fillPoly(tile, [pts], color, lineType=cv2.LINE_AA)

    # A second smaller accent glyph, like a mark plus wordmark.
    if rng.random() < 0.25:
        c2 = color_dark()
        cv2.circle(
            tile,
            (int(cx + glyph_half * rng.uniform(-0.4, 0.4)), int(cy + glyph_half * rng.uniform(-0.4, 0.4))),
            max(2, int(glyph_half * rng.uniform(0.15, 0.35))),
            c2,
            -1,
            lineType=cv2.LINE_AA,
        )
    return f * f


def _draw_caption(rendered, rng: np.random.Generator) -> None:
    """Caption clutter hugging the code: squiggly script text, straight text
    bars, and small icons drawn onto an extension of the tile below (and
    sometimes above) the quiet zone, the way stickers and signs caption their
    codes. The corner ground truth is unchanged; the tile just grows.
    """
    tile = rendered.image
    h, w = tile.shape[:2]
    pad = int(np.clip(h * rng.uniform(0.1, 0.28), 6, 200))
    above = rng.random() < 0.25
    bg = tile[0, 0].copy()
    strip = np.empty((pad, w, 3), dtype=np.float32)
    strip[:] = bg
    color = rng.uniform(0.0, 0.55, 3).astype(np.float32).tolist()
    kind = rng.choice(["script", "bars", "icon"])
    if kind == "script":
        # Connected squiggle, like handwriting-styled captions.
        n_pts = 40
        xs = np.linspace(w * 0.1, w * 0.9, n_pts)
        ys = pad / 2 + np.sin(np.linspace(0, rng.uniform(6, 14), n_pts)) * pad * 0.28
        ys += rng.normal(0, pad * 0.05, n_pts)
        pts = np.stack([xs, ys], axis=1).astype(np.int32)
        cv2.polylines(strip, [pts.reshape(-1, 1, 2)], False, color, max(1, int(pad * 0.12)), cv2.LINE_AA)
    elif kind == "bars":
        # Blocky text: short bars with gaps, like printed serial numbers.
        x = int(w * rng.uniform(0.08, 0.25))
        bh = max(2, int(pad * rng.uniform(0.3, 0.55)))
        y = (pad - bh) // 2
        while x < w * 0.9:
            bw = int(rng.integers(max(2, pad // 4), max(3, pad)))
            cv2.rectangle(strip, (x, y), (min(x + bw, w - 1), y + bh), color, -1)
            x += bw + int(rng.integers(2, max(3, pad // 2)))
    else:
        # A small icon: rounded box with dots, like a calendar glyph.
        cx = int(w * rng.uniform(0.15, 0.85))
        r = int(pad * 0.42)
        cv2.rectangle(strip, (cx - r, pad // 2 - r), (cx + r, pad // 2 + r), color, max(1, r // 4))
        for gy in (-r // 3, r // 3):
            for gx in (-r // 2, 0, r // 2):
                cv2.circle(strip, (cx + gx, pad // 2 + gy), max(1, r // 6), color, -1)
    if above:
        rendered.image = np.vstack([strip, tile])
        rendered.corners[:, 1] += pad
    else:
        rendered.image = np.vstack([tile, strip])


def _occlude(img: np.ndarray, quad: np.ndarray, rng: np.random.Generator) -> None:
    """Paste an opaque patch over part of the code region, in place."""
    cx, cy = quad.mean(axis=0)
    side = float(np.linalg.norm(quad[0] - quad[2]) / np.sqrt(2))
    w = side * rng.uniform(0.15, 0.45)
    h = side * rng.uniform(0.15, 0.45)
    x = cx + rng.uniform(-0.5, 0.5) * side
    y = cy + rng.uniform(-0.5, 0.5) * side
    color = rng.uniform(0, 1, 3).astype(np.float32)
    if rng.random() < 0.5:
        cv2.rectangle(
            img,
            (int(x - w / 2), int(y - h / 2)),
            (int(x + w / 2), int(y + h / 2)),
            color.tolist(),
            -1,
        )
    else:
        cv2.circle(img, (int(x), int(y)), int(max(w, h) / 2), color.tolist(), -1)


def _global_degrade(img: np.ndarray, rng: np.random.Generator, d: Difficulty, scene: Scene) -> np.ndarray:
    """Whole-image capture artifacts. Non-geometric, so corners stay valid."""
    # Low-resolution capture: downscale then back up.
    if rng.random() < d.lowres_p:
        f = rng.uniform(d.lowres_min, 0.85)
        small = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    # Defocus / gaussian blur.
    if rng.random() < d.gauss_blur_p:
        sigma = rng.uniform(0.0, d.blur_sigma_max)
        scene.blur_sigma = sigma
        if sigma > 0.2:
            k = int(sigma * 4) | 1
            img = cv2.GaussianBlur(img, (k, k), sigma)
    # Motion blur.
    if rng.random() < d.motion_blur_p:
        length = int(rng.integers(5, d.motion_len_max + 1))
        kernel = np.zeros((length, length), dtype=np.float32)
        kernel[length // 2, :] = 1.0 / length
        angle = rng.uniform(0, 180)
        rot = cv2.getRotationMatrix2D((length / 2 - 0.5, length / 2 - 0.5), angle, 1)
        kernel = cv2.warpAffine(kernel, rot, (length, length))
        ksum = kernel.sum()
        if ksum > 1e-6:
            img = cv2.filter2D(img, -1, kernel / ksum)
    # Exposure, contrast, gamma, white balance.
    if rng.random() < d.exposure_p:
        img = img * rng.uniform(0.6, 1.35) + rng.uniform(-0.12, 0.12)
        img = np.clip(img, 0, 1)
        img = cv2.pow(img, float(rng.uniform(0.65, 1.5)))
        img = img * (1.0 + rng.uniform(-0.08, 0.08, size=3).astype(np.float32))
        img = np.clip(img, 0, 1)
    # Vignette.
    if rng.random() < d.vignette_p:
        img = img * (1.0 - rng.uniform(0.1, 0.45) * _R2)[..., None]
        img = np.clip(img, 0, 1)
    # Screen-capture moire: a faint rotated pixel lattice.
    if rng.random() < d.moire_p:
        period = rng.uniform(2.2, 5.0)
        ang = rng.uniform(-0.4, 0.4)
        yy, xx = _grids(IMG_SIZE, IMG_SIZE)
        u = xx * np.cos(ang) - yy * np.sin(ang)
        v = xx * np.sin(ang) + yy * np.cos(ang)
        lattice = 0.5 * (np.sin(2 * np.pi * u / period) + np.sin(2 * np.pi * v / period))
        img = np.clip(img * (1.0 + lattice[..., None] * rng.uniform(0.03, 0.12)), 0, 1)
    # Sensor noise, luminance dependent.
    std = rng.uniform(0.0, d.noise_std_max)
    scene.noise_std = std
    if std > 0.003:
        shot = rng.standard_normal(size=img.shape, dtype=np.float32) * (cv2.sqrt(np.clip(img, 0.02, 1)) * std)
        img = np.clip(img + shot, 0, 1)
    # Chromatic aberration: shift red/blue by up to a pixel.
    if rng.random() < d.chroma_p:
        shift = int(rng.integers(1, 3))
        img[..., 0] = np.roll(img[..., 0], shift, axis=1)
        img[..., 2] = np.roll(img[..., 2], -shift, axis=1)
    # PNG-8/GIF-style banding: per-channel posterization, sometimes with an
    # ordered Bayer dither, the way screenshots exported to palettes look.
    if rng.random() < d.posterize_p:
        levels = int(rng.integers(3, 24))
        if rng.random() < 0.5:
            bayer = (
                np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16
                - 0.5
            )
            reps = IMG_SIZE // 4
            img = img + np.tile(bayer, (reps, reps))[..., None] / max(levels - 1, 1)
        img = np.clip(np.round(img * (levels - 1)) / (levels - 1), 0, 1)
    # JPEG round trip, occasionally doubled (a recompressed screenshot).
    if rng.random() < d.jpeg_p:
        q = int(rng.integers(d.jpeg_q_min, 92))
        scene.jpeg_q = q
        passes = 2 if rng.random() < 0.3 else 1
        for p in range(passes):
            pq = q if p == 0 else int(rng.integers(d.jpeg_q_min, 92))
            u8 = (img * 255).astype(np.uint8)
            ok, enc = cv2.imencode(
                ".jpg", cv2.cvtColor(u8, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, pq]
            )
            if ok:
                img = (
                    cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32)
                    / 255.0
                )
    return img


def _cylinder_warp(
    tile: np.ndarray, points: np.ndarray | None, rng: np.random.Generator
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Wrap the tile around a cylinder and view it with a perspective camera.

    A poster on a pole, a label on a can. The tile of width w subtends arc
    theta on a cylinder of radius R; the camera sits at distance d = k*R from
    the axis. The center column is closest to the camera so it renders
    tallest, and the horizontal edges genuinely bow outward; the limbs
    compress horizontally, shrink vertically, and shade with the curve.
    Returns (warped tile, alpha, mapped points) for any (N, 2) point array.

    The wrap axis is vertical (horizontal bending) most of the time; the tile
    is transposed to reuse the same math for the horizontal-axis case.
    """
    vertical = rng.random() < 0.8
    if not vertical:
        tile = np.transpose(tile, (1, 0, 2)).copy()
        if points is not None:
            points = points[:, ::-1].copy()

    # Tilted wrap axis: a sticker applied crooked on the pole bends along a
    # diagonal. Rotate into the axis frame, wrap, rotate back at the end.
    tilt = float(rng.uniform(-0.28, 0.28)) if rng.random() < 0.5 else 0.0
    pre_alpha = None
    if tilt != 0.0:
        tile, pre_alpha, points = _rotate_tile(tile, None, points, tilt)

    h, w = tile.shape[:2]
    k = float(rng.uniform(1.15, 4.0))  # camera distance in cylinder radii
    # The surface is visible only while it faces the camera: |phi| < acos(1/k).
    vis = float(np.arccos(1.0 / k))
    theta = float(rng.uniform(0.5, 0.92)) * 2.0 * vis
    # Off-center wrap: the code sits away from the cylinder's nearest line (a
    # label read from off to the side), the dominant real-photo case.
    phase = float(rng.uniform(-0.7, 0.7)) * (vis - theta / 2)
    radius = w / theta  # arc length is preserved
    d = k * radius
    f = d - radius  # focal length making the center column scale exactly 1

    def xproj(phi: np.ndarray) -> np.ndarray:
        return f * radius * np.sin(phi) / (d - radius * np.cos(phi))

    # Dense forward table, numerically inverted per output column.
    phi_dense = np.linspace(phase - theta / 2, phase + theta / 2, 2048, dtype=np.float64)
    xp_dense = xproj(phi_dense)
    xp_min, xp_max = float(xp_dense[0]), float(xp_dense[-1])
    out_w = max(8, int(np.ceil(xp_max - xp_min)))
    out_h = h

    xs = xp_min + np.arange(out_w, dtype=np.float64) + 0.5
    phi_col = np.interp(xs, xp_dense, phi_dense)
    src_x = (((phi_col - phase) / theta + 0.5) * w).astype(np.float32)
    depth_col = (d - radius * np.cos(phi_col)).astype(np.float32)
    yscale_col = f / depth_col  # 1 where the surface is nearest the camera

    rows = np.arange(out_h, dtype=np.float32)[:, None] + 0.5 - out_h / 2
    map_y = (rows / yscale_col[None, :] + h / 2 - 0.5).astype(np.float32)
    map_x = np.broadcast_to(src_x[None, :], (out_h, out_w)).astype(np.float32).copy()

    warped = cv2.remap(tile, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    src_alpha = pre_alpha if pre_alpha is not None else np.ones((h, w), dtype=np.float32)
    alpha = cv2.remap(
        src_alpha,
        map_x,
        map_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0.0,
    )
    # Diffuse cylindrical shading, softened so the limbs stay visible.
    shade = (0.35 + 0.65 * np.cos(phi_col))[None, :, None].astype(np.float32)
    warped = np.clip(warped * shade, 0, 1)

    mapped = None
    if points is not None:
        phi_p = (points[:, 0] / w - 0.5) * theta + phase
        depth_p = d - radius * np.cos(phi_p)
        px = f * radius * np.sin(phi_p) / depth_p - xp_min
        py = (points[:, 1] - h / 2) * (f / depth_p) + out_h / 2
        mapped = np.stack([px, py], axis=1).astype(np.float32)

    if tilt != 0.0:
        warped, alpha, mapped = _rotate_tile(warped, alpha, mapped, -tilt)

    if not vertical:
        warped = np.transpose(warped, (1, 0, 2))
        alpha = alpha.T
        if mapped is not None:
            mapped = mapped[:, ::-1].copy()
    return warped, alpha, mapped


def _rotate_tile(
    tile: np.ndarray, alpha: np.ndarray | None, points: np.ndarray | None, angle: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Rotate a tile (and its alpha and points) by `angle` radians about its
    center, expanding the canvas so nothing clips."""
    h, w = tile.shape[:2]
    deg = float(np.degrees(angle))
    c, s = abs(np.cos(angle)), abs(np.sin(angle))
    nw = int(np.ceil(w * c + h * s))
    nh = int(np.ceil(w * s + h * c))
    M = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
    M[0, 2] += (nw - w) / 2
    M[1, 2] += (nh - h) / 2
    rot = cv2.warpAffine(tile, M, (nw, nh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    a = alpha if alpha is not None else np.ones((h, w), dtype=np.float32)
    rot_a = cv2.warpAffine(
        a, M, (nw, nh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0.0
    )
    mapped = None
    if points is not None:
        ones = np.ones((points.shape[0], 1), dtype=np.float64)
        mapped = (np.hstack([points.astype(np.float64), ones]) @ M.T).astype(np.float32)
    return rot, rot_a, mapped


def _composite_tile(
    img: np.ndarray,
    tile: np.ndarray,
    tile_side: float,
    rng: np.random.Generator,
    d: Difficulty,
    placed_quads: list[np.ndarray],
    alpha: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Warp a tile into the scene. Returns (H, quad) or None if placement failed."""
    quad = _dst_quad(rng, tile_side, d.persp_jitter)
    if quad is None:
        return None
    if any(np.hypot(*(quad.mean(axis=0) - q.mean(axis=0))) < tile_side * 0.9 for q in placed_quads):
        return None
    tile = _apply_code_lighting(tile, rng, d)
    th, tw = tile.shape[:2]
    if alpha is None:
        alpha = np.ones((th, tw), dtype=np.float32)
    src = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, quad.astype(np.float32))

    # Warp and blend only inside the quad's bounding box: warping into a full
    # 512 canvas per tile was a top per-sample cost for small codes.
    x0 = max(0, int(np.floor(quad[:, 0].min())) - 2)
    y0 = max(0, int(np.floor(quad[:, 1].min())) - 2)
    x1 = min(IMG_SIZE, int(np.ceil(quad[:, 0].max())) + 2)
    y1 = min(IMG_SIZE, int(np.ceil(quad[:, 1].max())) + 2)
    if x1 <= x0 or y1 <= y0:
        return None
    shift = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], dtype=np.float64)
    Hb = shift @ H
    bw, bh = x1 - x0, y1 - y0
    warped = cv2.warpPerspective(tile, Hb, (bw, bh), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
    a = cv2.warpPerspective(alpha, Hb, (bw, bh), flags=cv2.INTER_LINEAR, borderValue=0.0)
    a = cv2.GaussianBlur(a, (3, 3), 0.6)[..., None]
    region = img[y0:y1, x0:x1]
    region[:] = region * (1 - a) + np.clip(warped, 0, 1) * a
    return H, quad


def _letterbox(img: np.ndarray, scene: Scene, rng: np.random.Generator) -> np.ndarray:
    """Center-crop one axis and pad back with clean bars; drops hidden codes."""
    a = rng.uniform(1.08, 2.0)
    keep = int(round(IMG_SIZE / a))
    off = (IMG_SIZE - keep) // 2
    bar_kind = rng.choice(["mid", "black", "white", "any"], p=[0.5, 0.15, 0.15, 0.2])
    bar = {"mid": 0.5, "black": 0.0, "white": 1.0, "any": float(rng.uniform(0, 1))}[bar_kind]
    axis = int(rng.integers(0, 2))
    out = np.full_like(img, bar)
    if axis == 0:
        out[off : off + keep, :] = img[off : off + keep, :]
    else:
        out[:, off : off + keep] = img[:, off : off + keep]
    kept_codes = []
    for code in scene.codes:
        c = code.corners.mean(axis=0)
        coord = c[1] if axis == 0 else c[0]
        if off <= coord < off + keep:
            kept_codes.append(code)
    scene.codes = kept_codes
    return out


def generate_scene(index: int, seed_base: int, d: Difficulty, pool: BackgroundPool) -> Scene:
    """Deterministically synthesize scene (seed_base, index)."""
    rng = np.random.default_rng(np.random.SeedSequence([seed_base, index]))
    scene = Scene(image=np.empty(0))
    img = pool.sample(rng).copy()

    n_codes = int(rng.choice([0, 1, 2, 3], p=list(d.n_codes_p)))
    n_neg = int(rng.choice([0, 1, 2], p=list(d.n_negatives_p)))
    placed_quads: list[np.ndarray] = []

    for _ in range(n_codes):
        for _attempt in range(8):
            log_side = rng.uniform(np.log(d.size_min), np.log(d.size_max))
            side = float(np.exp(log_side))
            # Keep modules at or above ~1.25px at composite scale (relaxed to
            # ~1px for the very smallest codes, where only version 1 fits). A
            # code whose modules alias into noise is indistinguishable from the
            # matrix lookalike negatives and would poison the labels.
            max_modules = side / (1.25 if side >= 34 else 1.02)
            if max_modules < 27:
                payload = str(rng.integers(0, 10**8))  # digits fit version 1
            elif max_modules < 37:
                payload = str(rng.choice(["tel:+", ""])) + str(rng.integers(10**6, 10**10))
            else:
                payload = random_payload(rng)
            wants_logo = rng.random() < d.center_logo_p
            # Styled generators pair center logos with high error correction.
            ecc_p = [0.0, 0.1, 0.3, 0.6] if wants_logo else [0.2, 0.45, 0.2, 0.15]
            ecc = str(rng.choice(["l", "m", "q", "h"], p=ecc_p))
            matrix = make_matrix(payload, ecc, mask=int(rng.integers(0, 8)))
            if matrix is None:
                continue
            n_mod = matrix.shape[0]
            if n_mod > max_modules:
                continue

            border = int(rng.choice([1, 2, 3, 4], p=[0.15, 0.3, 0.35, 0.2]))
            tile_side = side * (n_mod + 2 * border) / n_mod

            module_px = int(np.clip(round(side * 1.6 / n_mod), 2, 14))
            style = "square"
            if rng.random() < d.styled_module_p:
                style = str(rng.choice(["rounded", "dots"]))
            if rng.random() < d.metal_p:
                # Etched tone-on-tone plate: both module colors sit close
                # together on a metallic gray, with a slight warm cast.
                base = float(rng.uniform(0.6, 0.85))
                delta = float(rng.uniform(0.08, 0.22))
                warm = np.array([1.03, 1.0, 0.95], dtype=np.float32)
                light = np.clip(base * warm, 0, 1).astype(np.float32)
                dark = np.clip((base - delta) * warm, 0, 1).astype(np.float32)
            else:
                dark, light = sample_colors(rng, d.invert_p, d.low_contrast_p)
            rendered = render_qr(
                matrix,
                payload,
                rng,
                module_px=module_px,
                border_modules=border,
                dark=dark,
                light=light,
                style=style,
            )
            logo_frac = 0.0
            if wants_logo:
                logo_frac = _draw_center_logo(rendered.image, rendered.corners, rng, ecc)
            if rng.random() < d.caption_p:
                _draw_caption(rendered, rng)

            c = rendered.corners
            mids = np.array(
                [(c[0] + c[1]) / 2, (c[1] + c[2]) / 2, (c[2] + c[3]) / 2, (c[3] + c[0]) / 2],
                dtype=np.float32,
            )
            tile_points = np.concatenate([c, mids], axis=0)  # (8, 2)
            tile, tile_alpha = rendered.image, None
            cylindered = rng.random() < d.cylinder_p
            if cylindered:
                tile, tile_alpha, tile_points = _cylinder_warp(tile, tile_points, rng)

            placed = _composite_tile(img, tile, tile_side, rng, d, placed_quads, alpha=tile_alpha)
            if placed is None:
                continue
            H, quad = placed

            code_points = cv2.perspectiveTransform(tile_points.reshape(1, 8, 2), H).reshape(8, 2)

            occluded = False
            if rng.random() < d.occlusion_p:
                _occlude(img, quad, rng)
                occluded = True

            scene.codes.append(
                SceneCode(
                    points=code_points.astype(np.float32),
                    payload=payload,
                    side_px=side,
                    n_modules=n_mod,
                    occluded=occluded,
                    ecc=ecc,
                    logo_frac=logo_frac,
                    cylinder=cylindered,
                )
            )
            placed_quads.append(quad)
            break

    # Hard negatives: same warp, lighting, and composite path, no labels.
    for _ in range(n_neg):
        for _attempt in range(4):
            tile = render_negative(rng)
            neg_alpha = None
            if rng.random() < d.cylinder_p:
                tile, neg_alpha, _ = _cylinder_warp(tile, None, rng)
            log_side = rng.uniform(np.log(d.size_min), np.log(d.size_max))
            side = float(np.exp(log_side))
            placed = _composite_tile(img, tile, side, rng, d, placed_quads, alpha=neg_alpha)
            if placed is not None:
                placed_quads.append(placed[1])
                break

    # Blown-up screenshot of a tiny code: crop tight around one code and
    # upscale to full frame BEFORE capture degradation, so blur and JPEG land
    # on the upscaled pixels exactly like a zoomed screenshot.
    if scene.codes and rng.random() < d.zoom_p:
        img = _zoom_blowup(img, scene, rng)

    img = _global_degrade(img.astype(np.float32), rng, d, scene)
    if rng.random() < d.letterbox_p:
        img = _letterbox(img, scene, rng)
    scene.image = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    return scene


def _zoom_blowup(img: np.ndarray, scene: Scene, rng: np.random.Generator) -> np.ndarray:
    """Crop a window around one code and upscale it to the full frame."""
    code = scene.codes[int(rng.integers(0, len(scene.codes)))]
    pts = code.corners
    cx, cy = pts.mean(axis=0)
    side = float(np.linalg.norm(pts[0] - pts[2]) / np.sqrt(2))
    win = int(np.clip(side * rng.uniform(1.35, 2.4), 32, IMG_SIZE))
    x0 = int(np.clip(cx - win / 2, 0, IMG_SIZE - win))
    y0 = int(np.clip(cy - win / 2, 0, IMG_SIZE - win))
    crop = img[y0 : y0 + win, x0 : x0 + win]
    out = cv2.resize(crop, (IMG_SIZE, IMG_SIZE), interpolation=cv2.INTER_LINEAR)
    s = IMG_SIZE / win
    kept = []
    for c in scene.codes:
        p = (c.points - np.array([x0, y0], dtype=np.float32)) * s
        center = p[:4].mean(axis=0)
        if 0 <= center[0] < IMG_SIZE and 0 <= center[1] < IMG_SIZE:
            c.points = p.astype(np.float32)
            c.side_px *= s
            kept.append(c)
    scene.codes = kept
    return out
