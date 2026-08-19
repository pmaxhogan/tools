import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const dof = (input: string, sensor = "full-frame") => run(input, { mode: "dof", sensor });
const hyper = (input: string, sensor = "full-frame") => run(input, { mode: "hyperfocal", sensor });
const exposure = (input: string) => run(input, { mode: "exposure" });
const nd = (input: string) => run(input, { mode: "nd" });
const fov = (input: string, sensor = "full-frame") => run(input, { mode: "fov", sensor });

/** The ToolError code thrown by fn, or "no-error" when it does not throw. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).code;
  }
  return "no-error";
}

describe("photography-calculator: depth of field", () => {
  it("computes the textbook 50mm f/2.8 at 3m on full frame", () => {
    const out = dof("50mm f/2.8 3m");
    expect(out["Hyperfocal distance"]).toBe("29.81 m");
    expect(out["Near limit"]).toBe("2.73 m");
    expect(out["Far limit"]).toBe("3.33 m");
    expect(out["Total depth of field"]).toBe("0.60 m");
    expect(out["In front of subject"]).toBe("0.27 m (45.0%)");
    expect(out["Behind subject"]).toBe("0.33 m (55.0%)");
    expect(out.Magnification).toBe("0.0169x (1:59.0)");
    expect(out["Circle of confusion"]).toBe("0.03 mm");
    expect(out["Acceptable sharpness"]).toContain("blur circle");
    expect(out.Formula).toContain("H = f^2 / (N x c) + f");
  });

  it("accepts key=value tokens for the same answer", () => {
    const out = dof("focal=50 aperture=2.8 distance=3");
    expect(out["Hyperfocal distance"]).toBe("29.81 m");
    expect(out["Near limit"]).toBe("2.73 m");
    expect(out["Far limit"]).toBe("3.33 m");
  });

  it("accepts bare positional numbers", () => {
    const out = dof("50 2.8 3");
    expect(out["Near limit"]).toBe("2.73 m");
    expect(out["Far limit"]).toBe("3.33 m");
  });

  it("reports distances in feet when the input is in feet", () => {
    const out = dof("50mm f/2.8 10ft");
    expect(out["Hyperfocal distance"]).toBe("97.81 ft");
    expect(out["Near limit"]).toBe("9.08 ft");
    expect(out["Far limit"]).toBe("11.12 ft");
    expect(out["Total depth of field"]).toBe("2.04 ft");
  });

  it("returns infinity past the hyperfocal distance", () => {
    const out = dof("50mm f/2.8 40m");
    expect(out["Far limit"]).toBe("infinity");
    expect(out["Total depth of field"]).toBe("infinity");
    expect(out["Behind subject"]).toBe("infinity");
    expect(out["Focus note"]).toContain("hyperfocal");
  });

  it("uses the APS-C circle of confusion when that sensor is selected", () => {
    const out = dof("50mm f/2.8 3m", "aps-c");
    expect(out["Circle of confusion"]).toBe("0.02 mm");
    expect(out["Hyperfocal distance"]).toBe("44.69 m");
    expect(out.Sensor).toContain("APS-C");
  });

  it("accepts a custom sensor with an explicit circle of confusion", () => {
    const out = dof("50mm f/2.8 3m sensor=custom sensorWidth=36 sensorHeight=24 coc=0.03");
    expect(out["Hyperfocal distance"]).toBe("29.81 m");
    expect(out.Sensor).toBe("Custom (36 x 24 mm)");
  });

  it("lets a coc token override the sensor default", () => {
    const out = dof("50mm f/2.8 3m coc=0.015");
    expect(out["Circle of confusion"]).toBe("0.015 mm");
    expect(out["Hyperfocal distance"]).toBe("59.57 m");
  });

  it("reads the sensor from a bare alias in the input", () => {
    const out = dof("50mm f/2.8 3m mft");
    expect(out.Sensor).toContain("Micro Four Thirds");
  });
});

describe("photography-calculator: hyperfocal", () => {
  it("computes the hyperfocal distance and its near limit", () => {
    const out = hyper("50mm f/2.8");
    expect(out["Hyperfocal distance"]).toBe("29.81 m");
    expect(out["Near limit at hyperfocal focus"]).toBe("14.91 m");
    expect(out["Far limit at hyperfocal focus"]).toBe("infinity");
  });

  it("prints a table across the common apertures", () => {
    const out = hyper("50mm f/2.8");
    expect(out["f/2.8"]).toContain("29.81 m");
    expect(out["f/4"]).toContain("20.88 m");
    expect(out["f/5.6"]).toContain("14.93 m");
    expect(out["f/8"]).toContain("10.47 m");
    expect(out["f/11"]).toContain("7.63 m");
    expect(out["f/16"]).toContain("5.26 m");
    expect(out["f/8"]).toContain("sharp from 5.23 m to infinity");
  });

  it("keeps the table in feet for an imperial input", () => {
    const out = hyper("35mm f/8 dist=10ft");
    expect(out["f/8"]).toContain("ft");
  });
});

describe("photography-calculator: exposure", () => {
  it("computes EV100 for the sunny 16 rule", () => {
    const out = exposure("f/16 1/125 ISO100");
    expect(out["EV at ISO 100"]).toBe("14.97");
    expect(out.Aperture).toBe("f/16");
    expect(out.Shutter).toBe("1/125 s");
    expect(out.ISO).toBe("ISO 100");
    expect(out["Lighting reference"]).toContain("Sunny 16 is EV 15");
    expect(out.Formula).toBe("EV100 = log2(N^2 / t) - log2(ISO / 100)");
  });

  it("lists six equivalent aperture and shutter pairs", () => {
    const out = exposure("f/16 1/125 ISO100");
    const pairs = out["Equivalent exposures"];
    expect(pairs).toContain("f/8 1/500");
    expect(pairs).toContain("f/16 1/125");
    expect(pairs).toContain("f/11 1/250");
    expect(pairs).toContain("f/4 1/2000");
    expect(pairs.split(", ")).toHaveLength(6);
  });

  it("shifts EV when the ISO is not 100", () => {
    const out = exposure("f/16 1/125 ISO400");
    expect(out["EV at ISO 100"]).toBe("12.97");
    expect(out["EV at ISO 400"]).toBe("14.97");
  });

  it("accepts a bare decimal as the shutter time in seconds", () => {
    const out = exposure("f/16 0.004 ISO100");
    expect(out.Shutter).toBe("1/250 s");
    expect(out["EV at ISO 100"]).toBe("15.97");
  });

  it("assumes ISO 100 when none is given and says so", () => {
    const out = exposure("f/16 1/125");
    expect(out["EV at ISO 100"]).toBe("14.97");
    expect(out.Assumptions).toContain("ISO 100 was assumed");
  });

  it("solves the shutter speed from ev=", () => {
    const out = exposure("f/8 ev=15 iso=100");
    expect(out.Shutter).toBe("1/500 s");
    expect(out["EV at ISO 100"]).toBe("15.00");
    expect(out.Assumptions).toContain("Shutter speed solved");
  });

  it("solves the ISO from ev= plus an aperture and shutter", () => {
    const out = exposure("f/8 1/64 ev=10");
    expect(out.ISO).toBe("ISO 400");
    expect(out.Assumptions).toContain("ISO solved");
  });

  it("solves the aperture from ev= plus a shutter speed", () => {
    const out = exposure("1/125 ev=14.9658");
    expect(out.Aperture).toBe("f/16");
  });

  it("reports the ISO needed to reach a target shutter speed", () => {
    const out = exposure("f/16 1/125 iso=100 target=1/500");
    expect(out["ISO for 1/500 s at f/16"]).toBe("ISO 400 (nearest full stop setting: ISO 400)");
  });
});

describe("photography-calculator: ND filters", () => {
  it("turns 1/125 into 8 s behind an ND1000", () => {
    const out = nd("1/125 ND1000");
    expect(out["Base shutter"]).toBe("1/125 s");
    expect(out["New shutter"]).toBe("8 s");
    expect(out["ND filter"]).toContain("10.0 stops");
    expect(out["ND filter"]).toContain("density 3.0");
  });

  it("prints the common ND table with stop counts", () => {
    const out = nd("1/125 ND1000");
    expect(out.ND2).toBe("1.0 stops, 1/60 s");
    expect(out.ND4).toBe("2.0 stops, 1/30 s");
    expect(out.ND8).toBe("3.0 stops, 1/15 s");
    expect(out.ND64).toBe("6.0 stops, 1/2 s");
    expect(out.ND400).toBe("8.6 stops, 3 s");
    expect(out.ND1000).toBe("10.0 stops, 8 s");
    expect(out.ND100000).toContain("16.6 stops");
    expect(out.ND100000).toContain("13 min 20 s");
    expect(out.ND100000).toContain("use bulb mode");
  });

  it("accepts a stop count, an optical density, and a factor with x", () => {
    expect(nd("1/125 3stops")["New shutter"]).toBe("1/15 s");
    expect(nd("1/125 3 stops")["New shutter"]).toBe("1/15 s");
    expect(nd("1/250s ND8")["New shutter"]).toBe("1/30 s");
    expect(nd("1/125 0.9")["New shutter"]).toBe("1/15 s");
    expect(nd("1/125 1000x")["New shutter"]).toBe("8 s");
    expect(nd("1/125 nd=8")["New shutter"]).toBe("1/15 s");
  });

  it("flags bulb mode past 30 seconds", () => {
    const out = nd("1/2 ND1000");
    expect(out["New shutter"]).toBe("500 s (8 min 20 s)");
    expect(out["Bulb mode"]).toContain("bulb");
  });

  it("rounds exposures over a second to the nearest half second", () => {
    expect(nd('2s 1.5stops')["New shutter"]).toBe("5.5 s");
  });
});

describe("photography-calculator: field of view", () => {
  it("computes the angles for a 50mm lens on full frame", () => {
    const out = fov("50mm");
    expect(out["Horizontal angle of view"]).toBe("39.6 deg");
    expect(out["Vertical angle of view"]).toBe("27.0 deg");
    expect(out["Diagonal angle of view"]).toBe("46.8 deg");
    expect(out["Crop factor"]).toBe("1.00x");
    expect(out["35mm equivalent focal length"]).toBe("50.0 mm");
  });

  it("reports the APS-C crop factor and equivalent focal length", () => {
    const out = fov("50mm", "aps-c");
    expect(out["Crop factor"]).toBe("1.53x");
    expect(out["35mm equivalent focal length"]).toBe("76.5 mm");
    expect(out["Horizontal angle of view"]).toBe("26.6 deg");
  });

  it("reports the crop factor for the other sensors", () => {
    expect(fov("50mm", "micro-four-thirds")["Crop factor"]).toBe("2.00x");
    expect(fov("50mm", "1-inch")["Crop factor"]).toBe("2.73x");
    expect(fov("50mm", "medium-format-44x33")["Crop factor"]).toBe("0.79x");
    expect(fov("50mm", "aps-c-canon")["Crop factor"]).toBe("1.61x");
  });

  it("computes the framed area at a subject distance", () => {
    const out = fov("50mm dist=5m");
    expect(out["Frame width at 5.00 m"]).toBe("3.60 m");
    expect(out["Frame height at 5.00 m"]).toBe("2.40 m");
  });
});

describe("photography-calculator: modes and errors", () => {
  it("reads the mode from the input as well as the option", () => {
    const out = run("fov 50mm", {});
    expect(out["Horizontal angle of view"]).toBe("39.6 deg");
  });

  it("defaults to depth of field", () => {
    const out = run("50mm f/2.8 3m", {});
    expect(out["Near limit"]).toBe("2.73 m");
  });

  it("throws empty-input on no input", () => {
    expect(codeOf(() => dof(""))).toBe("empty-input");
    expect(codeOf(() => dof("   "))).toBe("empty-input");
  });

  it("throws bad-token on unreadable input", () => {
    expect(codeOf(() => dof("50mm f/2.8 banana"))).toBe("bad-token");
    expect(codeOf(() => dof("wibble=3"))).toBe("bad-token");
    expect(codeOf(() => dof("50mm f/2.8 3parsecs"))).toBe("bad-token");
    expect(codeOf(() => run("50mm", { mode: "telepathy" }))).toBe("bad-token");
    expect(codeOf(() => dof("50mm f/2.8 3m", "potato"))).toBe("bad-token");
    expect(codeOf(() => dof("50mm f/2.8 3m sensor=potato"))).toBe("bad-token");
    expect(codeOf(() => exposure("f/16 1/125 12"))).toBe("bad-token");
  });

  it("throws missing-values and names what is missing per mode", () => {
    expect(codeOf(() => dof("50mm"))).toBe("missing-values");
    expect(codeOf(() => hyper("50mm"))).toBe("missing-values");
    expect(codeOf(() => exposure("iso=100"))).toBe("missing-values");
    expect(codeOf(() => nd("1/125"))).toBe("missing-values");
    expect(codeOf(() => nd("ND8"))).toBe("missing-values");
    expect(codeOf(() => fov("f/2.8"))).toBe("missing-values");
    expect(codeOf(() => dof("50mm f/2.8 3m sensor=custom"))).toBe("missing-values");

    try {
      dof("50mm");
    } catch (e) {
      expect((e as ToolError).message).toContain("an aperture and a subject distance");
      expect((e as ToolError).fix).toContain("50mm f/2.8 3m");
    }
  });

  it("throws impossible on physically unworkable numbers", () => {
    expect(codeOf(() => dof("50mm f/2.8 0.03m"))).toBe("impossible");
    expect(codeOf(() => dof("50mm f/0 3m"))).toBe("impossible");
    expect(codeOf(() => dof("0mm f/2.8 3m"))).toBe("impossible");
    expect(codeOf(() => exposure("f/16 0s iso=100"))).toBe("impossible");
    expect(codeOf(() => nd("1/125 nd=0.5x"))).toBe("impossible");
    expect(codeOf(() => fov("50mm dist=0.01m"))).toBe("impossible");

    try {
      dof("50mm f/2.8 0.03m");
    } catch (e) {
      expect((e as ToolError).message).toContain("not greater than the focal length");
    }
  });
});
