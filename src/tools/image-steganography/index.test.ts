import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  bytesToBase64,
  capacityBytes,
  crc32,
  describeEmbed,
  describeExtract,
  embed,
  embedWithReport,
  extract,
  formatWarning,
  headerBytesFor,
  isText,
  payloadCapacityBytes,
  payloadFromText,
  psnr,
  run,
  textFromPayload,
  visualizeLsb,
  type BitDepth,
  type ChannelSet,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** xorshift32, so every "random" fixture is byte for byte reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** A w by h opaque RGBA buffer of deterministic noise, like a photo's low bits. */
function noise(w: number, h: number, seed = 12345): Uint8ClampedArray {
  const next = prng(seed);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = next() & 0xff;
    out[i * 4 + 1] = next() & 0xff;
    out[i * 4 + 2] = next() & 0xff;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A w by h RGBA buffer filled with one opaque color. */
function solid(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function randomBytes(length: number, seed = 999): Uint8Array {
  const next = prng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = next() & 0xff;
  return out;
}

const ALL_CHANNELS: ChannelSet[] = ["rgb", "rgba", "r", "g", "b"];
const ALL_BITS: BitDepth[] = [1, 2];

/* ------------------------------------------------------------------ *
 * capacity
 * ------------------------------------------------------------------ */

describe("capacityBytes", () => {
  it("is exactly the floor of pixels times channels times bits over eight", () => {
    expect(capacityBytes(10, 10, 1, "rgb")).toBe(37);
    expect(capacityBytes(10, 10, 2, "rgb")).toBe(75);
    expect(capacityBytes(4, 4, 2, "rgba")).toBe(16);
    expect(capacityBytes(100, 100, 2, "rgb")).toBe(7500);
    expect(capacityBytes(64, 64, 1, "b")).toBe(512);
  });

  it("floors a partial byte away", () => {
    expect(capacityBytes(2, 2, 1, "r")).toBe(0);
    expect(capacityBytes(3, 1, 1, "rgb")).toBe(1);
  });

  it("subtracts the header for the payload capacity, with the nonce when encrypted", () => {
    expect(headerBytesFor(false)).toBe(13);
    expect(headerBytesFor(true)).toBe(21);
    expect(payloadCapacityBytes(10, 10, 1, "rgb")).toBe(24);
    expect(payloadCapacityBytes(10, 10, 1, "rgb", true)).toBe(16);
    expect(payloadCapacityBytes(2, 2, 1, "r")).toBe(0);
  });

  it("rejects impossible sizes and settings", () => {
    expect(() => capacityBytes(0, 10, 1, "rgb")).toThrow(ToolError);
    expect(() => capacityBytes(10, 10, 3 as BitDepth, "rgb")).toThrow(ToolError);
    expect(() => capacityBytes(10, 10, 1, "yellow" as ChannelSet)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ *
 * round trips
 * ------------------------------------------------------------------ */

describe("embed and extract", () => {
  it("round trips text at every bit depth and channel set", () => {
    const message = "Meet me at the old bridge, 21:30. Bring the map.";
    for (const bits of ALL_BITS) {
      for (const channels of ALL_CHANNELS) {
        const carrier = noise(64, 64, 7 + bits);
        const stego = embed(carrier, payloadFromText(message), {
          bitsPerChannel: bits,
          channels,
        });
        const result = extract(stego);
        expect(textFromPayload(result.payload)).toBe(message);
        expect(result.meta).toEqual({ bits, channels, encrypted: false, crcOk: true });
      }
    }
  });

  it("round trips arbitrary bytes", () => {
    const payload = randomBytes(500);
    const stego = embed(noise(64, 64), payload, { bitsPerChannel: 2, channels: "rgba" });
    const result = extract(stego);
    expect(Array.from(result.payload)).toEqual(Array.from(payload));
    expect(result.meta.bits).toBe(2);
    expect(result.meta.channels).toBe("rgba");
    expect(result.meta.crcOk).toBe(true);
    expect(isText(result.payload)).toBe(false);
  });

  it("round trips unicode text", () => {
    const message = "smuggling an emoji \u{1F510} and an umlaut ü";
    const stego = embed(noise(32, 32), payloadFromText(message), {
      bitsPerChannel: 1,
      channels: "rgb",
    });
    expect(textFromPayload(extract(stego).payload)).toBe(message);
  });

  it("fills a carrier exactly to its capacity", () => {
    const carrier = noise(16, 16);
    const capacity = capacityBytes(16, 16, 1, "rgb");
    const payload = randomBytes(capacity - headerBytesFor(false), 31);
    const result = embedWithReport(carrier, payload, { bitsPerChannel: 1, channels: "rgb" });
    expect(result.usedBytes).toBe(capacity);
    expect(result.fillPercent).toBeCloseTo(100, 6);
    expect(Array.from(extract(result.rgba).payload)).toEqual(Array.from(payload));
  });

  it("copies the carrier instead of mutating it and only touches the low bits", () => {
    const carrier = noise(32, 32);
    const before = Uint8ClampedArray.from(carrier);
    const stego = embed(carrier, payloadFromText("quiet"), {
      bitsPerChannel: 2,
      channels: "rgb",
    });
    expect(Array.from(carrier)).toEqual(Array.from(before));
    expect(stego).not.toBe(carrier);
    expect(stego.length).toBe(carrier.length);
    for (let i = 0; i < carrier.length; i += 1) {
      const isAlpha = i % 4 === 3;
      if (isAlpha) expect(stego[i]).toBe(carrier[i]);
      else expect(stego[i]! >> 2).toBe(carrier[i]! >> 2);
    }
  });

  it("refuses a payload that does not fit, naming both figures", () => {
    try {
      embed(noise(4, 4), randomBytes(20), { bitsPerChannel: 1, channels: "rgb" });
      expect.unreachable("a 20 byte payload cannot fit in a 4 by 4 image");
    } catch (error) {
      const err = error as ToolError;
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe("too-large");
      expect(err.message).toBe("The payload needs 33 bytes of capacity but this image offers 6.");
      expect(err.fix).toBe("Use a bigger image, 2 bits per channel, or a shorter message.");
    }
  });

  it("refuses an empty payload and a buffer that is not RGBA", () => {
    expect(() =>
      embed(noise(16, 16), new Uint8Array(0), { bitsPerChannel: 1, channels: "rgb" }),
    ).toThrow(ToolError);
    expect(() =>
      embed(new Uint8ClampedArray(7), payloadFromText("x"), {
        bitsPerChannel: 1,
        channels: "rgb",
      }),
    ).toThrow(ToolError);
  });

  it("finds nothing in an untouched image", () => {
    try {
      extract(solid(16, 16, 200, 100, 40));
      expect.unreachable("a plain image holds no frame");
    } catch (error) {
      const err = error as ToolError;
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe("nothing-found");
      expect(err.fix).toContain("JPEG");
    }
  });

  it("reports a broken checksum rather than pretending the payload is intact", () => {
    const stego = embed(noise(20, 20), randomBytes(30, 5), {
      bitsPerChannel: 1,
      channels: "rgb",
    });
    // Slot 104 is the first payload bit: pixel 34, blue channel.
    stego[34 * 4 + 2] = stego[34 * 4 + 2]! ^ 1;
    const result = extract(stego);
    expect(result.meta.crcOk).toBe(false);
    expect(result.payload.length).toBe(30);
    expect(describeExtract(result).Checksum).toContain("does not match");
  });
});

/* ------------------------------------------------------------------ *
 * passwords
 * ------------------------------------------------------------------ */

describe("password protection", () => {
  const secret = "the account number is 4417 9931";

  it("round trips with the right password", () => {
    const stego = embed(noise(48, 48), payloadFromText(secret), {
      bitsPerChannel: 1,
      channels: "rgb",
      password: "correct horse",
    });
    const result = extract(stego, { password: "correct horse" });
    expect(textFromPayload(result.payload)).toBe(secret);
    expect(result.meta.encrypted).toBe(true);
    expect(result.meta.crcOk).toBe(true);
  });

  it("does not leave the plaintext in the image", () => {
    const carrier = noise(48, 48);
    const plain = embed(carrier, payloadFromText(secret), {
      bitsPerChannel: 1,
      channels: "rgb",
    });
    const sealed = embed(carrier, payloadFromText(secret), {
      bitsPerChannel: 1,
      channels: "rgb",
      password: "correct horse",
    });
    expect(Array.from(sealed)).not.toEqual(Array.from(plain));
  });

  it("rejects the wrong password", () => {
    const stego = embed(noise(48, 48), payloadFromText(secret), {
      bitsPerChannel: 1,
      channels: "rgb",
      password: "correct horse",
    });
    try {
      extract(stego, { password: "battery staple" });
      expect.unreachable("the CRC cannot match under the wrong keystream");
    } catch (error) {
      const err = error as ToolError;
      expect(err).toBeInstanceOf(ToolError);
      expect(err.code).toBe("bad-password");
      expect(err.message).toContain("did not decrypt");
    }
  });

  it("says so when a password is needed and none was given", () => {
    const stego = embed(noise(48, 48), payloadFromText(secret), {
      bitsPerChannel: 2,
      channels: "rgb",
      password: "correct horse",
    });
    try {
      extract(stego);
      expect.unreachable("an encrypted frame cannot be read without the password");
    } catch (error) {
      const err = error as ToolError;
      expect(err.code).toBe("bad-password");
      expect(err.message).toContain("password protected");
    }
  });

  it("ignores a password on an unencrypted frame", () => {
    const stego = embed(noise(32, 32), payloadFromText("open"), {
      bitsPerChannel: 1,
      channels: "rgb",
    });
    expect(textFromPayload(extract(stego, { password: "anything" }).payload)).toBe("open");
  });

  it("uses a random nonce by default and a reproducible one with a seed", () => {
    const carrier = noise(48, 48);
    const opts = { bitsPerChannel: 1, channels: "rgb", password: "pw" } as const;
    const a = embed(carrier, payloadFromText(secret), opts);
    const b = embed(carrier, payloadFromText(secret), opts);
    expect(Array.from(a)).not.toEqual(Array.from(b));

    const seeded1 = embed(carrier, payloadFromText(secret), { ...opts, seed: "fixture" });
    const seeded2 = embed(carrier, payloadFromText(secret), { ...opts, seed: "fixture" });
    expect(Array.from(seeded1)).toEqual(Array.from(seeded2));
  });
});

/* ------------------------------------------------------------------ *
 * measurement and visualization
 * ------------------------------------------------------------------ */

describe("psnr", () => {
  it("stays far above 40 dB for a small payload", () => {
    const carrier = noise(64, 64);
    const result = embedWithReport(carrier, payloadFromText("a short note"), {
      bitsPerChannel: 1,
      channels: "rgb",
    });
    expect(result.psnr).toBeGreaterThan(40);
    expect(psnr(carrier, result.rgba)).toBeCloseTo(result.psnr, 9);
  });

  it("is infinite for two identical buffers", () => {
    const carrier = noise(8, 8);
    expect(psnr(carrier, Uint8ClampedArray.from(carrier))).toBe(Infinity);
  });

  it("refuses buffers of different sizes", () => {
    expect(() => psnr(noise(8, 8), noise(4, 4))).toThrow(ToolError);
  });
});

describe("visualizeLsb", () => {
  it("returns only black and white opaque pixels", () => {
    const view = visualizeLsb(noise(16, 16));
    expect(view.length).toBe(16 * 16 * 4);
    for (let i = 0; i < view.length; i += 4) {
      expect([0, 255]).toContain(view[i]);
      expect(view[i + 1]).toBe(view[i]);
      expect(view[i + 2]).toBe(view[i]);
      expect(view[i + 3]).toBe(255);
    }
  });

  it("reads a single channel when asked", () => {
    const flat = solid(4, 4, 1, 0, 0);
    expect(visualizeLsb(flat, 0, "r")[0]).toBe(255);
    expect(visualizeLsb(flat, 0, "g")[0]).toBe(0);
    expect(visualizeLsb(flat, 1, "r")[0]).toBe(0);
  });

  it("rejects a bit that does not exist", () => {
    expect(() => visualizeLsb(noise(4, 4), 8)).toThrow(ToolError);
  });
});

describe("formatWarning", () => {
  it("warns for every format that rewrites pixels", () => {
    expect(formatWarning("image/jpeg")).toContain("lossy");
    expect(formatWarning("image/webp")).toContain("PNG");
    expect(formatWarning("image/avif")).toContain("PNG");
    expect(formatWarning("image/gif")).toContain("256 colors");
    expect(formatWarning("IMAGE/JPEG; charset=binary")).toContain("JPEG");
  });

  it("stays quiet for lossless formats", () => {
    expect(formatWarning("image/png")).toBeNull();
    expect(formatWarning("image/bmp")).toBeNull();
    expect(formatWarning("")).toBeNull();
  });
});

describe("payload helpers", () => {
  it("round trips UTF-8 and rejects bytes that are not text", () => {
    expect(textFromPayload(payloadFromText("café"))).toBe("café");
    expect(crc32(payloadFromText("123456789"))).toBe(0xcbf43926);
    const junk = new Uint8Array([0xff, 0xfe, 0xff]);
    expect(isText(junk)).toBe(false);
    expect(() => textFromPayload(junk)).toThrow(ToolError);
  });
});

describe("describeEmbed", () => {
  it("reports the settings, the fill, and the PNG rule", () => {
    const rows = describeEmbed(
      embedWithReport(noise(64, 64), payloadFromText("hello"), {
        bitsPerChannel: 2,
        channels: "rgb",
        password: "pw",
        seed: "fixture",
      }),
    );
    expect(rows.Hidden).toBe("5 bytes");
    expect(rows["Bits used"]).toContain("2 bits per channel");
    expect(rows.Capacity).toContain("21 byte header");
    expect(rows.Encryption).toContain("SHA-256");
    expect(rows["Save as"]).toContain("PNG");
    expect(rows.Transparency).toBeUndefined();
  });

  it("warns about transparency, which canvas can premultiply away", () => {
    const carrier = noise(32, 32);
    carrier[3] = 0;
    const rows = describeEmbed(
      embedWithReport(carrier, payloadFromText("hi"), { bitsPerChannel: 1, channels: "rgb" }),
    );
    expect(rows.Transparency).toContain("premultiplies");
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  const carrier = noise(24, 24);
  const base = { width: 24, height: 24, rgbaBase64: bytesToBase64(carrier) };

  it("hides through the JSON payload and reveals it again", () => {
    const hidden = run(JSON.stringify({ ...base, mode: "hide", text: "over the wall" }), {
      bits: "1",
      channels: "rgb",
    });
    expect(hidden.Hidden).toBe("13 bytes");
    const stego = hidden["Stego pixels"] as string;
    expect(stego).not.toContain("too large");

    const revealed = run(
      JSON.stringify({ width: 24, height: 24, rgbaBase64: stego, mode: "reveal" }),
    );
    expect(revealed.Message).toBe("over the wall");
    expect(revealed.Checksum).toContain("matches");
  });

  it("accepts mode synonyms and a password", () => {
    const hidden = run(
      JSON.stringify({ ...base, mode: "encode", text: "sealed", password: "pw", seed: "s" }),
    );
    const stego = hidden["Stego pixels"] as string;
    const revealed = run(
      JSON.stringify({
        width: 24,
        height: 24,
        rgbaBase64: stego,
        mode: "decode",
        password: "pw",
      }),
    );
    expect(revealed.Message).toBe("sealed");
    expect(revealed.Encryption).toContain("decrypted");
  });

  it("hides raw bytes given as base64", () => {
    const payload = randomBytes(40, 77);
    const hidden = run(
      JSON.stringify({ ...base, mode: "hide", bytesBase64: bytesToBase64(payload) }),
      { bits: 2, channels: "rgba" },
    );
    const revealed = run(
      JSON.stringify({
        width: 24,
        height: 24,
        rgbaBase64: hidden["Stego pixels"],
        mode: "reveal",
      }),
    );
    expect(revealed.Recovered).toBe("40 bytes");
    expect(revealed.Settings).toContain("2 bits per channel");
    expect(revealed["First bytes"]).toBeDefined();
  });

  it("points at the panel for anything that is not the JSON payload", () => {
    for (const bad of ["", "   ", "not json at all", "[1,2,3]", '{"width":24}']) {
      try {
        run(bad);
        expect.unreachable(`"${bad}" is not a hide request`);
      } catch (error) {
        const err = error as ToolError;
        expect(err).toBeInstanceOf(ToolError);
        expect(err.code).toBe("use-panel");
        expect(err.message).toBe("This tool needs an image and a message; use the panel above.");
      }
    }
  });

  it("rejects a payload whose pixel data does not match the stated size", () => {
    try {
      run(JSON.stringify({ width: 4, height: 4, rgbaBase64: bytesToBase64(carrier) }));
      expect.unreachable("the buffer is far bigger than 4 by 4");
    } catch (error) {
      expect((error as ToolError).code).toBe("invalid-image");
    }
  });

  it("rejects a hide with nothing to hide and an unknown mode", () => {
    expect(() => run(JSON.stringify({ ...base, mode: "hide" }))).toThrow(ToolError);
    expect(() => run(JSON.stringify({ ...base, mode: "sideways" }))).toThrow(ToolError);
  });

  it("accepts a Uint8Array of the same JSON", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...base, mode: "hide", text: "bytes in" }),
    );
    expect(run(bytes).Hidden).toBe("8 bytes");
  });
});
