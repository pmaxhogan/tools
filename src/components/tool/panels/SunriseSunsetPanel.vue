<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { LocateFixed } from "lucide-vue-next";
import { ToolError, type SelectOption, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  run,
  solarPosition,
  sunTimes,
  ZENITH_ASTRONOMICAL,
  ZENITH_BLUE,
  ZENITH_CIVIL,
  ZENITH_GOLDEN,
  ZENITH_NAUTICAL,
  ZENITH_SUNRISE,
  type SunTimes,
} from "@/tools/sunrise-sunset-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText } from "@/lib/key-value";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Sun and Golden Hour Calculator.
 *
 * The generic shell asks the reader to know that line one is the place, line
 * two is "on 2026-06-21", and line three is "tz Europe/Berlin". This panel
 * gives each of those its own control and draws the day: a strip of sky bands
 * from night through the twilights to full day, the sun's path above the
 * horizon, and ticks at sunrise, solar noon, and sunset.
 *
 * The graphic is drawn from the same pure functions the tool runs on
 * (PROJECT.md rule 27): `sunTimes` for the event instants and `solarPosition`
 * sampled across the day for the altitude curve and the band edges, both
 * classified against the tool's own exported `ZENITH_*` constants so a band
 * edge and the matching row in the table below can never disagree. Every
 * number in the table is the tool's own `run()` output, unchanged.
 *
 * The place is resolved once, by `run()`, and the panel reads the coordinates
 * and the display zone back out of the result rather than parsing the text a
 * second time. That keeps the city table and the coordinate reader in the
 * logic layer where they belong.
 *
 * Nothing touches `window`, `Intl` defaults, or `navigator` until `onMounted`
 * or a click handler. Location is read only when the reader presses "Use my
 * location", it lands in the visible field first, and the URL is written from
 * what the fields hold.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

const detailSpec = computed<SelectOptionSpec | null>(() => {
  const spec = props.meta.options?.find((o) => o.id === "detail");
  return spec !== undefined && spec.kind === "select" ? spec : null;
});

const detail = ref<string>(detailSpec.value?.default ?? "summary");

/**
 * The zone the times are read in. "auto" is not a value the tool understands,
 * so it means "write no time zone line at all" and let the logic fall back to
 * the home zone of a named city, or UTC for bare coordinates.
 */
const AUTO_ZONE = "auto";

const COMMON_ZONES: readonly string[] = [
  "UTC",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const zone = ref<string>(AUTO_ZONE);
/** The reader's own zone, discovered after mount so the server render matches. */
const browserZone = ref<string | null>(null);

const zoneSpec = computed<SelectOptionSpec>(() => {
  const options: SelectOption[] = [
    {
      value: AUTO_ZONE,
      label: "Automatic",
      synonyms: ["default", "local", "city time", "home zone"],
    },
  ];
  if (browserZone.value && !COMMON_ZONES.includes(browserZone.value)) {
    options.push({
      value: browserZone.value,
      label: `${browserZone.value} (this device)`,
      synonyms: ["my zone", "device", "browser"],
    });
  }
  for (const name of COMMON_ZONES) {
    options.push({
      value: name,
      label: name === browserZone.value ? `${name} (this device)` : name,
      synonyms: [name.replace(/[_/]/g, " ")],
    });
  }
  return { kind: "select", id: "sun-zone", label: "Time zone", default: AUTO_ZONE, options };
});

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const location = ref<string>("");
const date = ref<string>("");

const geoBusy = ref<boolean>(false);
const geoNote = ref<string | null>(null);

const output = ref<Record<string, string> | null>(null);
const runError = ref<{ message: string; fix?: string } | null>(null);

const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

function describe(err: unknown): { message: string; fix?: string } {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : String(err) };
}

/** The multi line input the tool actually reads, built from the controls. */
function toolInput(): string {
  const lines = [location.value.trim()];
  if (date.value) lines.push(`on ${date.value}`);
  if (zone.value !== AUTO_ZONE) lines.push(`tz ${zone.value}`);
  return lines.join("\n");
}

function evaluate(): void {
  if (!location.value.trim()) {
    output.value = null;
    runError.value = null;
    return;
  }
  try {
    output.value = run(toolInput(), { detail: detail.value });
    runError.value = null;
  } catch (err) {
    output.value = null;
    runError.value = describe(err);
  }
}

/* ------------------------------------------------------------------ *
 * reading the result back: coordinates, zone, target date
 * ------------------------------------------------------------------ */

/** The `Location` row always carries "12.3456 N, 65.4321 W", named place or not. */
const COORD_ROW = /(\d+(?:\.\d+)?)\s*([NS]),\s*(\d+(?:\.\d+)?)\s*([EW])/;
const DATE_ROW = /^(\d{4})-(\d{2})-(\d{2})/;

interface Resolved {
  lat: number;
  lon: number;
  zone: string;
  year: number;
  month: number;
  day: number;
}

const resolved = computed<Resolved | null>(() => {
  const out = output.value;
  if (!out) return null;
  const coords = COORD_ROW.exec(out.Location ?? "");
  const target = DATE_ROW.exec(out.Date ?? "");
  if (!coords || !target) return null;
  const displayZone = (out["Time zone"] ?? "UTC").split(",")[0].trim();
  return {
    lat: coords[2] === "S" ? -Number(coords[1]) : Number(coords[1]),
    lon: coords[4] === "W" ? -Number(coords[3]) : Number(coords[3]),
    zone: displayZone,
    year: Number(target[1]),
    month: Number(target[2]),
    day: Number(target[3]),
  };
});

/* ------------------------------------------------------------------ *
 * zone formatting (Intl is the only zone database a browser has)
 * ------------------------------------------------------------------ */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(name: string): Intl.DateTimeFormat {
  let fmt = formatters.get(name);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(name, fmt);
  }
  return fmt;
}

interface ZoneFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function fieldsIn(name: string, ms: number): ZoneFields {
  const parts = zoneFormatter(name).formatToParts(new Date(ms));
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * HH:MM in the display zone, rounded to the nearest minute exactly the way the
 * tool rounds it, so a tick under the graphic reads the same as its row.
 */
function clockIn(name: string, ms: number): string {
  const f = fieldsIn(name, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE);
  return `${pad2(f.hour)}:${pad2(f.minute)}`;
}

function daysApart(a: ZoneFields, target: { year: number; month: number; day: number }): number {
  const actual = Date.UTC(a.year, a.month - 1, a.day);
  const wanted = Date.UTC(target.year, target.month - 1, target.day);
  return Math.round((actual - wanted) / MS_PER_DAY);
}

/* ------------------------------------------------------------------ *
 * the day arc
 * ------------------------------------------------------------------ */

/** Geometric altitudes, in degrees, of the thresholds the tool works in. */
const ALT_GOLDEN_TOP = 90 - ZENITH_GOLDEN;
const ALT_HORIZON = 90 - ZENITH_SUNRISE;
const ALT_BLUE = 90 - ZENITH_BLUE;
const ALT_CIVIL = 90 - ZENITH_CIVIL;
const ALT_NAUTICAL = 90 - ZENITH_NAUTICAL;
const ALT_ASTRONOMICAL = 90 - ZENITH_ASTRONOMICAL;

type BandId = "day" | "golden" | "civil" | "blue" | "nautical" | "astronomical" | "night";

const BAND_LABELS: Record<BandId, string> = {
  day: "Day",
  golden: "Golden hour",
  civil: "Civil twilight",
  blue: "Blue hour",
  nautical: "Nautical twilight",
  astronomical: "Astronomical twilight",
  night: "Night",
};

const BAND_ORDER: readonly BandId[] = [
  "day",
  "golden",
  "civil",
  "blue",
  "nautical",
  "astronomical",
  "night",
];

/**
 * Which band a geometric altitude falls in. Geometric, not apparent: the
 * tool's own rise and set instants are geometric zenith crossings with no
 * refraction term, so classifying on the refracted altitude would push every
 * edge about half a degree away from the tick that names it.
 */
function bandOf(altitude: number): BandId {
  if (altitude >= ALT_GOLDEN_TOP) return "day";
  if (altitude >= ALT_HORIZON) return "golden";
  if (altitude >= ALT_BLUE) return "civil";
  if (altitude >= ALT_CIVIL) return "blue";
  if (altitude >= ALT_NAUTICAL) return "nautical";
  if (altitude >= ALT_ASTRONOMICAL) return "astronomical";
  return "night";
}

/* The drawing surface, in SVG user units. */
const ARC_W = 520;
const ARC_H = 168;
const PLOT_LEFT = 24;
const PLOT_RIGHT = 496;
const HORIZON_Y = 110;
const ARC_TOP = 22;
const STRIP_H = 14;
/** Samples across the 24 hour window: one every four minutes. */
const SAMPLES = 360;

interface ArcModel {
  segments: { id: BandId; x: number; width: number }[];
  path: string;
  ticks: { x: number; label: string; caption: string; major: boolean }[];
  sun: { x: number; y: number; label: string } | null;
  peak: number;
  bands: BandId[];
  note: string | null;
  title: string;
}

/** Anchor the tool's own calendar day, then let `sunTimes` do the rest. */
function anchorFor(target: Resolved): SunTimes {
  let anchor = Date.UTC(target.year, target.month - 1, target.day);
  let times = sunTimes(new Date(anchor), target.lat, target.lon);
  // Solar noon has to land on the requested local date. It misses by a day
  // only where the zone offset and the longitude disagree in sign, which is
  // real: Samoa and Kiribati sit east of the date line on a western longitude.
  const drift = daysApart(fieldsIn(target.zone, times.solarNoon.getTime()), target);
  if (drift !== 0) {
    anchor -= Math.max(-1, Math.min(1, drift)) * MS_PER_DAY;
    times = sunTimes(new Date(anchor), target.lat, target.lon);
  }
  return times;
}

const arc = computed<ArcModel | null>(() => {
  const target = resolved.value;
  if (!target) return null;

  const times = anchorFor(target);
  const noonMs = times.solarNoon.getTime();
  const startMs = noonMs - 12 * 60 * MS_PER_MINUTE;
  const spanMs = 24 * 60 * MS_PER_MINUTE;
  const x = (ms: number): number =>
    PLOT_LEFT + ((ms - startMs) / spanMs) * (PLOT_RIGHT - PLOT_LEFT);

  // Sample the altitude across the whole solar day.
  const altitudes: number[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const ms = startMs + (i / SAMPLES) * spanMs;
    altitudes.push(solarPosition(new Date(ms), target.lat, target.lon).geometricAltitude);
  }

  // Contiguous runs of one band become one rectangle each.
  const segments: { id: BandId; x: number; width: number }[] = [];
  const present = new Set<BandId>();
  let runStart = 0;
  let runBand = bandOf(altitudes[0]);
  present.add(runBand);
  for (let i = 1; i <= SAMPLES; i += 1) {
    const band = bandOf(altitudes[i]);
    if (band === runBand) continue;
    const left = PLOT_LEFT + (runStart / SAMPLES) * (PLOT_RIGHT - PLOT_LEFT);
    const right = PLOT_LEFT + (i / SAMPLES) * (PLOT_RIGHT - PLOT_LEFT);
    segments.push({ id: runBand, x: left, width: right - left });
    runBand = band;
    runStart = i;
    present.add(band);
  }
  segments.push({
    id: runBand,
    x: PLOT_LEFT + (runStart / SAMPLES) * (PLOT_RIGHT - PLOT_LEFT),
    width: PLOT_RIGHT - (PLOT_LEFT + (runStart / SAMPLES) * (PLOT_RIGHT - PLOT_LEFT)),
  });

  // The curve above the horizon. Scaled to the day's own peak so a low winter
  // sun still reads as an arc rather than a flat line.
  const peak = Math.max(...altitudes);
  const scale = Math.max(peak, 5);
  const y = (altitude: number): number =>
    HORIZON_Y - (Math.max(altitude, 0) / scale) * (HORIZON_Y - ARC_TOP);

  let path = "";
  let drawing = false;
  for (let i = 0; i <= SAMPLES; i += 1) {
    if (altitudes[i] < ALT_HORIZON) {
      drawing = false;
      continue;
    }
    const px = PLOT_LEFT + (i / SAMPLES) * (PLOT_RIGHT - PLOT_LEFT);
    path += `${drawing ? "L" : "M"}${px.toFixed(1)} ${y(altitudes[i]).toFixed(1)}`;
    drawing = true;
  }

  const ticks: ArcModel["ticks"] = [];
  const addTick = (when: Date | null, caption: string, major: boolean): void => {
    if (!when) return;
    const ms = when.getTime();
    if (ms < startMs || ms > startMs + spanMs) return;
    ticks.push({ x: x(ms), label: clockIn(target.zone, ms), caption, major });
  };
  addTick(times.sunrise, "sunrise", true);
  addTick(times.solarNoon, "solar noon", false);
  addTick(times.sunset, "sunset", true);

  // The live sun only belongs on the picture when the picture is of today.
  const now = Date.now();
  let sun: ArcModel["sun"] = null;
  const nowFields = fieldsIn(target.zone, now);
  if (daysApart(nowFields, target) === 0 && now >= startMs && now <= startMs + spanMs) {
    const altitude = solarPosition(new Date(now), target.lat, target.lon).geometricAltitude;
    sun = {
      x: x(now),
      y: altitude >= ALT_HORIZON ? y(altitude) : HORIZON_Y + STRIP_H / 2,
      label: `Sun now, ${altitude.toFixed(1)} degrees`,
    };
  }

  const note =
    times.states.day === "up-all-day"
      ? "The sun never sets on this date."
      : times.states.day === "down-all-day"
        ? "The sun never rises on this date."
        : null;

  return {
    segments,
    path,
    ticks,
    sun,
    peak,
    bands: BAND_ORDER.filter((id) => present.has(id)),
    note,
    title:
      `The sun's day at ${output.value?.Location ?? "this place"}: ` +
      `sky bands from night to day, with the sun's path above the horizon. ` +
      `Highest altitude ${peak.toFixed(1)} degrees.`,
  };
});

/** The "copy everything" payload, spelled the same way the generic shell does. */
const allRowsText = computed<string>(() =>
  output.value ? rowsToText(recordToRows(output.value)) : "",
);

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

/**
 * Reads the device location once, on this click only, and writes it into the
 * visible field. The URL is written by the same debounced watcher that runs
 * while typing, so the reader sees the coordinates before they are shared.
 */
function useMyLocation(): void {
  geoNote.value = null;
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    geoNote.value = "This browser offers no location API. Type a city or coordinates instead.";
    return;
  }
  geoBusy.value = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      geoBusy.value = false;
      location.value = `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`;
      geoNote.value = "Filled from your device. The position stays in this tab.";
    },
    (error) => {
      geoBusy.value = false;
      geoNote.value =
        error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. Type a city or coordinates instead."
          : error.code === error.TIMEOUT
            ? "The location request timed out. Try again, or type a city."
            : "Your location is not available right now. Type a city or coordinates instead.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: location.value.trim() ? toolInput() : undefined,
      opts: { detail: detail.value },
    });
  }, 120);
}

watch([location, date, zone, detail], schedule);

const SHARED_DATE = /^on\s+(\d{4}-\d{1,2}-\d{1,2})$/i;
const SHARED_ZONE = /^(?:tz|timezone|time\s*zone|zone|in)\s+(.+)$/i;

/** Unpack a shared link's input back into the three controls. */
function restoreInput(raw: string): void {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  location.value = lines[0];
  for (const line of lines.slice(1)) {
    const asDate = SHARED_DATE.exec(line);
    if (asDate) {
      const [y, m, d] = asDate[1].split("-");
      date.value = `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
      continue;
    }
    const asZone = SHARED_ZONE.exec(line);
    if (asZone) {
      zone.value = asZone[1].trim();
      continue;
    }
    if (line.includes("/") || /^(utc|gmt)$/i.test(line)) zone.value = line;
  }
}

function todayInBrowserZone(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

onMounted(() => {
  try {
    browserZone.value = new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    browserZone.value = null;
  }

  const frag = readFragment();
  if (frag.input !== undefined && frag.input !== "") restoreInput(frag.input);
  if (frag.opts.detail !== undefined) detail.value = frag.opts.detail;
  if (!date.value) date.value = todayInBrowserZone();

  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Place, date, zone, detail -->
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="sun-location" class="text-xs text-muted-foreground">Location</Label>
        <div class="flex gap-2">
          <Input
            id="sun-location"
            :model-value="location"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Tokyo, or 40.7128, -74.0060"
            class="h-9 min-w-0 flex-1 bg-secondary"
            :aria-invalid="runError !== null"
            @update:model-value="(v) => (location = String(v))"
          />
          <Button
            variant="outline"
            size="icon-sm"
            class="mt-0.5 shrink-0"
            aria-label="Use my location"
            :disabled="geoBusy"
            @click="useMyLocation"
          >
            <LocateFixed class="size-4" />
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          A major city by name, or a latitude and longitude pair.
        </p>
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="sun-date" class="text-xs text-muted-foreground">Date</Label>
        <Input
          id="sun-date"
          type="date"
          :model-value="date"
          class="h-9 bg-secondary font-mono"
          @update:model-value="(v) => (date = String(v))"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="sun-zone" class="text-xs text-muted-foreground">Time zone</Label>
        <SearchableSelect
          id="sun-zone"
          :spec="zoneSpec"
          :model-value="zone"
          @update:model-value="(v) => (zone = String(v))"
        />
        <p class="text-xs text-muted-foreground">
          Automatic reads the times in a named city's own zone, and in UTC for bare coordinates.
        </p>
      </div>

      <OptionControl
        v-if="detailSpec"
        :spec="detailSpec"
        :model-value="detail"
        @update:model-value="(v) => (detail = String(v))"
      />
    </div>

    <p v-if="geoNote" role="status" class="text-xs text-muted-foreground">{{ geoNote }}</p>

    <!-- The day -->
    <div
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
      aria-live="polite"
    >
      <template v-if="arc">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span class="text-sm font-medium">{{ output?.Location }}</span>
          <span class="font-mono text-xs text-muted-foreground">
            {{ output?.["Day length"] }}
          </span>
        </div>

        <svg
          class="sun-arc h-auto w-full"
          :viewBox="`0 0 ${ARC_W} ${ARC_H}`"
          role="img"
          :aria-label="arc.title"
          focusable="false"
        >
          <!-- Sky bands across the whole solar day -->
          <g>
            <rect
              v-for="(segment, i) in arc.segments"
              :key="`${segment.id}-${i}`"
              :x="segment.x"
              :y="HORIZON_Y"
              :width="segment.width"
              :height="STRIP_H"
              :fill="`var(--band-${segment.id})`"
            />
          </g>
          <rect
            :x="PLOT_LEFT"
            :y="HORIZON_Y"
            :width="PLOT_RIGHT - PLOT_LEFT"
            :height="STRIP_H"
            fill="none"
            stroke="var(--border)"
          />

          <!-- The horizon itself -->
          <line
            :x1="PLOT_LEFT"
            :y1="HORIZON_Y"
            :x2="PLOT_RIGHT"
            :y2="HORIZON_Y"
            stroke="var(--muted-foreground)"
            stroke-width="1"
          />

          <!-- Ticks -->
          <g v-for="tick in arc.ticks" :key="tick.caption">
            <line
              :x1="tick.x"
              :y1="ARC_TOP - 6"
              :x2="tick.x"
              :y2="HORIZON_Y + STRIP_H"
              stroke="var(--border)"
              stroke-width="1"
              :stroke-dasharray="tick.major ? undefined : '3 3'"
            />
            <text
              :x="tick.x"
              :y="HORIZON_Y + STRIP_H + 16"
              text-anchor="middle"
              font-size="11"
              class="font-mono"
              fill="var(--foreground)"
            >
              {{ tick.label }}
            </text>
            <text
              :x="tick.x"
              :y="HORIZON_Y + STRIP_H + 30"
              text-anchor="middle"
              font-size="10"
              fill="var(--muted-foreground)"
            >
              {{ tick.caption }}
            </text>
          </g>

          <!-- The sun's path above the horizon -->
          <path
            v-if="arc.path"
            :d="arc.path"
            fill="none"
            stroke="var(--primary)"
            stroke-width="2"
            stroke-linecap="round"
          />

          <!-- Where the sun is right now, on today only -->
          <g v-if="arc.sun">
            <circle
              :cx="arc.sun.x"
              :cy="arc.sun.y"
              r="6"
              fill="var(--sun-disc)"
              stroke="var(--foreground)"
              stroke-width="1"
            />
            <title>{{ arc.sun.label }}</title>
          </g>

          <text
            :x="PLOT_LEFT"
            :y="ARC_TOP - 8"
            font-size="10"
            fill="var(--muted-foreground)"
            class="font-mono"
          >
            peak {{ arc.peak.toFixed(1) }}&#176;
          </text>
        </svg>

        <p v-if="arc.note" class="text-xs text-muted-foreground">{{ arc.note }}</p>

        <!-- Legend, so the colors are named rather than guessed at -->
        <ul class="sun-arc flex flex-wrap gap-x-4 gap-y-1.5">
          <li
            v-for="band in arc.bands"
            :key="band"
            class="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              class="size-3 rounded-[3px] ring-1 ring-border"
              :style="{ background: `var(--band-${band})` }"
            />
            {{ BAND_LABELS[band] }}
          </li>
        </ul>
        <p class="text-xs text-muted-foreground">
          The strip runs one full day, centered on solar noon, so the two ends are solar midnight.
          Times are read in {{ resolved?.zone }}.
        </p>
      </template>

      <template v-else-if="runError">
        <p class="text-sm font-medium text-destructive">{{ runError.message }}</p>
        <p v-if="runError.fix" class="text-sm text-muted-foreground">{{ runError.fix }}</p>
      </template>

      <template v-else>
        <p class="text-sm text-muted-foreground">
          Name a place to see its day drawn here: night, the twilights, the golden hour, and the
          sun's path. It updates as you type.
        </p>
      </template>
    </div>

    <!-- Everything the tool worked out -->
    <div v-if="output" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Full result
        </span>
        <CopyButton :text="allRowsText" label="Copy" />
      </div>
      <KeyValueGrid :record="output" />
    </div>
  </div>
</template>

<style scoped>
/**
 * Band fills, one pair per theme. They are wide, low chroma color fields with
 * no text on them; every label sits outside a band on the panel surface, so
 * the reading contrast is the page's own foreground pair in both themes.
 */
.sun-arc {
  --band-night: #cdd3e6;
  --band-astronomical: #b8c2df;
  --band-nautical: #9fadd4;
  --band-blue: #8497c9;
  --band-civil: #e3b98a;
  --band-golden: #edc06a;
  --band-day: #f6e0a3;
  --sun-disc: #f5c518;
}

.dark .sun-arc {
  --band-night: #23273a;
  --band-astronomical: #2c3149;
  --band-nautical: #363d5c;
  --band-blue: #434c74;
  --band-civil: #77542c;
  --band-golden: #a2762f;
  --band-day: #c39a3c;
  --sun-disc: #f0c033;
}
</style>
