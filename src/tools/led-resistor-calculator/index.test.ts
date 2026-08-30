import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("led-resistor-calculator: happy path with a color preset and defaults", () => {
  it("computes a single red LED on a 9V supply with the default 20mA current", () => {
    const out = run("vin=9", { color: "red" });
    expect(out["LED forward voltage"]).toBe("2.00 V (red preset, typical range 1.8-2.2 V)");
    expect(out["Total forward voltage (series)"]).toBe("2.00 V");
    expect(out["Forward current"]).toBe("20.0 mA (assumed 20 mA, none given)");
    expect(out["Voltage across resistor"]).toBe("7.00 V");
    expect(out["Exact resistor value"]).toBe("350 ohm");
    expect(out["E12 at or above"]).toBe("390 ohm -> 17.9 mA, 126 mW, recommended rating 0.5 W");
    expect(out["E12 at or below"]).toBe("330 ohm -> 21.2 mA, 148 mW, recommended rating 0.5 W");
    expect(out["E24 at or above"]).toBe("360 ohm -> 19.4 mA, 136 mW, recommended rating 0.5 W");
    expect(out["E24 at or below"]).toBe("330 ohm -> 21.2 mA, 148 mW, recommended rating 0.5 W");
    expect(out["E96 at or above"]).toBe("357 ohm -> 19.6 mA, 137 mW, recommended rating 0.5 W");
    expect(out["E96 at or below"]).toBe("348 ohm -> 20.1 mA, 141 mW, recommended rating 0.5 W");
    expect(out["Total power (all strings)"]).toBe("180 mW (supply-side estimate)");
    expect(out["Warning"]).toBeUndefined();
    expect(out["Note"]).toMatch(/20 mA/);
    expect(out["Formula"]).toBe("R = (Vin - Vf x series) / If");
  });
});

describe("led-resistor-calculator: custom Vf with LEDs in series", () => {
  it("computes three series LEDs at a custom forward voltage", () => {
    const out = run("vin=12 vf=3.2 series=3", { color: "custom" });
    expect(out["LED forward voltage"]).toBe("3.20 V (custom)");
    expect(out["Total forward voltage (series)"]).toBe("9.60 V (3.20 V x 3 LEDs in series)");
    expect(out["Forward current"]).toBe("20.0 mA (assumed 20 mA, none given)");
    expect(out["Voltage across resistor"]).toBe("2.40 V");
    expect(out["Exact resistor value"]).toBe("120 ohm");
    expect(out["E12 at or above"]).toBe("120 ohm -> 20.0 mA, 48.0 mW, recommended rating 0.125 W");
    expect(out["E96 at or below"]).toBe("118 ohm -> 20.3 mA, 48.8 mW, recommended rating 0.125 W");
    expect(out["Total power (all strings)"]).toBe("240 mW (supply-side estimate)");
  });
});

describe("led-resistor-calculator: parallel strings", () => {
  it("computes multiple parallel resistor-and-LED strings with an explicit current", () => {
    const out = run("vin=5 if=15mA parallel=4", { color: "green" });
    expect(out["LED forward voltage"]).toBe("2.50 V (green preset, typical range 2.0-3.0 V)");
    expect(out["Forward current"]).toBe("15.0 mA");
    expect(out["Exact resistor value"]).toBe("167 ohm");
    expect(out["E12 at or above"]).toBe("180 ohm -> 13.9 mA, 34.7 mW, recommended rating 0.125 W");
    expect(out["E24 at or below"]).toBe("160 ohm -> 15.6 mA, 39.1 mW, recommended rating 0.125 W");
    expect(out["Total power (all strings)"]).toBe(
      "300 mW (supply-side estimate at 15.0 mA per string x 4 strings)",
    );
    expect(out["Note"]).toBeUndefined();
  });
});

describe("led-resistor-calculator: warning for a hot resistor", () => {
  it("flags when the exact resistor dissipates over 0.25 W", () => {
    const out = run("vin=24 if=100mA", { color: "red" });
    expect(out["Exact resistor value"]).toBe("220 ohm");
    expect(out["Warning"]).toBe(
      "Exact resistor dissipates over 0.25 W (2.20 W). Use a resistor rated at least 5 W; a standard 0.25 W part will overheat.",
    );
  });
});

describe("led-resistor-calculator: fixed-Vf presets", () => {
  it("describes ir and uv presets as fixed rather than a range", () => {
    const ir = run("vin=5", { color: "ir" });
    expect(ir["LED forward voltage"]).toBe("1.20 V (infrared preset, fixed at 1.20 V)");

    const uv = run("vin=5", { color: "uv" });
    expect(uv["LED forward voltage"]).toBe("3.40 V (ultraviolet preset, fixed at 3.40 V)");
  });
});

describe("led-resistor-calculator: error branches", () => {
  it("throws empty-input for blank input", () => {
    expect(() => run("", { color: "red" })).toThrowError(ToolError);
    try {
      run("   ", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws missing-values when vin is absent", () => {
    try {
      run("if=20mA", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("vin");
    }
  });

  it("throws missing-values when color is custom and vf is absent", () => {
    try {
      run("vin=12", { color: "custom" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("missing-values");
      expect((e as ToolError).message).toContain("vf");
    }
  });

  it("throws impossible when vin does not exceed the total forward voltage", () => {
    try {
      run("vin=2", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
      expect((e as ToolError).message).toMatch(/does not exceed/);
    }
  });

  it("throws impossible for a non-positive value", () => {
    try {
      run("vin=-9", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }

    try {
      run("vin=12 vf=0", { color: "custom" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws impossible for a non-integer or sub-1 series count", () => {
    try {
      run("vin=12 series=1.5", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }

    try {
      run("vin=12 parallel=0", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("impossible");
    }
  });

  it("throws bad-token for an unrecognized key", () => {
    try {
      run("foo=5", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
      expect((e as ToolError).message).toContain("foo");
    }
  });

  it("throws bad-token for an unparseable number", () => {
    try {
      run("vin=abc", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
    }
  });

  it("throws bad-token for a bare token with no key=value shape", () => {
    try {
      run("9V", { color: "red" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-token");
    }
  });

  it("throws bad-option for an unrecognized color", () => {
    try {
      run("vin=12", { color: "chartreuse" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});
