import { describe, expect, it } from "vitest";
import {
  describeEvent,
  describeSupport,
  KEYBOARD_MEDIA_KEYS,
  MEDIA_ACTIONS,
  run,
  summarizeLog,
  type MediaKeyEvent,
} from "./index";
import { ToolError } from "../types";

describe("MEDIA_ACTIONS", () => {
  it("has no duplicate action values", () => {
    const actions = MEDIA_ACTIONS.map((a) => a.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("includes every action from the spec", () => {
    const actions = MEDIA_ACTIONS.map((a) => a.action);
    expect(actions).toEqual([
      "play",
      "pause",
      "stop",
      "seekbackward",
      "seekforward",
      "seekto",
      "previoustrack",
      "nexttrack",
      "skipad",
      "togglemicrophone",
      "togglecamera",
      "hangup",
      "previousslide",
      "nextslide",
      "enterpictureinpicture",
    ]);
  });

  it("marks the conferencing, slide, and picture-in-picture actions as possibly unsupported", () => {
    const flagged = MEDIA_ACTIONS.filter((a) => a.mayBeUnsupported).map((a) => a.action);
    expect(flagged).toEqual([
      "skipad",
      "togglemicrophone",
      "togglecamera",
      "hangup",
      "previousslide",
      "nextslide",
      "enterpictureinpicture",
    ]);
  });

  it("does not flag the common playback actions as unsupported", () => {
    const common = MEDIA_ACTIONS.filter((a) =>
      ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"].includes(
        a.action,
      ),
    );
    for (const a of common) expect(a.mayBeUnsupported).toBeFalsy();
  });

  it("every action has a non-empty label and keyHint", () => {
    for (const a of MEDIA_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.keyHint.length).toBeGreaterThan(0);
    }
  });
});

describe("KEYBOARD_MEDIA_KEYS", () => {
  it("has no duplicate key values", () => {
    const keys = KEYBOARD_MEDIA_KEYS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes the expected keyboard media keys", () => {
    const keys = KEYBOARD_MEDIA_KEYS.map((k) => k.key);
    expect(keys).toEqual([
      "MediaPlayPause",
      "MediaPlay",
      "MediaPause",
      "MediaStop",
      "MediaTrackNext",
      "MediaTrackPrevious",
      "AudioVolumeUp",
      "AudioVolumeDown",
      "AudioVolumeMute",
    ]);
  });
});

describe("describeEvent", () => {
  it("formats a mediasession event", () => {
    const e: MediaKeyEvent = { source: "mediasession", action: "play", timestamp: 0 };
    expect(describeEvent(e)).toBe("[1970-01-01T00:00:00.000Z] Media Session action fired: play");
  });

  it("formats a mediasession event with details", () => {
    const e: MediaKeyEvent = {
      source: "mediasession",
      action: "seekto",
      timestamp: 0,
      details: { seekTime: 12.5 },
    };
    expect(describeEvent(e)).toBe(
      '[1970-01-01T00:00:00.000Z] Media Session action fired: seekto {"seekTime":12.5}',
    );
  });

  it("formats a keyboard event with key and code", () => {
    const e: MediaKeyEvent = {
      source: "keyboard",
      key: "MediaPlayPause",
      code: "MediaPlayPause",
      timestamp: 0,
    };
    expect(describeEvent(e)).toBe(
      '[1970-01-01T00:00:00.000Z] Keyboard event: key="MediaPlayPause" (code: MediaPlayPause)',
    );
  });

  it("formats a keyboard event with no code", () => {
    const e: MediaKeyEvent = { source: "keyboard", key: "AudioVolumeUp", timestamp: 0 };
    expect(describeEvent(e)).toBe('[1970-01-01T00:00:00.000Z] Keyboard event: key="AudioVolumeUp"');
  });

  it("falls back to placeholders for missing action/key", () => {
    expect(describeEvent({ source: "mediasession", timestamp: 0 })).toContain("(unknown action)");
    expect(describeEvent({ source: "keyboard", timestamp: 0 })).toContain("(unknown key)");
  });
});

describe("summarizeLog", () => {
  it("verdict: hardware keys reach the page via Media Session", () => {
    const events: MediaKeyEvent[] = [
      { source: "mediasession", action: "play", timestamp: 100 },
      { source: "mediasession", action: "pause", timestamp: 200 },
    ];
    const rows = summarizeLog(events);
    expect(rows["Media Session events"]).toBe("2");
    expect(rows["Keyboard events"]).toBe("0");
    expect(rows["Actions fired"]).toBe("play, pause");
    expect(rows["Verdict"]).toContain("Hardware keys reach the page via Media Session");
  });

  it("verdict: keys reach the page as KeyboardEvents only", () => {
    const events: MediaKeyEvent[] = [
      { source: "keyboard", key: "MediaPlayPause", timestamp: 100 },
    ];
    const rows = summarizeLog(events);
    expect(rows["Media Session events"]).toBe("0");
    expect(rows["Keyboard events"]).toBe("1");
    expect(rows["Verdict"]).toContain("Keys reach the page as KeyboardEvents only");
  });

  it("verdict: nothing received", () => {
    const rows = summarizeLog([]);
    expect(rows["Media Session events"]).toBe("0");
    expect(rows["Keyboard events"]).toBe("0");
    expect(rows["Verdict"]).toContain("Nothing received");
    expect(rows["First event"]).toBe("(none received)");
    expect(rows["Last event"]).toBe("(none received)");
  });

  it("lists handlers that never fired, and reports none when every action fired", () => {
    const onlyPlay = summarizeLog([{ source: "mediasession", action: "play", timestamp: 0 }]);
    expect(onlyPlay["Handlers that never fired"]).toContain("pause");
    expect(onlyPlay["Handlers that never fired"]).toContain("nexttrack");

    const allFired = summarizeLog(
      MEDIA_ACTIONS.map((a, i) => ({ source: "mediasession" as const, action: a.action, timestamp: i })),
    );
    expect(allFired["Handlers that never fired"]).toBe(
      "none: every registered handler fired at least once",
    );
  });

  it("reports first and last events by timestamp regardless of input order", () => {
    const events: MediaKeyEvent[] = [
      { source: "mediasession", action: "nexttrack", timestamp: 300 },
      { source: "mediasession", action: "play", timestamp: 100 },
      { source: "keyboard", key: "MediaStop", timestamp: 200 },
    ];
    const rows = summarizeLog(events);
    expect(rows["First event"]).toContain("play");
    expect(rows["Last event"]).toContain("nexttrack");
  });
});

describe("describeSupport", () => {
  it("reports full support with actions listed", () => {
    const rows = describeSupport({
      mediaSession: true,
      supportedActions: ["play", "pause"],
      unsupportedActions: ["hangup"],
    });
    expect(rows["Media Session API"]).toBe("Supported by this browser.");
    expect(rows["Supported actions"]).toBe("play, pause");
    expect(rows["Unsupported actions"]).toBe("hangup");
    expect(rows["Action coverage"]).toBe("2 of 3 attempted actions registered successfully.");
  });

  it("reports no Media Session support", () => {
    const rows = describeSupport({ mediaSession: false, supportedActions: [], unsupportedActions: [] });
    expect(rows["Media Session API"]).toContain("Not supported");
    expect(rows["Supported actions"]).toBe("none reported");
    expect(rows["Unsupported actions"]).toBe("none reported");
    expect(rows["Action coverage"]).toBe("No actions were attempted.");
  });
});

describe("run", () => {
  it("returns a Note with instructions on empty input", () => {
    const out = run("", {});
    expect(out["Note"]).toBeDefined();
    expect(out["Note"]).toContain("Click play");
  });

  it("returns a Note on whitespace-only input", () => {
    const out = run("   ", {});
    expect(out["Note"]).toBeDefined();
  });

  it("analyzes a report with only caps", () => {
    const out = run(
      JSON.stringify({ caps: { mediaSession: true, supportedActions: ["play"], unsupportedActions: [] } }),
      {},
    );
    expect(out["Media Session API"]).toBe("Supported by this browser.");
    expect(out["Verdict"]).toBeUndefined();
  });

  it("analyzes a report with only events", () => {
    const out = run(
      JSON.stringify({ events: [{ source: "mediasession", action: "play", timestamp: 0 }] }),
      {},
    );
    expect(out["Verdict"]).toContain("Hardware keys reach the page via Media Session");
    expect(out["Media Session API"]).toBeUndefined();
  });

  it("analyzes a full report with both caps and events", () => {
    const out = run(
      JSON.stringify({
        caps: { mediaSession: true, supportedActions: ["play", "pause"], unsupportedActions: ["hangup"] },
        events: [
          { source: "mediasession", action: "play", timestamp: 0 },
          { source: "keyboard", key: "AudioVolumeUp", timestamp: 10 },
        ],
      }),
      {},
    );
    expect(out["Media Session API"]).toBe("Supported by this browser.");
    expect(out["Media Session events"]).toBe("1");
    expect(out["Keyboard events"]).toBe("1");
    expect(out["Verdict"]).toContain("Hardware keys reach the page via Media Session");
  });

  it("throws bad-json on malformed JSON", () => {
    expect(() => run("{not valid json", {})).toThrowError(ToolError);
    try {
      run("{not valid json", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-json");
    }
  });

  it("throws not-a-report on a JSON array", () => {
    try {
      run("[1,2,3]", {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("throws not-a-report on a JSON object with no recognized fields", () => {
    try {
      run(JSON.stringify({ foo: "bar" }), {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("throws not-a-report on a bare JSON primitive", () => {
    try {
      run("42", {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("tolerates malformed inner fields instead of throwing", () => {
    const out = run(
      JSON.stringify({
        caps: { mediaSession: "yes", supportedActions: "play" },
        events: [{ foo: "bar" }, "not an object"],
      }),
      {},
    );
    expect(out["Media Session API"]).toContain("Not supported");
    expect(out["Media Session events"]).toBe("2");
    expect(out["Actions fired"]).toBe("none");
  });
});
