import { ToolError, type ToolLogic } from "../types";
import {
  ATA_ATTRIBUTES,
  NVME_CRITICAL_WARNING_BITS,
  NVME_DATA_UNIT_BYTES,
  NVME_FIELDS,
  type AtaAttributeInfo,
} from "./data";

export interface SmartOpts {
  /** 'verdict' (default) or 'full' to append every parsed attribute. */
  detail: string;
  [key: string]: unknown;
}

export type SmartKind = "ata" | "nvme";

/** One row of the ATA SMART attribute table, from either column layout. */
export interface AtaAttrRow {
  id: number;
  /** The name smartctl printed, which beats our table for vendor renames. */
  name: string;
  flags: string;
  value: number | null;
  worst: number | null;
  thresh: number | null;
  /** "Pre-fail" or "Old_age" in the -a layout, null in the -x brief layout. */
  type: string | null;
  updated: string | null;
  /** Raw WHEN_FAILED / FAIL cell. "-" means it has never failed. */
  whenFailed: string;
  /** Raw cell verbatim, for example "34 (Min/Max 19/45)". */
  raw: string;
  /** First integer found in the raw cell, or null when there is none. */
  rawInt: number | null;
}

export interface SelfTestInfo {
  logged: boolean;
  description?: string;
  status?: string;
  lifetimeHours?: number;
}

export interface SmartReport {
  kind: SmartKind;
  model?: string;
  family?: string;
  serial?: string;
  firmware?: string;
  capacity?: string;
  rotation?: string;
  health?: string;
  attrs: AtaAttrRow[];
  nvme: Record<string, string>;
  selfTest: SelfTestInfo;
  errorCount?: number;
}

interface Finding {
  severity: "fail" | "watch";
  /** Short clause used to build the headline. */
  reason: string;
  /** Full explanatory line for the findings list. */
  line: string;
}

export type Verdict = "HEALTHY" | "WATCH" | "FAILING";

/* ------------------------------------------------------------------ utils */

function fmtInt(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString();
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

/** First integer in a string, commas tolerated. Null when there is none. */
function firstInt(s: string): number | null {
  const m = /-?\d[\d,]*/.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Parses "0x04" as hex and "1,234" / "34 Celsius" / "3%" as decimal. */
function parseValue(s: string): number | null {
  const t = (s ?? "").trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  return firstInt(t);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function pick(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  return m ? m[1].trim() : undefined;
}

function normalizeKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hoursToSpan(hours: number): string {
  const years = Math.floor(hours / 8760);
  const days = Math.floor((hours - years * 8760) / 24);
  if (years > 0)
    return `${years} ${plural(years, "year", "years")}, ${days} ${plural(days, "day", "days")}`;
  return `${days} ${plural(days, "day", "days")}`;
}

function bytesToTb(bytes: number): string {
  const tb = bytes / 1e12;
  if (tb >= 1) return `${Number(tb.toFixed(2))} TB`;
  const gb = bytes / 1e9;
  return `${Number(gb.toFixed(2))} GB`;
}

/* ---------------------------------------------------------------- parsing */

const SMARTCTL_MARKERS = [
  /smartctl \d/i,
  /=== START OF INFORMATION SECTION ===/,
  /=== START OF SMART DATA SECTION ===/,
  /=== START OF READ SMART DATA SECTION ===/,
  /SMART Attributes Data Structure/i,
  /SMART\/Health Information \(NVMe/i,
  /SMART overall-health self-assessment/i,
];

function looksLikeSmartctl(text: string): boolean {
  return SMARTCTL_MARKERS.some((re) => re.test(text));
}

const ROW_RE = /^\s*(\d{1,3})\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+|-{2,})\s*(.*)$/;

export function parseAtaAttributes(lines: string[]): AtaAttrRow[] {
  const start = lines.findIndex((l) => /^\s*ID#\s+ATTR/i.test(l));
  if (start === -1) return [];

  const rows: AtaAttrRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) break;
    // The -x legend hangs off the flag column with pipe characters.
    if (trimmed.startsWith("|")) continue;

    const m = ROW_RE.exec(line);
    if (!m) break;

    const rest = (m[7] ?? "").trim();
    const tokens = rest ? rest.split(/\s+/) : [];

    let type: string | null = null;
    let updated: string | null = null;
    let whenFailed = "-";
    let raw = "";

    if (tokens.length && /^(Pre-fail|Old_age)$/i.test(tokens[0])) {
      type = tokens[0];
      updated = tokens[1] ?? null;
      whenFailed = tokens[2] ?? "-";
      raw = tokens.slice(3).join(" ");
    } else if (tokens.length) {
      whenFailed = tokens[0];
      raw = tokens.slice(1).join(" ");
    }

    rows.push({
      id: Number(m[1]),
      name: m[2],
      flags: m[3],
      value: Number(m[4]),
      worst: Number(m[5]),
      thresh: /^\d+$/.test(m[6]) ? Number(m[6]) : null,
      type,
      updated,
      whenFailed: whenFailed || "-",
      raw,
      rawInt: firstInt(raw),
    });
  }
  return rows;
}

export function parseNvmeHealth(lines: string[]): Record<string, string> {
  const start = lines.findIndex((l) => /SMART\/Health Information \(NVMe/i.test(l));
  const out: Record<string, string> = {};
  if (start === -1) return out;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = /^([A-Za-z][^:]*):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    out[normalizeKey(m[1])] = m[2].trim();
  }
  return out;
}

function parseSelfTest(lines: string[]): SelfTestInfo {
  const joined = lines.join("\n");
  if (/No self-tests have been logged|No Self-tests Logged/i.test(joined)) return { logged: false };

  const row = lines.find((l) => /^#\s*\d+\s+\S/.test(l.trim()));
  if (!row) return { logged: false };

  const cells = row
    .trim()
    .replace(/^#\s*\d+\s+/, "")
    .split(/\s{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);

  const hours = cells.map((c) => (/^\d+$/.test(c) ? Number(c) : null)).find((n) => n !== null);

  return {
    logged: true,
    description: cells[0],
    status: cells[1],
    lifetimeHours: hours ?? undefined,
  };
}

export function parseSmart(text: string): SmartReport {
  const lines = text.split(/\r?\n/);

  const attrs = parseAtaAttributes(lines);
  const nvme = parseNvmeHealth(lines);

  const nvmeHinted =
    Object.keys(nvme).length > 0 ||
    /SMART\/Health Information \(NVMe/i.test(text) ||
    /NVMe Version:/i.test(text) ||
    /\/dev\/nvme/i.test(text);

  const kind: SmartKind = attrs.length > 0 ? "ata" : nvmeHinted ? "nvme" : "ata";

  if (attrs.length === 0 && Object.keys(nvme).length === 0)
    throw new ToolError(
      "no-smart-data",
      "This looks like smartctl output, but it has no SMART attribute table and no NVMe health section.",
      "Run `smartctl -a /dev/sda` (or `smartctl -a /dev/nvme0`) as root and paste the whole output, not just the information section.",
    );

  return {
    kind,
    model: pick(text, /^(?:Device Model|Model Number|Product):\s*(.+)$/m),
    family: pick(text, /^Model Family:\s*(.+)$/m),
    serial: pick(text, /^Serial Number:\s*(.+)$/m),
    firmware: pick(text, /^(?:Firmware Version|Revision):\s*(.+)$/m),
    capacity: pick(
      text,
      /^(?:User Capacity|Total NVM Capacity|Namespace 1 Size\/Capacity):\s*(.+)$/m,
    ),
    rotation: pick(text, /^Rotation Rate:\s*(.+)$/m),
    health:
      pick(text, /SMART overall-health self-assessment test result:\s*(\S+)/i) ??
      pick(text, /SMART Health Status:\s*(\S+)/i),
    attrs,
    nvme,
    selfTest: parseSelfTest(lines),
    errorCount: /No Errors Logged/i.test(text)
      ? 0
      : (firstInt(pick(text, /ATA Error Count:\s*(\d+)/i) ?? "") ?? undefined),
  };
}

/* -------------------------------------------------------------- accessors */

function attr(report: SmartReport, id: number): AtaAttrRow | undefined {
  return report.attrs.find((a) => a.id === id);
}

function rawOf(report: SmartReport, id: number): number | null {
  const a = attr(report, id);
  return a ? a.rawInt : null;
}

function info(row: AtaAttrRow): AtaAttributeInfo | undefined {
  return ATA_ATTRIBUTES[row.id];
}

/** "-" means never; -a prints FAILING_NOW / In_the_past, -x prints NOW / Past. */
function failedNow(row: AtaAttrRow): boolean {
  return /FAILING_NOW|^NOW$/i.test(row.whenFailed);
}

function failedPast(row: AtaAttrRow): boolean {
  return /In_the_past|^Past$/i.test(row.whenFailed);
}

function temperatureOf(report: SmartReport): number | null {
  if (report.kind === "nvme") return parseValue(report.nvme.temperature ?? "");
  return rawOf(report, 194) ?? rawOf(report, 190);
}

function nvmeNum(report: SmartReport, key: string): number | null {
  const v = report.nvme[key];
  return v === undefined ? null : parseValue(v);
}

/** Decodes the NVMe Critical Warning bitmask into the bits that are set. */
export function decodeCriticalWarning(mask: number): { label: string; meaning: string }[] {
  return NVME_CRITICAL_WARNING_BITS.filter((b) => (mask & (1 << b.bit)) !== 0).map((b) => ({
    label: b.label,
    meaning: b.meaning,
  }));
}

/* -------------------------------------------------------- verdict engine */

function ataFindings(report: SmartReport): Finding[] {
  const found: Finding[] = [];
  const say = (row: AtaAttrRow, advice: string): string => {
    const meaning = info(row)?.meaning ?? "";
    return `${row.id} ${row.name}: ${advice}${meaning ? ` ${meaning}` : ""}`;
  };

  if (report.health && /FAIL/i.test(report.health))
    found.push({
      severity: "fail",
      reason: "The drive reports its own overall health self-assessment as FAILED.",
      line: `Overall health: the drive answered ${report.health} to the self-assessment. That is the drive itself telling you it expects to fail, and it is the single strongest signal SMART can give.`,
    });

  const realloc = attr(report, 5);
  const reallocRaw = realloc?.rawInt ?? 0;
  if (realloc && reallocRaw > 0) {
    const many = reallocRaw > 50;
    found.push({
      severity: many ? "fail" : "watch",
      reason: `${fmtInt(reallocRaw)} ${plural(reallocRaw, "sector has", "sectors have")} already been reallocated.`,
      line: say(
        realloc,
        `${fmtInt(reallocRaw)} ${plural(reallocRaw, "sector has", "sectors have")} been remapped to spares.${
          many
            ? " At this scale the surface is failing rather than settling, and counts like this normally keep climbing."
            : " Re-run this check in a week and compare the two counts."
        }`,
      ),
    });
  }

  const pending = attr(report, 197);
  const pendingRaw = pending?.rawInt ?? 0;
  if (pending && pendingRaw > 0)
    found.push({
      severity: "fail",
      reason: `${fmtInt(pendingRaw)} ${plural(pendingRaw, "sector is", "sectors are")} unreadable right now.`,
      line: say(
        pending,
        `${fmtInt(pendingRaw)} ${plural(pendingRaw, "sector is", "sectors are")} unreadable right now and waiting to be remapped. Whatever lives in those sectors is already gone unless you have a backup.`,
      ),
    });

  const offline = attr(report, 198);
  const offlineRaw = offline?.rawInt ?? 0;
  if (offline && offlineRaw > 0)
    found.push({
      severity: "fail",
      reason: `${fmtInt(offlineRaw)} ${plural(offlineRaw, "sector", "sectors")} failed the offline surface scan.`,
      line: say(
        offline,
        `${fmtInt(offlineRaw)} ${plural(offlineRaw, "sector", "sectors")} failed the offline surface scan the drive runs on itself and could not be recovered.`,
      ),
    });

  for (const row of report.attrs) {
    const meta = info(row);
    if (!meta?.isCritical) continue;
    if (failedNow(row))
      found.push({
        severity: "fail",
        reason: `Attribute ${row.id} ${row.name} is flagged as failing now.`,
        line: say(
          row,
          `smartctl marks this attribute as FAILING NOW, meaning the normalized value ${row.value} has dropped to or below the manufacturer threshold ${row.thresh ?? "(none)"}.`,
        ),
      });
    else if (failedPast(row))
      found.push({
        severity: "watch",
        reason: `Attribute ${row.id} ${row.name} failed its threshold at some point in the past.`,
        line: say(
          row,
          "smartctl marks this attribute as having failed in the past. It has recovered above the threshold, but the drive has been in trouble before.",
        ),
      });
  }

  // Cable errors get their own branch on purpose: they are almost never the
  // drive, so they must never escalate to FAILING no matter how large.
  const crc = attr(report, 199);
  const crcRaw = crc?.rawInt ?? 0;
  if (crc && crcRaw > 0)
    found.push({
      severity: "watch",
      reason: `${fmtInt(crcRaw)} CRC ${plural(crcRaw, "error", "errors")} on the SATA link, which points at the cable.`,
      line: say(
        crc,
        `${fmtInt(crcRaw)} ${plural(crcRaw, "transfer was", "transfers were")} corrupted between the drive and the controller. Reseat the SATA data cable at both ends, try a different cable and a different port, and check the power connector. Replacing the drive over this attribute alone is usually a wasted drive.`,
      ),
    });

  for (const row of report.attrs) {
    const meta = info(row);
    if (!meta?.isCritical) continue;
    if ([5, 197, 198].includes(row.id)) continue;
    const n = row.rawInt ?? 0;
    if (n <= 0) continue;

    const advice =
      row.id === 187
        ? `${fmtInt(n)} ${plural(n, "read", "reads")} could not be corrected by the built in error correction.`
        : row.id === 188
          ? `${fmtInt(n)} ${plural(n, "command", "commands")} timed out. Rule out the cable and the power supply before you condemn the drive.`
          : row.id === 184
            ? `${fmtInt(n)} end to end ${plural(n, "error", "errors")} recorded between the cache and the media.`
            : row.id === 10
              ? `${fmtInt(n)} spin ${plural(n, "retry", "retries")} recorded.`
              : row.id === 196
                ? `${fmtInt(n)} remap ${plural(n, "event", "events")} recorded. Compare this against attribute 5, because a gap means some remaps did not succeed.`
                : `Raw value ${fmtInt(n)}, where zero is the healthy reading.`;

    found.push({
      severity: "watch",
      reason: `Attribute ${row.id} ${row.name} is not zero.`,
      line: say(row, advice),
    });
  }

  return found;
}

function nvmeFindings(report: SmartReport): Finding[] {
  const found: Finding[] = [];

  if (report.health && /FAIL/i.test(report.health))
    found.push({
      severity: "fail",
      reason: "The controller reports its own overall health self-assessment as FAILED.",
      line: `Overall health: the controller answered ${report.health} to the self-assessment.`,
    });

  const warn = nvmeNum(report, "critical_warning");
  if (warn !== null && warn !== 0) {
    const bits = decodeCriticalWarning(warn);
    const labels = bits.length
      ? bits.map((b) => b.label.toLowerCase()).join(", ")
      : "an unknown fault";
    found.push({
      severity: "fail",
      reason: `The controller has raised a critical warning (${labels}).`,
      line: `Critical Warning: ${report.nvme.critical_warning}. ${
        bits.length
          ? bits.map((b) => `${b.label}. ${b.meaning}`).join(" ")
          : "The controller set a bit this decoder does not recognise, which still means it believes something is wrong."
      }`,
    });
  }

  const media = nvmeNum(report, "media_and_data_integrity_errors");
  if (media !== null && media > 0)
    found.push({
      severity: "fail",
      reason: `${fmtInt(media)} media and data integrity ${plural(media, "error", "errors")} recorded.`,
      line: `Media and Data Integrity Errors: ${fmtInt(media)}. ${NVME_FIELDS.media_and_data_integrity_errors.meaning}`,
    });

  const spare = nvmeNum(report, "available_spare");
  const spareThreshold = nvmeNum(report, "available_spare_threshold");
  if (spare !== null && spareThreshold !== null && spare <= spareThreshold)
    found.push({
      severity: "fail",
      reason: `Spare flash capacity is down to ${spare}%, at or under the ${spareThreshold}% threshold.`,
      line: `Available Spare: ${spare}% against a threshold of ${spareThreshold}%. ${NVME_FIELDS.available_spare.meaning}`,
    });

  const used = nvmeNum(report, "percentage_used");
  if (used !== null && used >= 90)
    found.push({
      severity: "watch",
      reason: `${used}% of the rated write endurance has been consumed.`,
      line: `Percentage Used: ${used}%. ${NVME_FIELDS.percentage_used.meaning}`,
    });

  const unsafe = nvmeNum(report, "unsafe_shutdowns");
  if (unsafe !== null && unsafe > 100)
    found.push({
      severity: "watch",
      reason: `${fmtInt(unsafe)} unsafe shutdowns recorded.`,
      line: `Unsafe Shutdowns: ${fmtInt(unsafe)}. ${NVME_FIELDS.unsafe_shutdowns.meaning}`,
    });

  return found;
}

function temperatureFinding(report: SmartReport): Finding | null {
  const temp = temperatureOf(report);
  if (temp === null) return null;
  const limit = report.kind === "nvme" ? 70 : 55;
  if (temp <= limit) return null;
  return {
    severity: "watch",
    reason: `The drive is running at ${temp} C, above the ${limit} C comfort limit.`,
    line: `Temperature: ${temp} C, above the ${limit} C mark where sustained heat starts costing you drive life. Improve airflow, add or reseat a heatsink, and move the drive away from anything else that runs hot.`,
  };
}

export function analyze(report: SmartReport): { verdict: Verdict; findings: Finding[] } {
  const findings = report.kind === "nvme" ? nvmeFindings(report) : ataFindings(report);
  const temp = temperatureFinding(report);
  if (temp) findings.push(temp);

  const verdict: Verdict = findings.some((f) => f.severity === "fail")
    ? "FAILING"
    : findings.length
      ? "WATCH"
      : "HEALTHY";

  return { verdict, findings };
}

function headline(verdict: Verdict, findings: Finding[], report: SmartReport): string {
  if (verdict === "FAILING") {
    const reasons = findings
      .filter((f) => f.severity === "fail")
      .slice(0, 2)
      .map((f) => f.reason)
      .join(" ");
    return `Back up now, then plan to replace this drive. ${reasons}`;
  }
  if (verdict === "WATCH") {
    const reasons = findings
      .slice(0, 2)
      .map((f) => f.reason)
      .join(" ");
    return `Nothing here says the drive is dying, but something is worth watching. ${reasons}`;
  }
  const health = report.health ? ` The drive self-assessment says ${report.health}.` : "";
  return `Nothing in this report is off its healthy reading.${health} Re-run this check in a month and compare, because a single snapshot cannot show a trend.`;
}

/* ---------------------------------------------------------------- sections */

function driveSection(report: SmartReport): string[] {
  const out: string[] = ["Drive"];
  const add = (label: string, value?: string): void => {
    if (value) out.push(`  ${label}: ${value}`);
  };
  add("Interface", report.kind === "nvme" ? "NVMe" : "ATA / SATA");
  add("Model", report.model);
  add("Family", report.family);
  add("Serial", report.serial);
  add("Firmware", report.firmware);
  add("Capacity", report.capacity);
  add("Rotation", report.rotation);
  add("Reported health", report.health);
  return out;
}

function lifeSection(report: SmartReport): string[] {
  const out: string[] = ["Drive life"];

  if (report.kind === "ata") {
    const poh = attr(report, 9);
    if (poh && poh.rawInt !== null) {
      const raw = poh.rawInt;
      if (raw > 100_000) {
        const hours = Math.round(raw / 60);
        out.push(
          `  Power on time: ${fmtInt(raw)} raw units. That is implausible as hours (over 11 years), so this vendor is almost certainly logging minutes, which works out to about ${fmtInt(hours)} hours or ${hoursToSpan(hours)}. Treat it as an assumption, not a fact.`,
        );
      } else {
        out.push(`  Power on time: ${fmtInt(raw)} hours, about ${hoursToSpan(raw)}.`);
      }
    }
    const cycles = rawOf(report, 12);
    if (cycles !== null) out.push(`  Power cycles: ${fmtInt(cycles)}.`);

    for (const id of [177, 173, 231, 233, 202, 232, 180]) {
      const row = attr(report, id);
      if (!row) continue;
      const meta = info(row);
      if (!meta || meta.direction !== "higher-better") continue;
      out.push(
        `  Flash wear (${row.id} ${row.name}): normalized value ${row.value} of 100, threshold ${row.thresh ?? "not set"}. Higher is better on this attribute. ${meta.meaning}`,
      );
    }

    const written = attr(report, 241);
    if (written && written.rawInt !== null) {
      const gib = /(\d[\d,]*)\s*GiB/i.exec(written.raw);
      if (gib) {
        const bytes = Number(gib[1].replace(/,/g, "")) * 1024 ** 3;
        out.push(
          `  Host writes (241 ${written.name}): ${bytesToTb(bytes)}, taken from the GiB figure the drive reported.`,
        );
      } else {
        const bytes = written.rawInt * 512;
        out.push(
          `  Host writes (241 ${written.name}): raw value ${fmtInt(written.rawInt)}. Assuming 512 byte logical blocks that is about ${bytesToTb(bytes)}, but the unit on this attribute is vendor defined, so treat it as an estimate.`,
        );
      }
    }
  } else {
    const poh = nvmeNum(report, "power_on_hours");
    if (poh !== null) out.push(`  Power on time: ${fmtInt(poh)} hours, about ${hoursToSpan(poh)}.`);
    const cycles = nvmeNum(report, "power_cycles");
    if (cycles !== null) out.push(`  Power cycles: ${fmtInt(cycles)}.`);

    const used = nvmeNum(report, "percentage_used");
    if (used !== null)
      out.push(
        `  Endurance used: ${used}% of the rated write life, so roughly ${100 - used}% is left. This is a vendor estimate of consumed write endurance, not a countdown to failure: 100% means the warranty endurance is used up, and values above 100% are allowed.`,
      );

    const spare = nvmeNum(report, "available_spare");
    const spareThreshold = nvmeNum(report, "available_spare_threshold");
    if (spare !== null)
      out.push(
        `  Available spare: ${spare}%${spareThreshold !== null ? ` against a ${spareThreshold}% warning threshold` : ""}.`,
      );

    const dw = nvmeNum(report, "data_units_written");
    if (dw !== null)
      out.push(
        `  Host writes: ${fmtInt(dw)} data units, which is exactly ${bytesToTb(dw * NVME_DATA_UNIT_BYTES)} because one NVMe data unit is 512,000 bytes.`,
      );
    const dr = nvmeNum(report, "data_units_read");
    if (dr !== null)
      out.push(
        `  Host reads: ${fmtInt(dr)} data units, which is ${bytesToTb(dr * NVME_DATA_UNIT_BYTES)}.`,
      );

    const unsafe = nvmeNum(report, "unsafe_shutdowns");
    if (unsafe !== null) out.push(`  Unsafe shutdowns: ${fmtInt(unsafe)}.`);
  }

  const temp = temperatureOf(report);
  if (temp !== null) out.push(`  Temperature: ${temp} C.`);

  if (out.length === 1) out.push("  Nothing in this report carries usable lifetime counters.");
  return out;
}

function selfTestSection(report: SmartReport): string[] {
  const out: string[] = ["Self-test"];
  const st = report.selfTest;
  const dev = report.kind === "nvme" ? "/dev/nvme0" : "/dev/sdX";
  if (!st.logged) {
    out.push(
      `  No self-tests have been logged. Run "smartctl -t short ${dev}" and check back in a couple of minutes, because a self-test exercises the media directly and can catch problems the attribute counters have not reached yet.`,
    );
  } else {
    const at =
      st.lifetimeHours !== undefined ? ` at ${fmtInt(st.lifetimeHours)} power on hours` : "";
    out.push(
      `  Last test: ${st.description ?? "unknown test"}, ${st.status ?? "unknown result"}${at}.`,
    );
  }

  const entries = nvmeNum(report, "error_information_log_entries");
  if (report.kind === "nvme") {
    if (entries !== null)
      out.push(
        `  Error log: ${fmtInt(entries)} ${plural(entries, "entry", "entries")}. ${NVME_FIELDS.error_information_log_entries.meaning}`,
      );
  } else if (report.errorCount !== undefined) {
    out.push(
      report.errorCount === 0
        ? "  Error log: no errors logged."
        : `  Error log: ${fmtInt(report.errorCount)} ${plural(report.errorCount, "entry", "entries")}. Read the full log with "smartctl -l error ${dev}" to see what the drive actually complained about.`,
    );
  }
  return out;
}

function fullSection(report: SmartReport): string[] {
  const out: string[] = ["All parsed values"];

  for (const row of report.attrs) {
    const meta = info(row);
    const when = row.whenFailed === "-" ? "never failed" : `when failed: ${row.whenFailed}`;
    out.push(
      `  ${row.id} ${row.name}: raw ${row.raw || "(empty)"}, value ${row.value}, worst ${row.worst}, threshold ${row.thresh ?? "not set"}${row.type ? `, ${row.type}` : ""}, ${when}.`,
    );
    out.push(
      `      ${
        meta
          ? `${meta.meaning}${meta.alsoKnownAs ? ` Also known as ${meta.alsoKnownAs}.` : ""}`
          : `Vendor-specific attribute. smartctl has no standard meaning for id ${row.id}, so the raw value is only comparable against this same drive over time.`
      }`,
    );
  }

  for (const [key, value] of Object.entries(report.nvme)) {
    const meta = NVME_FIELDS[key];
    out.push(`  ${meta ? meta.label : key}: ${value}`);
    out.push(
      `      ${meta ? meta.meaning : "Vendor-specific NVMe field. smartctl printed it verbatim from the controller log."}`,
    );
  }

  if (out.length === 1) out.push("  Nothing was parsed from this report.");
  return out;
}

/* -------------------------------------------------------------------- run */

export function run(input: string, opts: SmartOpts): string {
  const text = input ?? "";
  if (!text.trim())
    throw new ToolError(
      "empty-input",
      "Paste some smartctl output to decode.",
      "Run `smartctl -a /dev/sda` (or `smartctl -a /dev/nvme0`) as root and paste the whole output here.",
    );

  if (!looksLikeSmartctl(text))
    throw new ToolError(
      "not-smartctl",
      "This does not look like smartctl output. None of the section headers smartctl prints are present.",
      "Run `smartctl -a /dev/sda` (or `smartctl -a /dev/nvme0`) as root and paste the whole output, headers included.",
    );

  const detail = String(opts?.detail ?? "verdict").trim() || "verdict";
  if (detail !== "verdict" && detail !== "full")
    throw new ToolError(
      "unknown-detail",
      `Unknown detail level "${detail}".`,
      'Use "verdict" for the summary or "full" to list every parsed attribute.',
    );

  const report = parseSmart(text);
  const { verdict, findings } = analyze(report);

  const blocks: string[][] = [];

  blocks.push([`Verdict: ${verdict}`, headline(verdict, findings, report)]);
  blocks.push(driveSection(report));

  if (findings.length) {
    const list = ["Findings"];
    for (const f of findings) list.push(`  ${f.line}`);
    blocks.push(list);
  } else {
    blocks.push([
      "Findings",
      "  Nothing in this report is off its healthy reading, so there is nothing to explain here.",
    ]);
  }

  blocks.push(lifeSection(report));
  blocks.push(selfTestSection(report));

  if (detail === "full") blocks.push(fullSection(report));

  blocks.push([
    "Worth knowing",
    "  SMART predicts only some failures. Fleet studies keep finding that a large share of drives die with every one of these counters still reading zero, and plenty of drives with a handful of reallocated sectors run for years. A clean report is not a promise, and a scary one is not a death certificate.",
    "  Keep backups either way, and re-run this check on a schedule so you can compare snapshots instead of guessing from one.",
  ]);

  return blocks.map((b) => b.join("\n")).join("\n\n");
}

export default { run } satisfies ToolLogic<string, string, SmartOpts>;
