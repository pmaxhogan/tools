import { describe, expect, it } from "vitest";
import {
  analyzeSamples,
  describeAudioTrack,
  describeLevel,
  describeVideoTrack,
  peakToDb,
  rmsToDb,
  run,
  summarizeDevices,
} from "./index";
import { ToolError } from "../types";

describe("rmsToDb / peakToDb", () => {
  it("converts known amplitudes to dB", () => {
    expect(rmsToDb(1)).toBeCloseTo(0, 5);
    expect(rmsToDb(0.1)).toBeCloseTo(-20, 5);
    expect(peakToDb(1)).toBeCloseTo(0, 5);
    expect(peakToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it("floors at -100 for zero, negative, or non-finite amplitude", () => {
    expect(rmsToDb(0)).toBe(-100);
    expect(rmsToDb(-1)).toBe(-100);
    expect(rmsToDb(NaN)).toBe(-100);
    expect(peakToDb(0)).toBe(-100);
  });
});

describe("describeLevel", () => {
  it("buckets dB readings into the documented ranges", () => {
    expect(describeLevel(-100)).toBe("silent");
    expect(describeLevel(-61)).toBe("silent");
    expect(describeLevel(-60)).toBe("very quiet");
    expect(describeLevel(-45)).toBe("very quiet");
    expect(describeLevel(-40)).toBe("good");
    expect(describeLevel(-20)).toBe("good");
    expect(describeLevel(-12)).toBe("loud");
    expect(describeLevel(-5)).toBe("loud");
    expect(describeLevel(-1)).toBe("loud");
    expect(describeLevel(-0.5)).toBe("clipping");
    expect(describeLevel(0)).toBe("clipping");
  });
});

function sineBuffer(amplitude: number, n = 2000, cycles = 20, offset = 0): Float32Array {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / n) + offset;
  }
  return buf;
}

describe("analyzeSamples", () => {
  it("returns all zeros and silent for a silent buffer", () => {
    const out = analyzeSamples(new Float32Array(256).fill(0));
    expect(out.rms).toBe(0);
    expect(out.peak).toBe(0);
    expect(out.rmsDb).toBe(-100);
    expect(out.peakDb).toBe(-100);
    expect(out.level).toBe("silent");
    expect(out.dcOffset).toBe(0);
    expect(out.clippedCount).toBe(0);
  });

  it("computes RMS and peak for a sine wave of amplitude 0.5", () => {
    const out = analyzeSamples(sineBuffer(0.5));
    // RMS of a sine of amplitude A is A / sqrt(2).
    expect(out.rms).toBeCloseTo(0.5 / Math.sqrt(2), 2);
    expect(out.peak).toBeCloseTo(0.5, 2);
    // rmsDb here is about -9 dB, which the documented thresholds (-12..-1)
    // place in "loud", not "good": half of full scale is a hot signal.
    expect(out.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.sqrt(2)), 1);
    expect(out.level).toBe("loud");
    expect(out.clippedCount).toBe(0);
    expect(out.dcOffset).toBeCloseTo(0, 2);
  });

  it("counts clipped samples and reports the clipping level for a hard-clipped buffer", () => {
    const n = 100;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = i % 2 === 0 ? 1 : -1;
    const out = analyzeSamples(buf);
    expect(out.clippedCount).toBe(n);
    expect(out.rms).toBeCloseTo(1, 5);
    expect(out.peak).toBeCloseTo(1, 5);
    expect(out.level).toBe("clipping");
  });

  it("detects a DC offset biasing the signal away from zero", () => {
    const out = analyzeSamples(sineBuffer(0.1, 2000, 20, 0.3));
    expect(out.dcOffset).toBeCloseTo(0.3, 2);
  });

  it("handles an empty buffer without throwing", () => {
    const out = analyzeSamples(new Float32Array(0));
    expect(out.level).toBe("silent");
    expect(out.clippedCount).toBe(0);
  });
});

describe("describeVideoTrack", () => {
  it("labels a standard 1080p30 track", () => {
    const out = describeVideoTrack({ width: 1920, height: 1080, frameRate: 30, facingMode: "user" });
    expect(out["Resolution"]).toBe("1920 x 1080 (1080p, 16:9)");
    expect(out["Frame rate"]).toBe("30 fps");
    expect(out["Facing"]).toMatch(/Front camera/);
  });

  it("labels a 720p track", () => {
    const out = describeVideoTrack({ width: 1280, height: 720, frameRate: 30 });
    expect(out["Resolution"]).toBe("1280 x 720 (720p, 16:9)");
  });

  it("includes the device ID and environment facing mode when present", () => {
    const out = describeVideoTrack({
      width: 640,
      height: 480,
      facingMode: "environment",
      deviceId: "cam-1",
    });
    expect(out["Facing"]).toMatch(/Rear camera/);
    expect(out["Device ID"]).toBe("cam-1");
  });

  it("falls back to aspect ratio only when width/height are missing", () => {
    const out = describeVideoTrack({ aspectRatio: 16 / 9 });
    expect(out["Aspect ratio"]).toBe("1.78:1");
    expect(out["Resolution"]).toBeUndefined();
  });

  it("reports no details for an empty settings object", () => {
    expect(describeVideoTrack({})).toEqual({ Video: "No video track details reported" });
  });
});

describe("describeAudioTrack", () => {
  it("labels a full settings object", () => {
    const out = describeAudioTrack({
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      deviceId: "mic-1",
    });
    expect(out["Sample rate"]).toBe("48000 Hz");
    expect(out["Channels"]).toBe("1 (mono)");
    expect(out["Echo cancellation"]).toBe("On");
    expect(out["Noise suppression"]).toBe("Off");
    expect(out["Auto gain control"]).toBe("On");
    expect(out["Device ID"]).toBe("mic-1");
  });

  it("labels stereo and multichannel counts", () => {
    expect(describeAudioTrack({ channelCount: 2 })["Channels"]).toBe("2 (stereo)");
    expect(describeAudioTrack({ channelCount: 6 })["Channels"]).toBe("6 (multichannel)");
  });

  it("reports no details for an empty settings object", () => {
    expect(describeAudioTrack({})).toEqual({ Audio: "No audio track details reported" });
  });
});

describe("summarizeDevices", () => {
  it("groups by kind and lists labels when granted", () => {
    const out = summarizeDevices([
      { kind: "videoinput", label: "HD Webcam", deviceId: "d1" },
      { kind: "audioinput", label: "Built-in Mic", deviceId: "d2" },
      { kind: "audiooutput", label: "Speakers", deviceId: "d3" },
    ]);
    expect(out["Cameras"]).toBe("1: HD Webcam");
    expect(out["Microphones"]).toBe("1: Built-in Mic");
    expect(out["Speakers"]).toBe("1: Speakers");
  });

  it("reports a permission notice when labels are empty", () => {
    const out = summarizeDevices([
      { kind: "videoinput", label: "", deviceId: "d1" },
      { kind: "videoinput", label: "", deviceId: "d2" },
    ]);
    expect(out["Cameras"]).toMatch(/2 detected, permission needed to see names/);
  });

  it("reports no devices for an empty or missing list", () => {
    expect(summarizeDevices([])).toEqual({ Devices: "No devices reported" });
    expect(summarizeDevices(null)).toEqual({ Devices: "No devices reported" });
  });
});

describe("run", () => {
  it("explains the panel behavior for empty input", () => {
    const out = run("", {});
    expect(out["Status"]).toMatch(/not recorded|Nothing is recorded/);
    expect(out["Status"]).toMatch(/not uploaded|uploaded/);
  });

  it("throws bad-json on malformed JSON", () => {
    expect(() => run("{not valid", {})).toThrowError(ToolError);
    try {
      run("{not valid", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-json");
      expect((e as ToolError).fix).toBeDefined();
    }
  });

  it("throws not-a-report on JSON without any recognized keys", () => {
    try {
      run(JSON.stringify({ foo: "bar" }), {});
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("throws not-a-report on valid JSON that is not an object", () => {
    try {
      run(JSON.stringify([1, 2, 3]), {});
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("produces a full labeled report from devices, video, audio, and levels", () => {
    const report = {
      devices: [
        { kind: "videoinput", label: "HD Webcam", deviceId: "d1" },
        { kind: "audioinput", label: "Built-in Mic", deviceId: "d2" },
      ],
      video: { width: 1920, height: 1080, frameRate: 30 },
      audio: { sampleRate: 48000, channelCount: 1 },
      levels: { rms: 0.1, peak: 0.3 },
    };
    const out = run(JSON.stringify(report), {});
    expect(out["Cameras"]).toBe("1: HD Webcam");
    expect(out["Microphones"]).toBe("1: Built-in Mic");
    expect(out["Video: Resolution"]).toBe("1920 x 1080 (1080p, 16:9)");
    expect(out["Audio: Sample rate"]).toBe("48000 Hz");
    expect(out["Mic level (RMS)"]).toMatch(/-20\.0 dB, good/);
    expect(out["Mic level (peak)"]).toMatch(/dB/);
  });

  it("filters to the summary keys when detail is summary", () => {
    const report = {
      video: { width: 1920, height: 1080, frameRate: 30 },
      audio: { sampleRate: 48000 },
      levels: { rms: 0.1, peak: 0.3 },
    };
    const full = run(JSON.stringify(report), { detail: "full" });
    const summary = run(JSON.stringify(report), { detail: "summary" });
    expect(Object.keys(summary).length).toBeLessThan(Object.keys(full).length);
    expect(summary["Video: Resolution"]).toBe("1920 x 1080 (1080p, 16:9)");
    expect(summary["Audio: Sample rate"]).toBe("48000 Hz");
  });

  it("reports when the report object has a recognized key but no readable data", () => {
    const out = run(JSON.stringify({ devices: [] }), {});
    expect(out["Devices"]).toBe("No devices reported");
  });

  it("falls back to a Report explanation when every recognized field is null", () => {
    const out = run(JSON.stringify({ video: null, audio: null }), {});
    expect(out["Report"]).toMatch(/did not include any readable/);
  });
});
