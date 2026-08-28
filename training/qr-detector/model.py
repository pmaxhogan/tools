"""CenterNet-style QR detector: MobileNetV3-Large backbone, FPN to stride 4,
two heads: center heatmap (1ch) and corner offsets (8ch, output-grid units).

Everything is plain Conv/BN/ReLU/upsample so the ONNX export runs on
onnxruntime-web's WASM execution provider without exotic kernels.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import MobileNet_V3_Large_Weights, mobilenet_v3_large

STRIDE = 4
FPN_CH = 128


class QrDetector(nn.Module):
    def __init__(self, pretrained: bool = True):
        super().__init__()
        weights = MobileNet_V3_Large_Weights.IMAGENET1K_V1 if pretrained else None
        backbone = mobilenet_v3_large(weights=weights).features
        self.backbone = backbone
        # Feature tap points (verified against torchvision's layer table):
        #   idx 3 -> 24ch stride 4, idx 6 -> 40ch stride 8,
        #   idx 12 -> 112ch stride 16, idx 16 -> 960ch stride 32.
        self.taps = {3: 24, 6: 40, 12: 112, 16: 960}

        self.lat = nn.ModuleDict(
            {str(i): nn.Conv2d(ch, FPN_CH, 1) for i, ch in self.taps.items()}
        )
        self.smooth = nn.ModuleList(
            [
                nn.Sequential(
                    nn.Conv2d(FPN_CH, FPN_CH, 3, padding=1),
                    nn.BatchNorm2d(FPN_CH),
                    nn.ReLU(inplace=True),
                )
                for _ in range(3)
            ]
        )

        def head(out_ch: int) -> nn.Sequential:
            return nn.Sequential(
                nn.Conv2d(FPN_CH, FPN_CH, 3, padding=1),
                nn.ReLU(inplace=True),
                nn.Conv2d(FPN_CH, out_ch, 1),
            )

        self.hm_head = head(1)
        # 8 points x 2: corners TL,TR,BR,BL then edge midpoints T,R,B,L.
        self.off_head = head(16)
        # Focal-loss prior: start the heatmap near P=0.01 everywhere.
        nn.init.constant_(self.hm_head[-1].bias, -4.6)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        feats: dict[int, torch.Tensor] = {}
        for i, layer in enumerate(self.backbone):
            x = layer(x)
            if i in self.taps:
                feats[i] = x

        p = self.lat["16"](feats[16])
        for k, (idx) in enumerate([12, 6, 3]):
            p = F.interpolate(p, scale_factor=2.0, mode="nearest")
            p = p + self.lat[str(idx)](feats[idx])
            p = self.smooth[k](p)

        hm = self.hm_head(p)  # logits; sigmoid applied by the loss / decoder
        off = self.off_head(p)
        return hm, off


def focal_loss(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """CornerNet-style focal loss on a gaussian-splatted heatmap."""
    prob = torch.sigmoid(logits).clamp(1e-5, 1 - 1e-5)
    pos = target.eq(1.0)
    pos_loss = -((1 - prob) ** 2) * torch.log(prob) * pos
    neg_weight = (1 - target) ** 4
    neg_loss = -(prob**2) * torch.log(1 - prob) * neg_weight * (~pos)
    n_pos = pos.sum().clamp(min=1)
    return (pos_loss.sum() + neg_loss.sum()) / n_pos


def offset_loss(off: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Masked L1 on point offsets, normalized by the number of supervised cells."""
    n = mask.sum().clamp(min=1)
    return (F.l1_loss(off, target, reduction="none") * mask).sum() / (n * 16)
