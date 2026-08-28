"""Generate the labeled example images for the distortion atlas artifact.

Every image comes from the real pipeline code, one effect isolated per panel
via a zeroed-out Difficulty with a single knob turned up. Seeds are scanned
programmatically where the effect strength is measurable.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import cv2
import numpy as np

from payloads import random_payload
from qr_render import make_matrix, render_negative, render_qr
from synth import EVAL_HARD, TRAIN, BackgroundPool, Difficulty, generate_scene

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "demo"
OUT.mkdir(parents=True, exist_ok=True)
POOL = BackgroundPool(ROOT / "data" / "backgrounds" / "val2017")

CLEAN = Difficulty(
    center_logo_p=0.0,
    size_min=150.0,
    size_max=280.0,
    persp_jitter=0.06,
    invert_p=0.0,
    low_contrast_p=0.0,
    styled_module_p=0.0,
    occlusion_p=0.0,
    glare_p=0.0,
    shadow_p=0.0,
    blur_sigma_max=0.0,
    motion_blur_p=0.0,
    noise_std_max=0.0,
    jpeg_p=0.0,
    lowres_p=0.0,
    moire_p=0.0,
    vignette_p=0.0,
    n_codes_p=(0.0, 1.0, 0.0, 0.0),
    letterbox_p=0.0,
    n_negatives_p=(1.0, 0.0, 0.0),
    cylinder_p=0.0,
    posterize_p=0.0,
    code_gradient_p=0.0,
    gauss_blur_p=0.0,
    exposure_p=0.0,
    chroma_p=0.0,
)


def save(name: str, img_rgb: np.ndarray, quality: int = 90) -> None:
    bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    cv2.imwrite(str(OUT / f"{name}.jpg"), bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])


def save_tile(name: str, tile01: np.ndarray, size: int = 360) -> None:
    """A rendered float tile on a neutral card, resized for the page."""
    img = (np.clip(tile01, 0, 1) * 255).astype(np.uint8)
    h, w = img.shape[:2]
    s = size / max(h, w)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    canvas = np.full((size, size, 3), 236, dtype=np.uint8)
    y = (size - img.shape[0]) // 2
    x = (size - img.shape[1]) // 2
    canvas[y : y + img.shape[0], x : x + img.shape[1]] = img
    save(name, canvas, quality=92)


def scene_img(seed: int, d: Difficulty, draw_gt: bool = False):
    s = generate_scene(0, seed, d, POOL)
    img = s.image.copy()
    if draw_gt:
        for c in s.codes:
            cv2.polylines(img, [c.corners.astype(int).reshape(-1, 1, 2)], True, (210, 60, 60), 2)
    return img, s


def pick_seed(d: Difficulty, want, tries: int = 60, base: int = 50_000) -> int:
    for k in range(tries):
        _, s = scene_img(base + k, d)
        if want(s):
            return base + k
    return base


def edge_angle(s) -> float:
    c = s.codes[0].corners
    v = c[1] - c[0]
    return abs(np.degrees(np.arctan2(v[1], v[0]))) % 90


def persp_ratio(s) -> float:
    c = s.codes[0].corners
    e = [np.linalg.norm(c[i] - c[(i + 1) % 4]) for i in range(4)]
    return max(e) / max(min(e), 1e-6)


# ---------------------------------------------------------------- renders
rng = np.random.default_rng(7)
mat = make_matrix("https://tools.maxhogan.dev/qr-code-scanner", "m", mask=4)
black = np.zeros(3, np.float32)
white = np.ones(3, np.float32)
navy = np.array([0.10, 0.13, 0.35], np.float32)
cream = np.array([0.97, 0.95, 0.88], np.float32)

for name, style, dark, light in [
    ("style-square", "square", black, white),
    ("style-rounded", "rounded", black, white),
    ("style-dots", "dots", black, white),
    ("color-colored", "square", navy, cream),
    ("color-inverted", "square", white * 0.95, black + 0.08),
]:
    t = render_qr(mat, "", rng, module_px=10, border_modules=3, dark=dark, light=light, style=style)
    save_tile(name, t.image)

mid = (black + white) / 2
t = render_qr(
    mat, "", rng, module_px=10, border_modules=3,
    dark=mid - 0.17, light=mid + 0.17, style="square",
)
save_tile("color-lowcontrast", t.image)

t = render_qr(mat, "", rng, module_px=10, border_modules=1, dark=black, light=white, style="square")
save_tile("quiet-narrow", t.image)

dense = make_matrix("A" * 700, "m", mask=2)
t = render_qr(dense, "", rng, module_px=5, border_modules=3, dark=black, light=white, style="square")
save_tile("version-dense", t.image)

# ---------------------------------------------------------------- backgrounds
bg = POOL.sample(np.random.default_rng(123), procedural_p=0.0)
save("bg-photo", (bg * 255).astype(np.uint8))
bg = POOL._procedural(np.random.default_rng(5))
save("bg-procedural", (bg * 255).astype(np.uint8))

# ---------------------------------------------------------------- geometry
d_rot = CLEAN
seed = pick_seed(d_rot, lambda s: s.codes and 35 <= edge_angle(s) <= 55 and persp_ratio(s) < 1.15)
save("geo-rotation", scene_img(seed, d_rot)[0])

d_persp = dataclasses.replace(CLEAN, persp_jitter=0.3)
seed = pick_seed(d_persp, lambda s: s.codes and persp_ratio(s) > 1.5)
save("geo-perspective", scene_img(seed, d_persp)[0])

d_cyl = dataclasses.replace(CLEAN, cylinder_p=1.0)
seed = pick_seed(d_cyl, lambda s: bool(s.codes), base=61_000)
save("geo-cylinder", scene_img(seed, d_cyl)[0])
save("geo-cylinder-2", scene_img(seed + 7, d_cyl)[0])

d_small = dataclasses.replace(CLEAN, size_min=26.0, size_max=34.0)
seed = pick_seed(d_small, lambda s: bool(s.codes))
save("geo-small", scene_img(seed, d_small)[0])

d_lb = dataclasses.replace(CLEAN, letterbox_p=1.0)


def has_bars(s) -> bool:
    if not s.codes:
        return False
    img = s.image
    for strip in (img[:, :6], img[:, -6:], img[:6, :], img[-6:, :]):
        if strip.std() < 1.0:
            return True
    return False


seed = pick_seed(d_lb, has_bars, base=62_000)
save("geo-letterbox", scene_img(seed, d_lb)[0])

# ---------------------------------------------------------------- lighting
for k, (name, d) in enumerate(
    [
        ("light-gradient", dataclasses.replace(CLEAN, code_gradient_p=1.0)),
        ("light-glare", dataclasses.replace(CLEAN, glare_p=1.0)),
        ("light-shadow", dataclasses.replace(CLEAN, shadow_p=1.0)),
        ("occlusion", dataclasses.replace(CLEAN, occlusion_p=1.0)),
    ]
):
    seed = pick_seed(d, lambda s: bool(s.codes), base=63_000 + k * 300)
    save(name, scene_img(seed, d)[0])

# Center logos: one near the ECC recovery limit, one direct-overlay style.
d_logo = dataclasses.replace(CLEAN, center_logo_p=1.0)
seed = pick_seed(d_logo, lambda s: s.codes and s.codes[0].logo_frac > 0.24, base=66_000)
save("logo-limit", scene_img(seed, d_logo)[0])
seed = pick_seed(d_logo, lambda s: s.codes and 0.05 < s.codes[0].logo_frac < 0.2, base=66_400)
save("logo-overlay", scene_img(seed, d_logo)[0])

# ---------------------------------------------------------------- capture
d_blur = dataclasses.replace(CLEAN, gauss_blur_p=1.0, blur_sigma_max=2.8)
seed = pick_seed(d_blur, lambda s: s.codes and s.blur_sigma > 2.0, base=64_000)
save("cap-blur", scene_img(seed, d_blur)[0])

d_motion = dataclasses.replace(CLEAN, motion_blur_p=1.0, motion_len_max=17)
seed = pick_seed(d_motion, lambda s: bool(s.codes), base=64_200)
save("cap-motion", scene_img(seed, d_motion)[0])

d_lowres = dataclasses.replace(CLEAN, lowres_p=1.0, lowres_min=0.3)
seed = pick_seed(d_lowres, lambda s: bool(s.codes), base=64_400)
save("cap-lowres", scene_img(seed, d_lowres)[0])

d_noise = dataclasses.replace(CLEAN, noise_std_max=0.13)
seed = pick_seed(d_noise, lambda s: s.codes and s.noise_std > 0.09, base=64_600)
save("cap-noise", scene_img(seed, d_noise)[0])

d_moire = dataclasses.replace(CLEAN, moire_p=1.0)
seed = pick_seed(d_moire, lambda s: bool(s.codes), base=64_800)
save("cap-moire", scene_img(seed, d_moire)[0])

d_vig = dataclasses.replace(CLEAN, vignette_p=1.0, chroma_p=1.0)
seed = pick_seed(d_vig, lambda s: bool(s.codes), base=65_000)
save("cap-vignette", scene_img(seed, d_vig)[0])

# ---------------------------------------------------------------- compression
d_jpeg = dataclasses.replace(CLEAN, jpeg_p=1.0, jpeg_q_min=18)
seed = pick_seed(d_jpeg, lambda s: s.codes and 0 < s.jpeg_q < 26, base=65_200)
save("comp-jpeg", scene_img(seed, d_jpeg)[0])

d_post = dataclasses.replace(CLEAN, posterize_p=1.0)
seed = pick_seed(d_post, lambda s: bool(s.codes), base=65_400)
save("comp-posterize", scene_img(seed, d_post)[0])

# ---------------------------------------------------------------- negatives
for name, kind, aztec, neg_seed in [
    ("neg-barcode", "barcode", None, 40),
    ("neg-matrix", "matrix", False, 41),
    ("neg-aztec", "matrix", True, 46),
    ("neg-fakeqr", "fakeqr", None, 34),
    ("neg-logo", "logo", None, 44),
    ("neg-checker", "checker", None, 45),
]:
    tile = render_negative(np.random.default_rng(neg_seed), kind=kind, force_aztec=aztec)
    save_tile(name, tile)

# ---------------------------------------------------------------- full scenes
for i in range(3):
    seed = pick_seed(TRAIN, lambda s: bool(s.codes), base=70_000 + i * 100)
    save(f"full-train-{i}", scene_img(seed, TRAIN, draw_gt=True)[0])
for i in range(3):
    seed = pick_seed(EVAL_HARD, lambda s: bool(s.codes), base=71_000 + i * 100)
    save(f"full-hard-{i}", scene_img(seed, EVAL_HARD, draw_gt=True)[0])

names = sorted(p.stem for p in OUT.glob("*.jpg"))
(OUT / "manifest.json").write_text(json.dumps(names, indent=1))
print(f"wrote {len(names)} demo images")
