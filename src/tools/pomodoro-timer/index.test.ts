import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  buildSchedule,
  chimeSamples,
  decodeState,
  encodeState,
  formatClock,
  nextTransition,
  phaseAt,
  run,
  summarizeDay,
  totalDuration,
  type Phase,
  type TimerState,
} from "./index";

describe("buildSchedule", () => {
  it("default config: 8 work phases, breaks between them, long every 4th session", () => {
    const schedule = buildSchedule();
    const work = schedule.filter((p) => p.kind === "work");
    const long = schedule.filter((p) => p.kind === "long");
    const short = schedule.filter((p) => p.kind === "short");

    expect(work).toHaveLength(8);
    expect(long).toHaveLength(1); // only after session 4; no trailing break after session 8
    expect(short).toHaveLength(6); // after sessions 1,2,3,5,6,7

    // Schedule starts and ends on work: no break is added after the final session.
    expect(schedule[0]!.kind).toBe("work");
    expect(schedule[schedule.length - 1]!.kind).toBe("work");
  });

  it("places the long break immediately after the 4th work session", () => {
    const schedule = buildSchedule();
    const workPhases = schedule.filter((p) => p.kind === "work");
    const fourthWork = workPhases[3]!;
    const breakAfter = schedule[fourthWork.index + 1];
    expect(breakAfter?.kind).toBe("long");
  });

  it("indexes phases sequentially from 0", () => {
    const schedule = buildSchedule({ sessions: 3, cyclesBeforeLong: 4 });
    schedule.forEach((phase, i) => expect(phase.index).toBe(i));
  });

  it("honors a custom config: long break only after non-final multiples of cyclesBeforeLong", () => {
    const schedule = buildSchedule({
      work: 50,
      shortBreak: 10,
      longBreak: 30,
      cyclesBeforeLong: 3,
      sessions: 6,
    });
    expect(schedule.filter((p) => p.kind === "work")).toHaveLength(6);
    // Session 3 is a multiple of 3 and not final, so it gets a long break.
    // Session 6 is also a multiple of 3 but is the final session, so no trailing break at all.
    expect(schedule.filter((p) => p.kind === "long")).toHaveLength(1);
  });

  it("single session produces no breaks at all", () => {
    const schedule = buildSchedule({ sessions: 1 });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.kind).toBe("work");
  });

  it("throws bad-option for a non-positive option", () => {
    expect(() => buildSchedule({ work: 0 })).toThrow(ToolError);
    try {
      buildSchedule({ sessions: -1 });
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});

describe("totalDuration", () => {
  it("sums phase minutes as milliseconds", () => {
    const schedule = buildSchedule({ sessions: 1, work: 25 });
    expect(totalDuration(schedule)).toBe(25 * 60_000);
  });
});

describe("phaseAt", () => {
  const schedule = buildSchedule({
    work: 25,
    shortBreak: 5,
    longBreak: 15,
    cyclesBeforeLong: 4,
    sessions: 2,
  });
  // schedule: [work 25 (idx0), short 5 (idx1), work 25 (idx2)]

  it("reports the start of the first phase at elapsed 0", () => {
    const r = phaseAt(schedule, 0);
    expect(r.phaseIndex).toBe(0);
    expect(r.phase.kind).toBe("work");
    expect(r.progress).toBe(0);
    expect(r.remainingMs).toBe(25 * 60_000);
    expect(r.sessionsDone).toBe(0);
  });

  it("reports mid-phase progress", () => {
    const r = phaseAt(schedule, 10 * 60_000);
    expect(r.phaseIndex).toBe(0);
    expect(r.remainingMs).toBe(15 * 60_000);
    expect(r.progress).toBeCloseTo(10 / 25);
  });

  it("half-open boundary: elapsed exactly at a phase end belongs to the next phase", () => {
    const r = phaseAt(schedule, 25 * 60_000);
    expect(r.phaseIndex).toBe(1);
    expect(r.phase.kind).toBe("short");
    expect(r.progress).toBe(0);
    expect(r.remainingMs).toBe(5 * 60_000);
    expect(r.sessionsDone).toBe(1);
  });

  it("negative elapsed clamps to the very start", () => {
    const r = phaseAt(schedule, -1000);
    expect(r.phaseIndex).toBe(0);
    expect(r.progress).toBe(0);
  });

  it("elapsed past the end reports the final phase finished and every session done", () => {
    const total = totalDuration(schedule);
    const r = phaseAt(schedule, total + 999_999);
    expect(r.phaseIndex).toBe(schedule.length - 1);
    expect(r.phase.kind).toBe("work");
    expect(r.remainingMs).toBe(0);
    expect(r.progress).toBe(1);
    expect(r.sessionsDone).toBe(2);
  });

  it("elapsed exactly at total duration also reports finished", () => {
    const total = totalDuration(schedule);
    const r = phaseAt(schedule, total);
    expect(r.phaseIndex).toBe(schedule.length - 1);
    expect(r.remainingMs).toBe(0);
    expect(r.progress).toBe(1);
    expect(r.sessionsDone).toBe(2);
  });
});

describe("formatClock", () => {
  it("formats zero as 00:00", () => {
    expect(formatClock(0)).toBe("00:00");
  });

  it("formats 25 minutes as 25:00", () => {
    expect(formatClock(25 * 60_000)).toBe("25:00");
  });

  it("formats past an hour with an hour component", () => {
    expect(formatClock(65 * 60_000)).toBe("1:05:00");
  });

  it("clamps negative values to zero", () => {
    expect(formatClock(-5000)).toBe("00:00");
  });

  it("rounds to the nearest second", () => {
    expect(formatClock(1499)).toBe("00:01");
  });
});

describe("encodeState / decodeState", () => {
  const base: TimerState = {
    config: {
      work: 25,
      shortBreak: 5,
      longBreak: 15,
      cyclesBeforeLong: 4,
      sessions: 8,
      autoStartBreaks: true,
    },
    elapsedBeforePauseMs: 0,
    phaseIndex: 0,
  };

  it("round-trips a fresh, never-started state", () => {
    const encoded = encodeState(base);
    const decoded = decodeState(encoded);
    expect(decoded).toEqual(base);
    expect(decoded.startedAtMs).toBeUndefined();
    expect(decoded.pausedAtMs).toBeUndefined();
  });

  it("round-trips a running state (startedAtMs set, no pausedAtMs)", () => {
    const state: TimerState = { ...base, startedAtMs: 1_700_000_000_000, phaseIndex: 2 };
    const decoded = decodeState(encodeState(state));
    expect(decoded).toEqual(state);
    expect(decoded.pausedAtMs).toBeUndefined();
  });

  it("round-trips a paused state (both startedAtMs and pausedAtMs set)", () => {
    const state: TimerState = {
      ...base,
      startedAtMs: 1_700_000_000_000,
      pausedAtMs: 1_700_000_100_000,
      elapsedBeforePauseMs: 45_000,
      phaseIndex: 1,
    };
    const decoded = decodeState(encodeState(state));
    expect(decoded).toEqual(state);
  });

  it("strips a leading # or ? before parsing", () => {
    const encoded = encodeState(base);
    expect(decodeState(`#${encoded}`)).toEqual(base);
    expect(decodeState(`?${encoded}`)).toEqual(base);
  });

  it("throws bad-state on a missing required field", () => {
    try {
      decodeState("w=25&sb=5&lb=15&cbl=4"); // missing se, eb, pi
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-state");
    }
  });

  it("throws bad-state on a non-numeric required field", () => {
    expect(() => decodeState("w=abc&sb=5&lb=15&cbl=4&se=8&eb=0&pi=0")).toThrow(ToolError);
  });
});

describe("nextTransition", () => {
  const config = {
    work: 25,
    shortBreak: 5,
    longBreak: 15,
    cyclesBeforeLong: 4,
    sessions: 2,
    autoStartBreaks: true,
  };

  it("returns null when the timer was never started", () => {
    const state: TimerState = { config, elapsedBeforePauseMs: 0, phaseIndex: 0 };
    expect(nextTransition(state, 1_700_000_000_000)).toBeNull();
  });

  it("returns null while paused", () => {
    const state: TimerState = {
      config,
      startedAtMs: 1_700_000_000_000,
      pausedAtMs: 1_700_000_050_000,
      elapsedBeforePauseMs: 50_000,
      phaseIndex: 0,
    };
    expect(nextTransition(state, 1_700_000_999_000)).toBeNull();
  });

  it("returns the remaining ms in the current phase while running", () => {
    const started = 1_700_000_000_000;
    const state: TimerState = { config, startedAtMs: started, elapsedBeforePauseMs: 0, phaseIndex: 0 };
    const now = started + 10 * 60_000; // 10 minutes into a 25 minute work phase
    expect(nextTransition(state, now)).toBe(15 * 60_000);
  });

  it("returns null once the whole schedule has finished", () => {
    const started = 1_700_000_000_000;
    const state: TimerState = { config, startedAtMs: started, elapsedBeforePauseMs: 0, phaseIndex: 0 };
    const total = totalDuration(buildSchedule(config));
    expect(nextTransition(state, started + total + 1)).toBeNull();
  });
});

describe("summarizeDay", () => {
  it("sums minutes and counts only work phases", () => {
    const phases: Phase[] = [
      { kind: "work", minutes: 25, index: 0, cycle: 1 },
      { kind: "short", minutes: 5, index: 1, cycle: 1 },
      { kind: "work", minutes: 25, index: 2, cycle: 1 },
    ];
    expect(summarizeDay(phases)).toEqual({ focusedMinutes: 50, sessions: 2 });
  });

  it("returns zeroes for an empty list", () => {
    expect(summarizeDay([])).toEqual({ focusedMinutes: 0, sessions: 0 });
  });
});

describe("chimeSamples", () => {
  it("renders a distinct, finite buffer for work-end", () => {
    const samples = chimeSamples(44100, "work-end");
    expect(samples).toBeInstanceOf(Float32Array);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("scales sample count with sample rate", () => {
    const at44k = chimeSamples(44100, "work-end");
    const at48k = chimeSamples(48000, "work-end");
    expect(at48k.length).toBeGreaterThan(at44k.length);
  });

  it("work-end and break-end are audibly different", () => {
    const workEnd = chimeSamples(44100, "work-end");
    const breakEnd = chimeSamples(44100, "break-end");
    expect(workEnd.length).toBe(breakEnd.length);
    let differs = false;
    for (let i = 0; i < workEnd.length; i++) {
      if (Math.abs(workEnd[i]! - breakEnd[i]!) > 1e-9) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it("throws bad-option for an unusable sample rate", () => {
    expect(() => chimeSamples(0, "work-end")).toThrow(ToolError);
    try {
      chimeSamples(NaN, "break-end");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});

describe("run", () => {
  const defaultOpts = {
    work: 25,
    shortBreak: 5,
    longBreak: 15,
    cyclesBeforeLong: 4,
    sessions: 8,
    autoStartBreaks: true,
  };

  it("builds the default schedule from empty input", () => {
    const out = run("", defaultOpts);
    expect(out["Phase 1"]).toBe("Work, 25 min");
    expect(out["Phase 2"]).toBe("Short break, 5 min");
    expect(out["Total duration"]).toBeTruthy();
    expect(out["Note"]).toMatch(/pop-out/i);
  });

  it("parses '25/5' shorthand, overriding work and short break only", () => {
    const out = run("25/5", { ...defaultOpts, sessions: 2 });
    expect(out["Phase 1"]).toBe("Work, 25 min");
    expect(out["Phase 2"]).toBe("Short break, 5 min");
  });

  it("parses '50/10/30x3' shorthand: work/short/long x cyclesBeforeLong", () => {
    const out = run("50/10/30x3", { ...defaultOpts, sessions: 6 });
    expect(out["Phase 1"]).toBe("Work, 50 min");
    expect(out["Phase 2"]).toBe("Short break, 10 min");
    // Session 3 of 6 triggers the long break at cyclesBeforeLong=3.
    expect(out["Phase 5"]).toBe("Work, 50 min");
    expect(out["Phase 6"]).toBe("Long break, 30 min");
    expect(out["Phase 7"]).toBe("Work, 50 min");
  });

  it("throws bad-shorthand for unparseable input", () => {
    try {
      run("not a schedule", defaultOpts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-shorthand");
    }
  });

  it("throws bad-option when an option is out of range", () => {
    try {
      run("", { ...defaultOpts, work: 999 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option when shorthand produces an out-of-range value", () => {
    expect(() => run("500/5", defaultOpts)).toThrow(ToolError);
  });
});
