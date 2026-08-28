"""Train the QR corner detector on synthetic scenes.

Usage:
  uv run python -u train.py --smoke          # overfit 64 fixed samples, sanity gate
  uv run python -u train.py                  # full run on the GPU
  uv run python -u train.py --resume runs/qr/last.pt
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from dataset import STRIDE, SynthDataset, decode_np
from model import QrDetector, focal_loss, offset_loss
from synth import EVAL_LIKE_TRAIN, TRAIN

ROOT = Path(__file__).parent
BACKGROUNDS = ROOT / "data" / "backgrounds" / "val2017"

TRAIN_SEED = 1_000_000_000
VAL_SEED = 3_000_000_000  # distinct from train AND from the exported eval sets


def quick_val(model: torch.nn.Module, device: str, n: int = 64) -> dict:
    """Detection rate + mean corner error on a small fixed validation slice."""
    ds = SynthDataset(n, VAL_SEED, EVAL_LIKE_TRAIN, BACKGROUNDS)
    model.eval()
    hits, total, errs = 0, 0, []
    with torch.no_grad():
        for i in range(n):
            img, _, _, _ = ds[i]
            scene = None
            from synth import generate_scene  # local import to reuse ds pool

            scene = generate_scene(i, VAL_SEED, EVAL_LIKE_TRAIN, ds.pool())
            hm, off = model(img[None].to(device).float().div_(255.0))
            dets = decode_np(hm[0].float().cpu().numpy(), off[0].float().cpu().numpy())
            for code in scene.codes:
                total += 1
                best = None
                for det in dets:
                    d = float(np.abs(det["corners"] - code.corners).mean())
                    if best is None or d < best:
                        best = d
                side = float(np.linalg.norm(code.corners[0] - code.corners[2]) / np.sqrt(2))
                if best is not None and best < max(6.0, side * 0.15):
                    hits += 1
                    errs.append(best)
    model.train()
    return {
        "det_rate": hits / max(total, 1),
        "mean_corner_err_px": float(np.mean(errs)) if errs else -1.0,
        "n_codes": total,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=36000)
    ap.add_argument("--batch", type=int, default=28)
    ap.add_argument("--lr", type=float, default=8e-4)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--out", type=str, default="runs/qr")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--resume", type=str, default="")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.smoke:
        args.steps = 1200
        args.batch = 16
        args.workers = 4
        dataset = SynthDataset(
            length=args.steps * args.batch,
            seed_base=TRAIN_SEED,
            difficulty=TRAIN,
            backgrounds=BACKGROUNDS,
            fixed_indices=list(range(64)),
        )
    else:
        dataset = SynthDataset(
            length=args.steps * args.batch,
            seed_base=TRAIN_SEED,
            difficulty=TRAIN,
            backgrounds=BACKGROUNDS,
        )

    loader = DataLoader(
        dataset,
        batch_size=args.batch,
        shuffle=False,  # indices are unique already; the generator is the shuffle
        num_workers=args.workers,
        pin_memory=False,  # pinned pages made the prefetch queue blow past RAM
        persistent_workers=args.workers > 0,
        drop_last=True,
        prefetch_factor=2 if args.workers > 0 else None,
    )

    model = QrDetector(pretrained=True).to(device)
    model = model.to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.steps, eta_min=args.lr / 50)

    start_step = 0
    if args.resume:
        ckpt = torch.load(args.resume, map_location=device, weights_only=True)
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        sched.load_state_dict(ckpt["sched"])
        start_step = ckpt["step"]
        print(f"resumed from {args.resume} at step {start_step}", flush=True)

    log_path = out_dir / "log.jsonl"
    t0 = time.time()
    running: dict[str, float] = {"hm": 0.0, "off": 0.0, "n": 0}

    model.train()
    step = start_step
    for img, hm_t, off_t, mask_t in loader:
        step += 1
        if step > args.steps:
            break
        img = img.to(device, non_blocking=True).float().div_(255.0)
        img = img.to(memory_format=torch.channels_last)
        hm_t = hm_t.to(device, non_blocking=True)
        off_t = off_t.to(device, non_blocking=True)
        mask_t = mask_t.to(device, non_blocking=True)

        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
            hm, off = model(img)
            l_hm = focal_loss(hm.float(), hm_t)
            l_off = offset_loss(off.float(), off_t, mask_t)
            # Point precision is what decodes codes: corner errors of a couple
            # of modules defeat rectification, so offsets outweigh the heatmap.
            loss = l_hm + 2.5 * l_off

        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        opt.step()
        sched.step()

        running["hm"] += float(l_hm)
        running["off"] += float(l_off)
        running["n"] += 1

        if step % 50 == 0:
            n = running["n"]
            ips = args.batch * n / (time.time() - t0)
            msg = {
                "step": step,
                "hm": round(running["hm"] / n, 4),
                "off": round(running["off"] / n, 4),
                "lr": round(sched.get_last_lr()[0], 6),
                "img_per_s": round(ips, 1),
            }
            print(json.dumps(msg), flush=True)
            with log_path.open("a") as f:
                f.write(json.dumps(msg) + "\n")
            running = {"hm": 0.0, "off": 0.0, "n": 0}
            t0 = time.time()

        if not args.smoke and (step % 1000 == 0 or step == args.steps):
            # Checkpoint every 1000 steps: this machine reboots nightly, so a
            # killed run must lose minutes, not hours. Resume with
            # --resume runs/<name>/last.pt. Validation stays on a 4000 cadence.
            torch.save(
                {"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "step": step},
                out_dir / "last.pt",
            )
            if step % 4000 == 0 or step == args.steps:
                val = quick_val(model, device)
                msg = {"step": step, "val": val}
                print(json.dumps(msg), flush=True)
                with log_path.open("a") as f:
                    f.write(json.dumps(msg) + "\n")

    torch.save(
        {"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "step": step},
        out_dir / ("smoke.pt" if args.smoke else "last.pt"),
    )

    if args.smoke:
        val = quick_val(model, device, n=24)
        print(json.dumps({"smoke_val_on_unseen": val}), flush=True)
        # The gate: on the 64 memorized samples the model must nail everything.
        ds = SynthDataset(64, TRAIN_SEED, TRAIN, BACKGROUNDS, fixed_indices=list(range(64)))
        model.eval()
        hits, total = 0, 0
        with torch.no_grad():
            from synth import generate_scene

            for i in range(64):
                scene = generate_scene(i, TRAIN_SEED, TRAIN, ds.pool())
                img, *_ = ds[i]
                hm, off = model(img[None].to(device).float().div_(255.0))
                dets = decode_np(hm[0].float().cpu().numpy(), off[0].float().cpu().numpy(), threshold=0.3)
                for code in scene.codes:
                    total += 1
                    ok = any(float(np.abs(d["corners"] - code.corners).mean()) < 8.0 for d in dets)
                    hits += int(ok)
        rate = hits / max(total, 1)
        print(json.dumps({"smoke_overfit_recall": rate, "codes": total}), flush=True)
        if rate < 0.9:
            raise SystemExit(f"SMOKE FAILED: overfit recall {rate:.2f} < 0.9")
        print("SMOKE PASSED", flush=True)


if __name__ == "__main__":
    main()
