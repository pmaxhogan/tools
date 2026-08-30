<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { LocateFixed, Pause, Play } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  moonSnapshot,
  run,
  terminatorPath,
  type MoonSnapshot,
} from "@/tools/moon-phase-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText } from "@/lib/key-value";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Moon Phase Calculator.
 *
 * The generic shell would ask the reader to know that one line is a place and
 * another is a date, and it would print an illuminated fraction as a number
 * with no picture beside it. A moon phase is a shape, so this panel draws it.
 *
 * Everything drawn comes from the tool's own pure functions (PROJECT.md rule
 * 27): `moonSnapshot` for the phase, the illumination and the age, and
 * `terminatorPath` for the path data of the lit part of the disc, which is a
 * string the logic layer produces and this file only puts in an attribute. The
 * table underneath is the tool's own `run()` output, unchanged.
 *
 * Two clocks meet here and it matters which is which. The scrubber and the
 * month strip work in the reader's chosen local time, which is the home zone
 * of a named city and otherwise UTC; the drawing needs a real instant, so the
 * panel converts the local fields to epoch milliseconds through Intl. The zone
 * itself is read back out of `run()`, so the picture and the table can never
 * be about different moments.
 *
 * The scrubber never re-runs `run()` on its own: `run()` samples moonrise
 * across a whole day, which is tens of milliseconds, while `moonSnapshot` is a
 * fraction of one. Dragging redraws the disc immediately and the table catches
 * up on the same debounce that typing uses.
 *
 * Nothing touches `window`, `Intl` defaults, `matchMedia` or `navigator` until
 * `onMounted` or a click handler.
 */
const props = defineProps<{ meta: ToolMeta }>();

const MS_PER_MINUTE = 60_000;

/* ------------------------------------------------------------------ *
 * options, straight off the tool's own meta
 * ------------------------------------------------------------------ */

function selectSpec(id: string): SelectOptionSpec | null {
  const spec = props.meta.options?.find((option) => option.id === id);
  return spec !== undefined && spec.kind === "select" ? spec : null;
}

const hemisphereSpec = computed(() => selectSpec("hemisphere"));
const detailSpec = computed(() => selectSpec("detail"));

const hemisphere = ref<string>("north");
const detail = ref<string>("summary");

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

/** The local calendar fields the scrubber and the date box both edit. */
const year = ref(2026);
const month = ref(1);
const day = ref(1);
const minuteOfDay = ref(720);

const location = ref<string>("");

/** The zone `run()` resolved, read back out of its own output. */
const zone = ref<string>("UTC");

const geoBusy = ref(false);
const geoNote = ref<string | null>(null);

const output = ref<Record<string, string> | null>(null);
const runError = ref<{ message: string; fix?: string } | null>(null);

const reducedMotion = ref(false);
const playing = ref(false);
const mounted = ref(false);

let debounce: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let motionQuery: MediaQueryList | undefined;

/* ------------------------------------------------------------------ *
 * local fields to a real instant (Intl is the only zone database there is)
 * ------------------------------------------------------------------ */

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
      second: "2-digit",
    });
    formatters.set(name, fmt);
  }
  return fmt;
}

/** Offset of a zone from UTC in minutes at an instant. */
function offsetOf(name: string, ms: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zoneFormatter(name).formatToParts(new Date(ms));
  } catch {
    return 0;
  }
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return Math.round((asUtc - ms) / MS_PER_MINUTE);
}

/** Epoch milliseconds for local calendar fields in the resolved zone. */
function instantOf(y: number, m: number, d: number, minutes: number): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const once = guess - offsetOf(zone.value, guess) * MS_PER_MINUTE;
  return guess - offsetOf(zone.value, once) * MS_PER_MINUTE;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/* ------------------------------------------------------------------ *
 * the moment being drawn
 * ------------------------------------------------------------------ */

const momentMs = computed(() => instantOf(year.value, month.value, day.value, minuteOfDay.value));

const snapshot = computed<MoonSnapshot>(() => moonSnapshot(momentMs.value));

const dateValue = computed(() => `${year.value}-${pad2(month.value)}-${pad2(day.value)}`);

const clockValue = computed(
  () => `${pad2(Math.floor(minuteOfDay.value / 60))}:${pad2(minuteOfDay.value % 60)}`,
);

function setDate(raw: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return;
  year.value = Number(match[1]);
  month.value = Number(match[2]);
  day.value = Number(match[3]);
}

const daysInMonth = computed(() => new Date(Date.UTC(year.value, month.value, 0)).getUTCDate());

const monthLabel = computed(() =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year.value, month.value - 1, 1)),
  ),
);

/** Position in the month, in days, which is what the slider edits. */
const scrub = computed(() => day.value - 1 + minuteOfDay.value / 1440);

/** Three hour steps: fine enough that the terminator moves smoothly. */
const SCRUB_STEP = 0.125;

function setScrub(value: number): void {
  const clamped = Math.max(0, Math.min(daysInMonth.value - SCRUB_STEP, value));
  day.value = Math.floor(clamped) + 1;
  minuteOfDay.value = Math.round((clamped - Math.floor(clamped)) * 1440);
}

/* ------------------------------------------------------------------ *
 * the drawn disc
 * ------------------------------------------------------------------ */

const southern = computed(() => hemisphere.value === "south");

const litPath = computed(() =>
  terminatorPath(snapshot.value.light.fraction, snapshot.value.light.waxing, {
    cx: 50,
    cy: 50,
    r: 46,
    southern: southern.value,
  }),
);

const illuminationPercent = computed(() => snapshot.value.light.fraction * 100);

const discLabel = computed(
  () =>
    `The moon on ${dateValue.value} at ${clockValue.value}, ${snapshot.value.name.toLowerCase()}, ` +
    `${illuminationPercent.value.toFixed(1)} percent lit, drawn as it looks from the ` +
    `${southern.value ? "southern" : "northern"} hemisphere.`,
);

interface StripDay {
  day: number;
  path: string;
  percent: number;
  name: string;
}

/** One small disc per day of the month, drawn at local noon. */
const monthStrip = computed<StripDay[]>(() => {
  const days: StripDay[] = [];
  for (let d = 1; d <= daysInMonth.value; d += 1) {
    const at = moonSnapshot(instantOf(year.value, month.value, d, 720));
    days.push({
      day: d,
      path: terminatorPath(at.light.fraction, at.light.waxing, {
        cx: 16,
        cy: 16,
        r: 14,
        southern: southern.value,
      }),
      percent: at.light.fraction * 100,
      name: at.name,
    });
  }
  return days;
});

/* ------------------------------------------------------------------ *
 * running the tool
 * ------------------------------------------------------------------ */

/** The multi line input the tool reads, built from the controls. */
function toolInput(): string {
  const lines: string[] = [];
  if (location.value.trim()) lines.push(location.value.trim());
  lines.push(`${dateValue.value} ${clockValue.value}`);
  return lines.join("\n");
}

function describe(err: unknown): { message: string; fix?: string } {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : String(err) };
}

/** The Moment row always names the zone the times are read in. */
const ZONE_ROW = /^\S+ \S+ ([^\s,(]+)/;

function evaluate(): void {
  try {
    const result = run(toolInput(), { hemisphere: hemisphere.value, detail: detail.value });
    output.value = result;
    runError.value = null;
    const named = ZONE_ROW.exec(result.Moment ?? "");
    if (named && named[1] !== zone.value) zone.value = named[1];
  } catch (err) {
    output.value = null;
    runError.value = describe(err);
  }
}

function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: toolInput(),
      opts: { hemisphere: hemisphere.value, detail: detail.value },
    });
  }, 120);
}

watch([dateValue, clockValue, location, hemisphere, detail], schedule);

const allRowsText = computed(() => (output.value ? rowsToText(recordToRows(output.value)) : ""));

/* ------------------------------------------------------------------ *
 * playing the month
 * ------------------------------------------------------------------ */

function stop(): void {
  playing.value = false;
  clearInterval(ticker);
  ticker = undefined;
}

function togglePlay(): void {
  if (playing.value) {
    stop();
    return;
  }
  playing.value = true;
  ticker = setInterval(() => {
    const next = scrub.value + SCRUB_STEP;
    setScrub(next >= daysInMonth.value ? 0 : next);
  }, 90);
}

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

const SHARED_DATE = /^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/;

/** Unpack a shared link's input back into the controls. */
function restoreInput(raw: string): void {
  for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    const asDate = SHARED_DATE.exec(line);
    if (asDate) {
      year.value = Number(asDate[1]);
      month.value = Number(asDate[2]);
      day.value = Number(asDate[3]);
      if (asDate[4] !== undefined) {
        minuteOfDay.value = Number(asDate[4]) * 60 + Number(asDate[5]);
      }
      continue;
    }
    if (!location.value) location.value = line;
  }
}

function onMotionChange(): void {
  reducedMotion.value = motionQuery?.matches === true;
  if (reducedMotion.value) stop();
}

onMounted(() => {
  // The zone starts as UTC because that is what `run()` falls back to with no
  // place named, and the two must agree from the first paint. Naming a city
  // moves both at once: the tool reports the city's zone and the panel reads
  // it back out of the Moment row.
  const now = new Date();
  year.value = now.getUTCFullYear();
  month.value = now.getUTCMonth() + 1;
  day.value = now.getUTCDate();
  minuteOfDay.value = now.getUTCHours() * 60 + now.getUTCMinutes();

  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.value = motionQuery.matches;
  motionQuery.addEventListener("change", onMotionChange);

  const frag = readFragment();
  if (frag.input !== undefined && frag.input !== "") restoreInput(frag.input);
  if (frag.opts.hemisphere !== undefined) hemisphere.value = frag.opts.hemisphere;
  if (frag.opts.detail !== undefined) detail.value = frag.opts.detail;

  mounted.value = true;
  evaluate();
});

onUnmounted(() => {
  clearTimeout(debounce);
  stop();
  motionQuery?.removeEventListener("change", onMotionChange);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Date, place, hemisphere, detail -->
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="moon-date" class="text-xs text-muted-foreground">Date</Label>
        <Input
          id="moon-date"
          type="date"
          min="1900-01-01"
          max="2100-12-31"
          :model-value="dateValue"
          class="h-9 bg-secondary font-mono"
          @update:model-value="(v) => setDate(String(v))"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="moon-location" class="text-xs text-muted-foreground">
          Location (optional)
        </Label>
        <div class="flex gap-2">
          <Input
            id="moon-location"
            :model-value="location"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="Sydney, or 40.7128, -74.0060"
            class="h-9 min-w-0 flex-1 bg-secondary"
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
          Add a place for moonrise, moonset and where the moon is in your sky.
        </p>
      </div>

      <OptionControl
        v-if="hemisphereSpec"
        :spec="hemisphereSpec"
        :model-value="hemisphere"
        @update:model-value="(v) => (hemisphere = String(v))"
      />

      <OptionControl
        v-if="detailSpec"
        :spec="detailSpec"
        :model-value="detail"
        @update:model-value="(v) => (detail = String(v))"
      />
    </div>

    <p v-if="geoNote" role="status" class="text-xs text-muted-foreground">{{ geoNote }}</p>

    <!-- The disc, the scrubber and the month -->
    <div
      class="moon-disc flex flex-col gap-4 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-col items-center gap-2">
        <svg
          class="h-auto w-full max-w-[220px]"
          viewBox="0 0 100 100"
          role="img"
          :aria-label="discLabel"
          focusable="false"
        >
          <circle cx="50" cy="50" r="46" fill="var(--moon-dark)" />
          <path v-if="litPath" :d="litPath" fill="var(--moon-lit)" />
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--moon-rim)" stroke-width="0.75" />
        </svg>

        <p class="text-center text-sm font-medium">{{ snapshot.name }}</p>
        <p class="text-center font-mono text-xs text-muted-foreground">
          {{ illuminationPercent.toFixed(1) }}% lit, {{ snapshot.ageDays.toFixed(1) }} days old,
          {{ Math.round(snapshot.position.distanceKm).toLocaleString("en-US") }} km away
        </p>
      </div>

      <!-- Scrub the month -->
      <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between gap-3">
          <Label for="moon-scrub" class="text-xs text-muted-foreground">
            {{ monthLabel }}
          </Label>
          <span class="font-mono text-xs text-muted-foreground">
            {{ dateValue }} {{ clockValue }} {{ zone === "UTC" ? "UTC" : zone }}
          </span>
        </div>
        <div class="flex items-center gap-3">
          <Button
            v-if="!reducedMotion"
            variant="outline"
            size="icon-sm"
            class="shrink-0"
            :aria-label="playing ? 'Pause the month' : 'Play through the month'"
            @click="togglePlay"
          >
            <Pause v-if="playing" class="size-4" />
            <Play v-else class="size-4" />
          </Button>
          <Slider
            id="moon-scrub"
            :model-value="[scrub]"
            :min="0"
            :max="daysInMonth - SCRUB_STEP"
            :step="SCRUB_STEP"
            aria-label="Position in the month, in days"
            class="min-w-0 flex-1"
            @update:model-value="(v) => setScrub(Array.isArray(v) ? Number(v[0]) : 0)"
          />
        </div>
        <p v-if="reducedMotion" class="text-xs text-muted-foreground">
          Playback is off because your system asks for reduced motion. Drag the slider or pick a day
          below to step through the month.
        </p>
      </div>

      <!-- Every day of the month at a glance -->
      <ul class="flex flex-wrap justify-center gap-1.5">
        <li v-for="entry in monthStrip" :key="entry.day">
          <button
            type="button"
            class="flex w-9 flex-col items-center gap-0.5 rounded-[8px] p-1 transition-colors hover:bg-card"
            :class="entry.day === day ? 'bg-card ring-1 ring-[color:var(--ring)]' : ''"
            :aria-label="`${monthLabel} ${entry.day}, ${entry.name.toLowerCase()}, ${entry.percent.toFixed(0)} percent lit`"
            :aria-current="entry.day === day ? 'true' : undefined"
            @click="setScrub(entry.day - 1 + 0.5)"
          >
            <svg viewBox="0 0 32 32" class="size-6" aria-hidden="true" focusable="false">
              <circle cx="16" cy="16" r="14" fill="var(--moon-dark)" />
              <path v-if="entry.path" :d="entry.path" fill="var(--moon-lit)" />
              <circle
                cx="16"
                cy="16"
                r="14"
                fill="none"
                stroke="var(--moon-rim)"
                stroke-width="0.75"
              />
            </svg>
            <span class="font-mono text-[10px] text-muted-foreground">{{ entry.day }}</span>
          </button>
        </li>
      </ul>
      <p class="text-center text-xs text-muted-foreground">
        Each small disc is that day at noon. The shape is drawn from the illuminated fraction, so
        the terminator is where it really is.
      </p>
    </div>

    <ErrorBanner
      v-if="runError"
      :message="runError.message"
      :hint="runError.fix"
      title="That did not work"
    />

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
 * The disc is two flat fills and a hairline rim, one pair per theme. No text
 * sits on either fill, so the reading contrast on this panel is the page's own
 * foreground pair in both themes.
 */
.moon-disc {
  --moon-dark: #cfd4e4;
  --moon-lit: #f7f1de;
  --moon-rim: #a7aec6;
}

.dark .moon-disc {
  --moon-dark: #23273a;
  --moon-lit: #e8e2cd;
  --moon-rim: #4a5170;
}
</style>
