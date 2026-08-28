"""Export the trained detector to ONNX for onnxruntime-web.

Usage: uv run python -u export.py [--ckpt runs/qr-v3/last.pt]

Emits training/qr-detector/export/qr-detector.onnx (committed to the repo;
prepare-models.mjs stages it to /models/qr-detector/ at build time) after
verifying parity between torch and onnxruntime outputs and running the
reference decoder on a synthetic scene as a smoke check.

fp32 on purpose: onnxruntime-web's WASM execution provider has no fp16 Conv
kernel, and the WASM path is what every visitor without WebGPU gets.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime
import torch

from dataset import decode_np
from model import QrDetector
from synth import TRAIN, BackgroundPool, generate_scene

ROOT = Path(__file__).parent
OUT = ROOT / "export" / "qr-detector.onnx"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=str, default="runs/qr-v3/last.pt")
    args = ap.parse_args()

    ckpt = torch.load(ROOT / args.ckpt, map_location="cpu", weights_only=True)
    model = QrDetector(pretrained=False)
    model.load_state_dict(ckpt["model"])
    model.eval()
    print(f"loaded {args.ckpt} at step {ckpt['step']}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    example = torch.zeros(1, 3, 512, 512)
    torch.onnx.export(
        model,
        (example,),
        str(OUT),
        input_names=["input"],
        output_names=["heatmap", "offsets"],
        opset_version=17,
        dynamo=False,
    )
    size_mb = OUT.stat().st_size / 1e6
    print(f"exported {OUT} ({size_mb:.1f} MB)")

    # Parity: torch vs onnxruntime on a real synthetic scene.
    pool = BackgroundPool(ROOT / "data" / "backgrounds" / "val2017")
    scene = generate_scene(7, 123_456, TRAIN, pool)
    x = torch.from_numpy(scene.image.astype(np.float32) / 255.0).permute(2, 0, 1)[None]
    with torch.no_grad():
        t_hm, t_off = model(x)

    sess = onnxruntime.InferenceSession(str(OUT), providers=["CPUExecutionProvider"])
    o_hm, o_off = sess.run(["heatmap", "offsets"], {"input": x.numpy()})

    hm_err = float(np.abs(t_hm.numpy() - o_hm).max())
    off_err = float(np.abs(t_off.numpy() - o_off).max())
    print(f"parity: max |heatmap diff| {hm_err:.2e}, max |offsets diff| {off_err:.2e}")
    if hm_err > 1e-3 or off_err > 1e-3:
        raise SystemExit("EXPORT PARITY FAILED")

    dets = decode_np(o_hm[0], o_off[0])
    print(f"smoke scene: {len(scene.codes)} GT codes, {len(dets)} detections")
    for det in dets[:4]:
        print("  score", round(det["score"], 3), "corners", np.round(det["corners"], 1).tolist())
    print("EXPORT OK")


if __name__ == "__main__":
    main()
