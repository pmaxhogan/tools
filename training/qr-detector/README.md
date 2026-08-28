# QR corner detector

The neural half of the QR scanner's deep scan on tools.maxhogan.dev: a
CenterNet-style detector that finds every QR code in an image and regresses 8
points per code (4 corners plus 4 on-curve edge midpoints), so the browser can
rectify perspective AND cylindrical bow before handing the crop to the
classical decoders (zxing-wasm, jsQR).

## Why train from scratch

Surveyed before building, decided against reusing:

- **WeChat's CNN detector** (OpenCV contrib `wechat_qrcode`): strong, but the
  models are Caffe format with real conversion cost to a browser runtime, the
  detector regresses boxes rather than corners (rectification needs corners),
  and there is no curvature output at all.
- **QReader / YOLOv8-based detectors**: pretrained weights inherit the
  Ultralytics AGPL license, which this site does not want to take on, and the
  pose variants still only give planar keypoints.
- **Classical-only (zxing-cpp)**: shipped as the standard pass regardless, but
  its finder-pattern search is exactly what fails on tiny, blurred, low
  contrast, or wrapped codes; the detector exists to feed it clean crops.

Training from scratch also let the label set include edge-midpoint bow, which
none of the pretrained options provide, and Max asked for a purpose-trained
model anyway.

## Layout

| file | role |
| --- | --- |
| `payloads.py` | realistic random payload distribution (URL 55%, Wi-Fi, text, numeric, vCard, tel) |
| `qr_render.py` | segno matrix to styled RGB tile (square/rounded/dot modules, colors, quiet zone), plus the hard-negative renderer (barcodes, DataMatrix/Aztec lookalikes, finderless fake QRs, logos, checkerboards) |
| `synth.py` | scene synthesis: compositing, perspective + true perspective-cylinder warps, center logos sized to the ECC limits, lighting, capture and compression degradation, letterboxing; TRAIN vs EVAL_HARD difficulty ranges |
| `dataset.py` | torch dataset, target encoding (stride-4 heatmap + 16ch point offsets), and `decode_np`, the reference decoder mirrored by `src/tools/qr-code-scanner/detector.ts` |
| `model.py` | MobileNetV3-Large backbone + FPN to stride 4, heatmap + offset heads (~3.9M params, 15.4 MB fp32) |
| `train.py` | training loop (bf16 autocast, cosine LR), `--smoke` overfit gate, periodic val |
| `build_bg_cache.py` | one-time memmap of the COCO val2017 backgrounds |
| `make_eval_set.py` | exports the held-out eval sets (disjoint seeds; `hard` also shifts every range harder) |
| `export.py` | ONNX export (fp32, opset 17) with torch/onnxruntime parity check; output committed at `export/qr-detector.onnx` |
| `eval-js/run.ts` | Node harness scoring the actual JS pipeline (jsQR vs +zxing vs +deep) against the eval sets |
| `gen_demo.py` + `atlas_template.html` | the distortion atlas artifact |

## Running

```sh
uv sync                                   # torch cu128 + deps (Python 3.12)
uv run python -u build_bg_cache.py        # once, after downloading val2017
uv run python -u train.py --smoke         # overfit sanity gate, ~3 min
uv run python -u train.py --steps 30000 --batch 64 --lr 0.0012 --workers 18 --out runs/qr-v3
uv run python -u export.py --ckpt runs/qr-v3/last.pt
uv run python -u make_eval_set.py
cd eval-js && npm install && npx -y tsx run.ts
```

Backgrounds: `data/backgrounds/val2017` is the COCO val2017 image set
(https://images.cocodataset.org/zips/val2017.zip), used as photographic
compositing backgrounds at train time only. Nothing from it ships.

The real-photo check uses BoofCV's QR benchmark set
(https://boofcv.org/index.php?title=Performance:QrCode), extracted to
`data/boofcv-qr/`, scored by `eval-js/run-boofcv.ts`.

Only sources, this README, and `export/qr-detector.onnx` are committed;
`data/`, `runs/`, and the venv are gitignored. Results live in `RESULTS.md`.
