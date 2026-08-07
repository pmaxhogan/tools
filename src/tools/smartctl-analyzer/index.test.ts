import { describe, expect, it } from "vitest";
import { parseAtaAttributes, parseSmart, run } from "./index";
import { ToolError } from "../types";

const VERDICT = { detail: "verdict" };
const FULL = { detail: "full" };

/** Realistic `smartctl -a` dump from a healthy 4 TB WD Red. */
const HEALTHY_ATA = `smartctl 7.2 2020-12-30 r5155 [x86_64-linux-5.15.0-76-generic] (local build)
Copyright (C) 2002-20, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Model Family:     Western Digital Red
Device Model:     WDC WD40EFRX-68N32N0
Serial Number:    WD-WCC7K1234567
LU WWN Device Id: 5 0014ee 2646d1234
Firmware Version: 82.00A82
User Capacity:    4,000,787,030,016 bytes [4.00 TB]
Sector Sizes:     512 bytes logical, 4096 bytes physical
Rotation Rate:    5400 rpm
ATA Version is:   ACS-3 T13/2161-D revision 5
SATA Version is:  SATA 3.1, 6.0 Gb/s (current: 6.0 Gb/s)
SMART support is: Available - device has SMART capability.
SMART support is: Enabled

=== START OF READ SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART Attributes Data Structure revision number: 16
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  1 Raw_Read_Error_Rate     0x002f   200   200   051    Pre-fail  Always       -       0
  3 Spin_Up_Time            0x0027   180   179   021    Pre-fail  Always       -       5850
  4 Start_Stop_Count        0x0032   100   100   000    Old_age   Always       -       112
  5 Reallocated_Sector_Ct   0x0033   200   200   140    Pre-fail  Always       -       0
  7 Seek_Error_Rate         0x002e   200   200   000    Old_age   Always       -       0
  9 Power_On_Hours          0x0032   078   078   000    Old_age   Always       -       16425
 10 Spin_Retry_Count        0x0032   100   253   000    Old_age   Always       -       0
 12 Power_Cycle_Count       0x0032   100   100   000    Old_age   Always       -       110
184 End-to-End_Error        0x0032   100   100   000    Old_age   Always       -       0
187 Reported_Uncorrect      0x0032   100   100   000    Old_age   Always       -       0
188 Command_Timeout         0x0032   100   100   000    Old_age   Always       -       0
192 Power-Off_Retract_Count 0x0032   200   200   000    Old_age   Always       -       35
193 Load_Cycle_Count        0x0032   200   200   000    Old_age   Always       -       780
194 Temperature_Celsius     0x0022   116   109   000    Old_age   Always       -       34 (Min/Max 19/45)
196 Reallocated_Event_Count 0x0032   200   200   000    Old_age   Always       -       0
197 Current_Pending_Sector  0x0032   200   200   000    Old_age   Always       -       0
198 Offline_Uncorrectable   0x0030   100   253   000    Old_age   Offline      -       0
199 UDMA_CRC_Error_Count    0x0032   200   200   000    Old_age   Always       -       0
200 Multi_Zone_Error_Rate   0x0008   100   253   000    Old_age   Offline      -       0

SMART Error Log Version: 1
No Errors Logged

SMART Self-test log structure revision number 1
Num  Test_Description    Status                  Remaining  LifeTime(hours)  LBA_of_first_error
# 1  Short offline       Completed without error       00%     16400         -
# 2  Extended offline    Completed without error       00%     15980         -
`;

/** Same drive, deep into a surface failure. */
const FAILING_ATA = HEALTHY_ATA.replace(
  "  5 Reallocated_Sector_Ct   0x0033   200   200   140    Pre-fail  Always       -       0",
  "  5 Reallocated_Sector_Ct   0x0033   142   142   140    Pre-fail  Always       -       1200",
)
  .replace(
    "197 Current_Pending_Sector  0x0032   200   200   000    Old_age   Always       -       0",
    "197 Current_Pending_Sector  0x0032   200   200   000    Old_age   Always       -       16",
  )
  .replace(
    "196 Reallocated_Event_Count 0x0032   200   200   000    Old_age   Always       -       0",
    "196 Reallocated_Event_Count 0x0032   142   142   000    Old_age   Always       -       1201",
  );

/** Only the SATA link is unhappy. The platters are fine. */
const CABLE_ATA = HEALTHY_ATA.replace(
  "199 UDMA_CRC_Error_Count    0x0032   200   200   000    Old_age   Always       -       0",
  "199 UDMA_CRC_Error_Count    0x0032   199   199   000    Old_age   Always       -       145",
);

/** A modest reallocated count, but the drive itself flags the attribute. */
const WHEN_FAILED_ATA = HEALTHY_ATA.replace(
  "  5 Reallocated_Sector_Ct   0x0033   200   200   140    Pre-fail  Always       -       0",
  "  5 Reallocated_Sector_Ct   0x0033   139   139   140    Pre-fail  Always   FAILING_NOW  12",
);

/** `smartctl -x` brief attribute layout on a Samsung SATA SSD. */
const BRIEF_ATA = `smartctl 7.2 2020-12-30 r5155 [x86_64-linux-5.15.0] (local build)
Copyright (C) 2002-20, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Device Model:     Samsung SSD 860 EVO 1TB
Serial Number:    S3Z8NB0K123456
Firmware Version: RVT04B6Q
User Capacity:    1,000,204,886,016 bytes [1.00 TB]
Rotation Rate:    Solid State Device

=== START OF READ SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART Attributes Data Structure revision number: 1
Vendor Specific SMART Attributes with Thresholds:
ID# ATTR_NAME           FLAGS    VALUE WORST THRESH FAIL RAW_VALUE
  5 Reallocated_Sector_Ct   PO--CK   100   100   010    -    0
  9 Power_On_Hours          -O--CK   098   098   000    -    7431
 12 Power_Cycle_Count       -O--CK   099   099   000    -    841
177 Wear_Leveling_Count     PO--C-   096   096   000    -    38
179 Used_Rsvd_Blk_Cnt_Tot   PO--C-   100   100   010    -    0
181 Program_Fail_Cnt_Total  -O--CK   100   100   010    -    0
182 Erase_Fail_Count_Total  -O--CK   100   100   010    -    0
187 Reported_Uncorrect      -O--CK   100   100   000    -    0
190 Airflow_Temperature_Cel -O--CK   071   058   000    -    29
195 Hardware_ECC_Recovered  PO--CK   200   200   000    -    0
199 UDMA_CRC_Error_Count    -OSRCK   100   100   000    -    0
235 POR_Recovery_Count      -O--C-   099   099   000    -    43
241 Total_LBAs_Written      -O--CK   099   099   000    -    24216943851
                            ||||||_ K auto-keep
                            |||||__ C event count
                            ||||___ R error rate
                            |||____ S speed/performance
                            ||_____ O updated online
                            |______ P prefailure warning

SMART Extended Comprehensive Error Log Version: 1 (0 sectors)
No Errors Logged

SMART Extended Self-test Log Version: 1 (1 sectors)
No self-tests have been logged.  [To run self-tests, use: smartctl -t ...]
`;

/** `smartctl -a /dev/nvme0` on a lightly used 980 PRO. */
const HEALTHY_NVME = `smartctl 7.2 2020-12-30 r5155 [x86_64-linux-6.1.0-13-amd64] (local build)
Copyright (C) 2002-20, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Model Number:                       Samsung SSD 980 PRO 1TB
Serial Number:                      S5GXNF0R123456
Firmware Version:                   5B2QGXA7
PCI Vendor/Subsystem ID:            0x144d
Total NVM Capacity:                 1,000,204,886,016 [1.00 TB]
Namespace 1 Formatted LBA Size:     512
NVMe Version:                       1.3

=== START OF SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART/Health Information (NVMe Log 0x02)
Critical Warning:                   0x00
Temperature:                        41 Celsius
Available Spare:                    100%
Available Spare Threshold:          10%
Percentage Used:                    3%
Data Units Read:                    18,000,000 [9.21 TB]
Data Units Written:                 25,000,000 [12.8 TB]
Host Read Commands:                 210,847,123
Host Write Commands:                180,332,441
Controller Busy Time:               1,204
Power Cycles:                       412
Power On Hours:                     9,180
Unsafe Shutdowns:                   41
Media and Data Integrity Errors:    0
Error Information Log Entries:      0
Warning  Comp. Temperature Time:    0
Critical Comp. Temperature Time:    0

Error Information (NVMe Log 0x01, 16 of 64 entries)
No Errors Logged
`;

/** Same drive after the controller decided the media is unreliable. */
const FAILING_NVME = HEALTHY_NVME.replace(
  "Critical Warning:                   0x00",
  "Critical Warning:                   0x04",
);

describe("smartctl-analyzer: ATA verdicts", () => {
  it("calls a clean WD Red HEALTHY", () => {
    const out = run(HEALTHY_ATA, VERDICT);
    expect(out).toMatch(/^Verdict: HEALTHY$/m);
    expect(out).toContain("WDC WD40EFRX-68N32N0");
    expect(out).toContain("Reported health: PASSED");
    expect(out).toMatch(/Nothing in this report is off its healthy reading/);
    expect(out).not.toMatch(/Back up now/);
  });

  it("reads power on hours as a human span", () => {
    const out = run(HEALTHY_ATA, VERDICT);
    expect(out).toContain("Power on time: 16,425 hours, about 1 year, 319 days.");
  });

  it("assumes minutes when attribute 9 is implausibly large, and says so", () => {
    const minutes = HEALTHY_ATA.replace("-       16425", "-       985500");
    const out = run(minutes, VERDICT);
    expect(out).toContain("985,500 raw units");
    expect(out).toContain("logging minutes");
    expect(out).toContain("about 16,425 hours");
    expect(out).toContain("Treat it as an assumption, not a fact.");
  });

  it('takes the first integer from a 194 raw cell like "34 (Min/Max 19/45)"', () => {
    const report = parseSmart(HEALTHY_ATA);
    const temp = report.attrs.find((a) => a.id === 194);
    expect(temp?.raw).toBe("34 (Min/Max 19/45)");
    expect(temp?.rawInt).toBe(34);
    expect(run(HEALTHY_ATA, VERDICT)).toContain("Temperature: 34 C.");
  });

  it("reports the last self-test", () => {
    const out = run(HEALTHY_ATA, VERDICT);
    expect(out).toContain("Last test: Short offline, Completed without error at 16,400");
    expect(out).toContain("Error log: no errors logged.");
  });

  it("calls 1200 reallocated plus 16 pending sectors FAILING and says to back up now", () => {
    const out = run(FAILING_ATA, VERDICT);
    expect(out).toMatch(/^Verdict: FAILING$/m);
    expect(out).toContain("Back up now");
    expect(out).toContain("1,200 sectors have been remapped");
    expect(out).toContain("16 sectors are unreadable right now");
    // The headline must not be printed twice even though two rules fired.
    expect(out.match(/Back up now/g)).toHaveLength(1);
  });

  it("treats CRC errors as a cable problem, not a dying drive", () => {
    const out = run(CABLE_ATA, VERDICT);
    expect(out).toMatch(/^Verdict: WATCH$/m);
    expect(out).toMatch(/SATA data cable/);
    expect(out).toContain("145 transfers were corrupted");
    expect(out).not.toContain("Back up now");
  });

  it("keeps a huge CRC count at WATCH rather than escalating it", () => {
    const huge = CABLE_ATA.replace("-       145", "-       12000");
    const out = run(huge, VERDICT);
    expect(out).toMatch(/^Verdict: WATCH$/m);
    expect(out).toContain("12,000 transfers were corrupted");
  });

  it("escalates to FAILING when a critical attribute is flagged FAILING_NOW", () => {
    const out = run(WHEN_FAILED_ATA, VERDICT);
    expect(out).toMatch(/^Verdict: FAILING$/m);
    expect(out).toMatch(/FAILING NOW/);
  });

  it("warns on an overheating spinning drive", () => {
    const hot = HEALTHY_ATA.replace("-       34 (Min/Max 19/45)", "-       61 (Min/Max 19/61)");
    const out = run(hot, VERDICT);
    expect(out).toMatch(/^Verdict: WATCH$/m);
    expect(out).toContain("above the 55 C mark");
  });
});

describe("smartctl-analyzer: attribute table layouts", () => {
  it("parses the -x brief layout, skipping the flag legend", () => {
    const rows = parseAtaAttributes(BRIEF_ATA.split("\n"));
    expect(rows).toHaveLength(13);
    const wear = rows.find((r) => r.id === 177);
    expect(wear).toMatchObject({ name: "Wear_Leveling_Count", value: 96, thresh: 0, rawInt: 38 });
    expect(wear?.type).toBeNull();
    expect(rows.every((r) => r.whenFailed === "-")).toBe(true);
  });

  it("parses the -a standard layout with the type and updated columns", () => {
    const rows = parseAtaAttributes(HEALTHY_ATA.split("\n"));
    const realloc = rows.find((r) => r.id === 5);
    expect(realloc).toMatchObject({ type: "Pre-fail", updated: "Always", thresh: 140, rawInt: 0 });
  });

  it("gives a brief-format SSD a HEALTHY verdict with an estimated write total", () => {
    const out = run(BRIEF_ATA, VERDICT);
    expect(out).toMatch(/^Verdict: HEALTHY$/m);
    expect(out).toContain("Samsung SSD 860 EVO 1TB");
    // 24,216,943,851 blocks * 512 bytes = 12.4 TB, and the unit is vendor defined.
    expect(out).toContain("about 12.4 TB");
    expect(out).toContain("vendor defined");
    expect(out).toContain("Flash wear (177 Wear_Leveling_Count): normalized value 96 of 100");
    expect(out).toContain("No self-tests have been logged");
  });

  it("labels an id with no standard meaning as vendor-specific in full detail", () => {
    const out = run(BRIEF_ATA, FULL);
    expect(out).toContain("235 POR_Recovery_Count: raw 43");
    expect(out).toMatch(/Vendor-specific attribute\. smartctl has no standard meaning for id 235/);
  });

  it("explains every attribute in full detail", () => {
    const out = run(HEALTHY_ATA, FULL);
    expect(out).toContain("All parsed values");
    expect(out).toContain("193 Load_Cycle_Count: raw 780");
    expect(out).toContain("Head park and unpark cycles");
  });
});

describe("smartctl-analyzer: NVMe", () => {
  it("calls a 3% used drive with no warnings HEALTHY", () => {
    const out = run(HEALTHY_NVME, VERDICT);
    expect(out).toMatch(/^Verdict: HEALTHY$/m);
    expect(out).toContain("Interface: NVMe");
    expect(out).toContain("Samsung SSD 980 PRO 1TB");
    expect(out).toContain("Endurance used: 3% of the rated write life");
  });

  it("converts data units to terabytes at 512,000 bytes per unit", () => {
    // 25,000,000 units * 512,000 bytes = 12,800,000,000,000 bytes = 12.8 TB.
    const out = run(HEALTHY_NVME, VERDICT);
    expect(out).toContain("Host writes: 25,000,000 data units, which is exactly 12.8 TB");
    // 18,000,000 * 512,000 = 9,216,000,000,000 bytes = 9.22 TB.
    expect(out).toContain("Host reads: 18,000,000 data units, which is 9.22 TB");
  });

  it("decodes critical_warning 0x04 as a FAILING media reliability fault", () => {
    const out = run(FAILING_NVME, VERDICT);
    expect(out).toMatch(/^Verdict: FAILING$/m);
    expect(out).toContain("Back up now");
    expect(out).toContain("NVM subsystem reliability degraded");
  });

  it("calls out media and data integrity errors", () => {
    const bad = HEALTHY_NVME.replace(
      "Media and Data Integrity Errors:    0",
      "Media and Data Integrity Errors:    7",
    );
    const out = run(bad, VERDICT);
    expect(out).toMatch(/^Verdict: FAILING$/m);
    expect(out).toContain("7 media and data integrity errors recorded");
  });

  it("explains NVMe fields in full detail", () => {
    const out = run(HEALTHY_NVME, FULL);
    expect(out).toContain("Unsafe Shutdowns: 41");
    expect(out).toContain("Power losses without a clean shutdown notification");
  });
});

describe("smartctl-analyzer: errors and closing note", () => {
  it("throws on empty input with a smartctl -a fix", () => {
    expect(() => run("", VERDICT)).toThrowError(ToolError);
    try {
      run("   ", VERDICT);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/smartctl -a/);
    }
  });

  it("throws on text that is not smartctl output", () => {
    expect(() => run("the quick brown fox jumps over the lazy dog", VERDICT)).toThrowError(
      ToolError,
    );
    try {
      run("the quick brown fox jumps over the lazy dog", VERDICT);
    } catch (e) {
      expect((e as ToolError).code).toBe("not-smartctl");
      expect((e as ToolError).fix).toMatch(/smartctl -a/);
    }
  });

  it("throws when smartctl output has no SMART data section", () => {
    const infoOnly = `smartctl 7.2 2020-12-30 r5155 [x86_64-linux-5.15.0] (local build)

=== START OF INFORMATION SECTION ===
Device Model:     WDC WD40EFRX-68N32N0
Serial Number:    WD-WCC7K1234567
`;
    try {
      run(infoOnly, VERDICT);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-smart-data");
      expect((e as ToolError).fix).toMatch(/smartctl -a/);
    }
  });

  it("rejects an unknown detail level", () => {
    expect(() => run(HEALTHY_ATA, { detail: "everything" })).toThrowError(/Unknown detail level/);
  });

  it("always closes with the honest limits of SMART", () => {
    for (const fixture of [HEALTHY_ATA, FAILING_ATA, HEALTHY_NVME]) {
      const out = run(fixture, VERDICT);
      expect(out).toContain("SMART predicts only some failures");
      expect(out).toContain("Keep backups either way");
    }
  });

  it("uses no em dashes or en dashes anywhere in its output", () => {
    // Built from code points so this file itself stays free of the characters.
    const dashes = [0x2013, 0x2014].map((cp) => String.fromCodePoint(cp));
    for (const fixture of [HEALTHY_ATA, FAILING_ATA, CABLE_ATA, BRIEF_ATA, HEALTHY_NVME]) {
      const out = run(fixture, FULL);
      for (const dash of dashes) expect(out).not.toContain(dash);
    }
  });
});
