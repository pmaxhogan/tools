"""Random QR payload generation with a realistic shape distribution."""

from __future__ import annotations

import numpy as np

_WORDS = (
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
    "mike november oscar papa quebec romeo sierra tango uniform victor whiskey "
    "xray yankee zulu tools scanner ticket order invoice menu event parking "
    "wifi network garden coffee museum library transit airport gate room desk"
).split()

_TLDS = ["com", "org", "net", "dev", "io", "co", "app", "me", "info"]
_ASCII = "".join(chr(c) for c in range(33, 127))


def _words(rng: np.random.Generator, n: int) -> str:
    return "-".join(rng.choice(_WORDS) for _ in range(n))


def _random_url(rng: np.random.Generator) -> str:
    scheme = "https" if rng.random() < 0.9 else "http"
    host = f"{_words(rng, int(rng.integers(1, 3)))}.{rng.choice(_TLDS)}"
    if rng.random() < 0.3:
        host = "www." + host
    path = ""
    for _ in range(int(rng.integers(0, 4))):
        path += "/" + _words(rng, int(rng.integers(1, 3)))
    if rng.random() < 0.35:
        path += f"?id={rng.integers(1, 10_000_000)}"
        if rng.random() < 0.5:
            path += f"&ref={_words(rng, 1)}"
    return f"{scheme}://{host}{path}"


def _random_wifi(rng: np.random.Generator) -> str:
    sec = rng.choice(["WPA", "WPA2", "WEP", "nopass"], p=[0.6, 0.2, 0.1, 0.1])
    ssid = _words(rng, int(rng.integers(1, 3)))
    if sec == "nopass":
        return f"WIFI:T:nopass;S:{ssid};;"
    pw = "".join(rng.choice(list(_ASCII.replace(";", "").replace(":", ""))) for _ in range(int(rng.integers(8, 24))))
    return f"WIFI:T:{sec};S:{ssid};P:{pw};;"


def _random_text(rng: np.random.Generator) -> str:
    n = int(rng.integers(4, 40))
    return " ".join(rng.choice(_WORDS) for _ in range(n))


def _random_numeric(rng: np.random.Generator) -> str:
    return "".join(str(rng.integers(0, 10)) for _ in range(int(rng.integers(6, 40))))


def _random_vcard(rng: np.random.Generator) -> str:
    first = str(rng.choice(_WORDS)).capitalize()
    last = str(rng.choice(_WORDS)).capitalize()
    return (
        "BEGIN:VCARD\nVERSION:3.0\n"
        f"N:{last};{first};;;\nFN:{first} {last}\n"
        f"TEL:+1{rng.integers(2_000_000_000, 9_999_999_999)}\n"
        f"EMAIL:{first.lower()}@{_words(rng, 1)}.{rng.choice(_TLDS)}\n"
        "END:VCARD"
    )


def _random_tel(rng: np.random.Generator) -> str:
    return f"tel:+{rng.integers(1, 99)}{rng.integers(100_000_000, 9_999_999_999)}"


def random_payload(rng: np.random.Generator) -> str:
    """Sample one payload. URLs dominate, matching real-world QR usage."""
    kind = rng.choice(
        ["url", "wifi", "text", "numeric", "vcard", "tel"],
        p=[0.55, 0.12, 0.15, 0.08, 0.06, 0.04],
    )
    return {
        "url": _random_url,
        "wifi": _random_wifi,
        "text": _random_text,
        "numeric": _random_numeric,
        "vcard": _random_vcard,
        "tel": _random_tel,
    }[kind](rng)
