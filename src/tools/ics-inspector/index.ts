import { ToolError, type ToolLogic } from "../types";

export interface IcsOpts {
  /** Which event (0-based) to build the add-to-calendar links for, when a file has several. */
  eventIndex?: number;
  [key: string]: unknown;
}

/** A parsed iCalendar DATE or DATE-TIME value, kept in its own wall-clock components. */
export interface DateValue {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** VALUE=DATE (no time component). */
  allDay: boolean;
  /** Value ended in Z (UTC). */
  utc: boolean;
  /** TZID param, when present and not UTC. */
  tzid?: string;
}

export interface ParsedEvent {
  summary?: string;
  description?: string;
  location?: string;
  organizer?: string;
  status?: string;
  uid?: string;
  rrule?: string;
  start: DateValue;
  end?: DateValue;
  durationSeconds?: number;
}

interface PropLine {
  params: Record<string, string>;
  value: string;
}

interface Component {
  type: string;
  props: Record<string, PropLine[]>;
  children: Component[];
}

const FIX_HINT = "Export an event from your calendar app as .ics.";

/** Unfold RFC 5545 line continuations: a line starting with a space or tab extends the previous one. */
function unfold(text: string): string[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.trim() !== "") {
      lines.push(line);
    }
  }
  return lines;
}

/** Split one unfolded content line into NAME;PARAMS:VALUE, respecting quoted param values. */
function splitPropertyLine(
  line: string,
): { name: string; params: Record<string, string>; value: string } | null {
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) break;
    i++;
  }
  if (i >= line.length) return null;

  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let j = 1; j < parts.length; j++) {
    const eq = parts[j].indexOf("=");
    if (eq === -1) continue;
    const key = parts[j].slice(0, eq).toUpperCase();
    let val = parts[j].slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

/** Unescape iCalendar TEXT values: \\ -> \, \; -> ;, \, -> ',', \n or \N -> newline. */
function unescapeText(s: string): string {
  return s.replace(/\\\\|\\;|\\,|\\[nN]/g, (m) => {
    if (m === "\\\\") return "\\";
    if (m === "\\;") return ";";
    if (m === "\\,") return ",";
    return "\n";
  });
}

function parseComponents(lines: string[]): Component {
  const root: Component = { type: "ROOT", props: {}, children: [] };
  const stack: Component[] = [root];
  for (const line of lines) {
    const parsed = splitPropertyLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    if (name === "BEGIN") {
      const comp: Component = { type: value.trim().toUpperCase(), props: {}, children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      const current = stack[stack.length - 1];
      (current.props[name] ??= []).push({ params, value });
    }
  }
  return root;
}

function findAll(comp: Component, type: string): Component[] {
  const result: Component[] = [];
  for (const child of comp.children) {
    if (child.type === type) result.push(child);
    result.push(...findAll(child, type));
  }
  return result;
}

function getProp(comp: Component, name: string): PropLine | undefined {
  return comp.props[name]?.[0];
}

function pad(n: number, len = 2): string {
  return String(Math.max(0, Math.trunc(n))).padStart(len, "0");
}

function parseDateProp(prop: PropLine): DateValue {
  const value = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) {
    throw new ToolError(
      "bad-date",
      `Could not parse the date value "${value}".`,
      "Expected an iCalendar date like 20260308 or 20260308T013000Z.",
    );
  }
  const [, y, mo, d, h, mi, s, z] = m;
  const isDateOnly = prop.params.VALUE === "DATE" || h === undefined;
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: h ? Number(h) : 0,
    minute: mi ? Number(mi) : 0,
    second: s ? Number(s) : 0,
    allDay: isDateOnly,
    utc: Boolean(z),
    tzid: prop.params.TZID,
  };
}

/** RFC 5545 DURATION: P(n)W, P(n)DT(n)H(n)M(n)S, optionally negative. */
function parseDuration(s: string): number {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    s.trim(),
  );
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const minutes = Number(m[5] || 0);
  const seconds = Number(m[6] || 0);
  return sign * (weeks * 7 * 86400 + days * 86400 + hours * 3600 + minutes * 60 + seconds);
}

function formatOrganizer(prop?: PropLine): string | undefined {
  if (!prop) return undefined;
  if (prop.params.CN) return prop.params.CN;
  return prop.value.replace(/^mailto:/i, "");
}

function buildEvent(comp: Component): ParsedEvent {
  const dtstartProp = getProp(comp, "DTSTART");
  if (!dtstartProp) {
    throw new ToolError(
      "missing-dtstart",
      "An event in that file is missing DTSTART.",
      "Make sure each VEVENT has a DTSTART property.",
    );
  }

  const summaryProp = getProp(comp, "SUMMARY");
  const descProp = getProp(comp, "DESCRIPTION");
  const locProp = getProp(comp, "LOCATION");
  const dtendProp = getProp(comp, "DTEND");
  const durationProp = getProp(comp, "DURATION");
  const rruleProp = getProp(comp, "RRULE");
  const uidProp = getProp(comp, "UID");
  const organizerProp = getProp(comp, "ORGANIZER");
  const statusProp = getProp(comp, "STATUS");

  return {
    summary: summaryProp ? unescapeText(summaryProp.value) : undefined,
    description: descProp ? unescapeText(descProp.value) : undefined,
    location: locProp ? unescapeText(locProp.value) : undefined,
    uid: uidProp?.value,
    organizer: formatOrganizer(organizerProp),
    status: statusProp?.value,
    rrule: rruleProp?.value,
    start: parseDateProp(dtstartProp),
    end: dtendProp ? parseDateProp(dtendProp) : undefined,
    durationSeconds: durationProp ? parseDuration(durationProp.value) : undefined,
  };
}

function toMs(dv: DateValue): number {
  return Date.UTC(dv.year, dv.month - 1, dv.day, dv.hour, dv.minute, dv.second);
}

function fromMs(ms: number, like: DateValue): DateValue {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    allDay: like.allDay,
    utc: like.utc,
    tzid: like.tzid,
  };
}

function addSeconds(dv: DateValue, secs: number): DateValue {
  return fromMs(toMs(dv) + secs * 1000, dv);
}

function addDays(dv: DateValue, days: number): DateValue {
  return addSeconds(dv, days * 86400);
}

/** DTEND if present, else DTSTART+DURATION, else DTSTART+1 day (all-day) or +1 hour. */
export function effectiveEnd(event: ParsedEvent): DateValue {
  if (event.end) return event.end;
  if (event.durationSeconds !== undefined) return addSeconds(event.start, event.durationSeconds);
  if (event.start.allDay) return addDays(event.start, 1);
  return addSeconds(event.start, 3600);
}

function formatHuman(dv: DateValue): string {
  const datePart = `${pad(dv.year, 4)}-${pad(dv.month)}-${pad(dv.day)}`;
  if (dv.allDay) return datePart;
  const timePart = `${pad(dv.hour)}:${pad(dv.minute)}`;
  const zone = dv.utc ? " UTC" : dv.tzid ? ` ${dv.tzid}` : "";
  return `${datePart} ${timePart}${zone}`;
}

function basicDateOnly(dv: DateValue): string {
  return `${pad(dv.year, 4)}${pad(dv.month)}${pad(dv.day)}`;
}

/**
 * Basic UTC datetime format Google Calendar's dates= param expects (YYYYMMDDTHHMMSSZ).
 * DTSTART/DTEND that carry a TZID rather than a bare UTC value are treated as their wall-clock
 * time (this tool ships no timezone database), so the link is exact for UTC and floating events
 * and approximate for zoned ones.
 */
function basicDateTimeUtc(dv: DateValue): string {
  return `${basicDateOnly(dv)}T${pad(dv.hour)}${pad(dv.minute)}${pad(dv.second)}Z`;
}

function isoDateTime(dv: DateValue): string {
  const datePart = `${pad(dv.year, 4)}-${pad(dv.month)}-${pad(dv.day)}`;
  if (dv.allDay) return datePart;
  const base = `${datePart}T${pad(dv.hour)}:${pad(dv.minute)}:${pad(dv.second)}`;
  return dv.utc ? `${base}Z` : base;
}

/** Google Calendar "add event" template link. */
export function googleCalendarUrl(event: ParsedEvent): string {
  const start = event.start;
  const end = effectiveEnd(event);
  const dates = start.allDay
    ? `${basicDateOnly(start)}/${basicDateOnly(end)}`
    : `${basicDateTimeUtc(start)}/${basicDateTimeUtc(end)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.summary ?? "",
    dates,
    details: event.description ?? "",
    location: event.location ?? "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook web calendar "compose event" deep link. */
export function outlookUrl(event: ParsedEvent): string {
  const start = event.start;
  const end = effectiveEnd(event);
  const params = new URLSearchParams({
    subject: event.summary ?? "",
    startdt: isoDateTime(start),
    enddt: isoDateTime(end),
    body: event.description ?? "",
    location: event.location ?? "",
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function run(input: Uint8Array | string, opts: IcsOpts): Record<string, string> {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  if (!text.trim()) {
    throw new ToolError("empty-input", "Paste .ics text or drop a calendar file.", FIX_HINT);
  }

  const root = parseComponents(unfold(text));
  const vcalendar = root.children.find((c) => c.type === "VCALENDAR") ?? root;
  const veventComps = findAll(root, "VEVENT");

  if (veventComps.length === 0) {
    throw new ToolError(
      "no-events",
      "No calendar events found in that file.",
      "Make sure it contains a VEVENT block.",
    );
  }

  const events = veventComps.map(buildEvent);

  const calNameProp = getProp(vcalendar, "X-WR-CALNAME") ?? getProp(vcalendar, "PRODID");
  const calName = calNameProp ? unescapeText(calNameProp.value) : "Untitled calendar";

  const result: Record<string, string> = {
    Events: String(events.length),
    "Calendar name": calName,
  };

  const rawIndex =
    typeof opts.eventIndex === "number" && Number.isFinite(opts.eventIndex)
      ? Math.trunc(opts.eventIndex)
      : 0;
  const index = Math.min(Math.max(rawIndex, 0), events.length - 1);
  const linkEvent = events[index];

  if (events.length === 1) {
    const ev = events[0];
    result["Title"] = ev.summary || "(no title)";
    result["Starts"] = formatHuman(ev.start);
    result["Ends"] = formatHuman(effectiveEnd(ev));
    result["Location"] = ev.location || "-";
    result["Description"] = ev.description || "-";
    result["Organizer"] = ev.organizer || "-";
    result["Status"] = ev.status || "-";
    result["Recurrence"] = ev.rrule || "None";
    result["UID"] = ev.uid || "-";
    result["Time zone"] = ev.start.utc
      ? "UTC"
      : ev.start.tzid
        ? ev.start.tzid
        : ev.start.allDay
          ? "All day"
          : "Floating (no time zone)";
    result["Google Calendar link"] = googleCalendarUrl(ev);
    result["Outlook link"] = outlookUrl(ev);
  } else {
    events.forEach((ev, i) => {
      result[`Event ${i + 1}`] =
        `${ev.summary || "(no title)"} - ${formatHuman(ev.start)} to ${formatHuman(effectiveEnd(ev))}`;
    });
    result[`Google Calendar link (event ${index + 1})`] = googleCalendarUrl(linkEvent);
    result[`Outlook link (event ${index + 1})`] = outlookUrl(linkEvent);
  }

  return result;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, IcsOpts>;
