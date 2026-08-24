<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowLeftRight, ChevronDown, ChevronRight, LocateFixed } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  compassPoint,
  initialBearing,
  parsePoint,
  run,
  type LatLon,
} from "@/tools/distance-bearing-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText } from "@/lib/key-value";
import { flattenSelectOptions } from "@/lib/select-options";
import type { SegmentedOption } from "@/components/ui/segmented";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import KeyValueGrid from "../KeyValueGrid.vue";

/**
 * Bespoke panel for the Distance and Bearing Calculator.
 *
 * The generic shell hands this tool one textarea and asks the reader to know
 * that line one is point A and line two is point B. This panel gives each
 * point its own labeled field with live parse feedback, and turns the initial
 * bearing into a compass rose, because a heading is a direction before it is a
 * number.
 *
 * Every value still comes from the pure logic layer (PROJECT.md rule 27):
 * `parsePoint` validates a field, `initialBearing` aims the needle, and the
 * whole result table is the same `run()` the generic shell would call. The
 * headline distance is read back out of that table rather than recomputed,
 * so the big number and the row below it can never disagree.
 *
 * The two line paste box stays as a secondary path: a shared link, or anything
 * copied out of the old input, lands there with the fields filled from it.
 *
 * Nothing touches `window`, `history`, or `navigator` until `onMounted` or a
 * click handler, so the server rendered shell is inert. Location is read only
 * when the reader presses "Use my location", it lands in the visible field
 * first, and the URL is written from what the fields hold, never from the
 * position directly.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * options, read from the tool's own meta so the two never drift
 * ------------------------------------------------------------------ */

function selectSpec(id: string): SelectOptionSpec | null {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec !== undefined && spec.kind === "select" ? spec : null;
}

function booleanDefault(id: string, fallback: boolean): boolean {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec !== undefined && spec.kind === "boolean" ? spec.default : fallback;
}

const unitSpec = selectSpec("units");
const unitOptions: SegmentedOption[] = unitSpec ? flattenSelectOptions(unitSpec) : [];
const hasMagnetic = props.meta.options?.some((o) => o.id === "magnetic" && o.kind === "boolean");

const units = ref<string>(unitSpec?.default ?? "km");
const magnetic = ref<boolean>(booleanDefault("magnetic", true));

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const pointA = ref<string>("");
const pointB = ref<string>("");

const pasteOpen = ref<boolean>(false);
const pasteText = ref<string>("");
const pasteError = ref<string | null>(null);

const geoBusy = ref<string | null>(null);
const geoNote = ref<string | null>(null);

const output = ref<Record<string, string> | null>(null);
const runError = ref<{ message: string; fix?: string } | null>(null);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

interface FieldState {
  point: LatLon | null;
  error: string | null;
}

function describe(err: unknown): { message: string; fix?: string } {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : String(err) };
}

/**
 * An empty field is a tool waiting for input, not a mistake, so it reports
 * neither a point nor an error.
 */
function readField(text: string): FieldState {
  if (!text.trim()) return { point: null, error: null };
  try {
    return { point: parsePoint(text), error: null };
  } catch (err) {
    return { point: null, error: describe(err).message };
  }
}

const fieldA = computed<FieldState>(() => readField(pointA.value));
const fieldB = computed<FieldState>(() => readField(pointB.value));

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

function evaluate(): void {
  const a = fieldA.value.point;
  const b = fieldB.value.point;
  if (!a || !b) {
    output.value = null;
    runError.value = null;
    return;
  }
  try {
    output.value = run(`${pointA.value.trim()}\n${pointB.value.trim()}`, {
      units: units.value,
      magnetic: magnetic.value,
    });
    runError.value = null;
  } catch (err) {
    output.value = null;
    runError.value = describe(err);
  }
}

/**
 * The formatted rows split into a number and its unit, for the headline. The
 * distance rows read "5585.23 km", sometimes with a trailing note in
 * parentheses, while the bearing rows put the degree sign straight against the
 * number, so each shape gets its own reader.
 */
const NUMBER_AND_UNIT = /^(-?[\d.]+)\s+(\S+)/;
const LEADING_DEGREES = /^(-?[\d.]+)\s*°/;

const distance = computed<{ value: string; unit: string } | null>(() => {
  const out = output.value;
  if (!out) return null;
  const row = out["Distance (WGS84 ellipsoid)"] ?? out["Distance (sphere)"];
  const m = row ? NUMBER_AND_UNIT.exec(row) : null;
  return m ? { value: m[1], unit: m[2] } : null;
});

/** True bearing out of A, or null when the two points sit on top of each other. */
const bearing = computed<number | null>(() => {
  const a = fieldA.value.point;
  const b = fieldB.value.point;
  if (!a || !b) return null;
  if (a.lat === b.lat && a.lon === b.lon) return null;
  return initialBearing(a, b);
});

/** The magnetic heading to steer, lifted from the row the logic already built. */
const magneticBearing = computed<number | null>(() => {
  const row = output.value?.["Magnetic bearing to steer"];
  const m = row ? LEADING_DEGREES.exec(row) : null;
  return m ? Number(m[1]) : null;
});

const bearingLabel = computed<string>(() =>
  bearing.value === null
    ? "not defined"
    : `${bearing.value.toFixed(1)}° ${compassPoint(bearing.value)}`,
);

/* ------------------------------------------------------------------ *
 * compass rose geometry, in a 120 by 120 user space
 * ------------------------------------------------------------------ */

const ROSE_CENTER = 60;
const ROSE_RADIUS = 52;

/** Every 30 degrees, with the cardinal marks drawn longer. */
const roseTicks = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const deg = i * 30;
    const rad = ((deg - 90) * Math.PI) / 180;
    const cardinal = deg % 90 === 0;
    const inner = ROSE_RADIUS - (cardinal ? 9 : 5);
    return {
      deg,
      x1: ROSE_CENTER + Math.cos(rad) * ROSE_RADIUS,
      y1: ROSE_CENTER + Math.sin(rad) * ROSE_RADIUS,
      x2: ROSE_CENTER + Math.cos(rad) * inner,
      y2: ROSE_CENTER + Math.sin(rad) * inner,
      cardinal,
    };
  }),
);

/** The "copy everything" payload, spelled the same way the generic shell does. */
const allRowsText = computed<string>(() =>
  output.value ? rowsToText(recordToRows(output.value)) : "",
);

const roseTitle = computed<string>(() =>
  bearing.value === null
    ? "Compass rose. No bearing yet."
    : `Compass rose. Initial true bearing ${bearing.value.toFixed(1)} degrees, ${compassPoint(bearing.value)}.`,
);

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function swap(): void {
  const held = pointA.value;
  pointA.value = pointB.value;
  pointB.value = held;
}

function formatFix(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/**
 * Reads the device location once, on this click only, and writes it into the
 * visible field. The URL is written by the same debounced watcher that runs
 * while typing, so the reader sees the coordinates before they are shared.
 */
function useMyLocation(which: "a" | "b"): void {
  geoNote.value = null;
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    geoNote.value = "This browser offers no location API. Type the coordinates instead.";
    return;
  }
  geoBusy.value = which;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      geoBusy.value = null;
      const text = formatFix(position.coords.latitude, position.coords.longitude);
      if (which === "a") pointA.value = text;
      else pointB.value = text;
      geoNote.value = "Filled from your device. The position stays in this tab.";
    },
    (error) => {
      geoBusy.value = null;
      geoNote.value =
        error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. Type the coordinates instead."
          : error.code === error.TIMEOUT
            ? "The location request timed out. Try again, or type the coordinates."
            : "Your location is not available right now. Type the coordinates instead.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

/** Split a pasted block the way the logic splits its input: lines or semicolons. */
function splitPasted(raw: string): string[] {
  return raw
    .split(/[\r\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function applyPaste(): void {
  const lines = splitPasted(pasteText.value);
  if (lines.length < 2) {
    pasteError.value = "Paste two coordinates, one per line or separated by a semicolon.";
    return;
  }
  try {
    parsePoint(lines[0]);
    parsePoint(lines[1]);
  } catch (err) {
    pasteError.value = describe(err).message;
    return;
  }
  pointA.value = lines[0];
  pointB.value = lines[1];
  pasteError.value = null;
  pasteOpen.value = false;
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

function fragmentInput(): string | undefined {
  const a = pointA.value.trim();
  const b = pointB.value.trim();
  if (!a && !b) return undefined;
  return `${a}\n${b}`;
}

function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: fragmentInput(),
      opts: { units: units.value, magnetic: String(magnetic.value) },
    });
  }, 120);
}

watch([pointA, pointB, units, magnetic], schedule);

/**
 * Fill the fields from a shared link when it holds two readable points. A link
 * carrying anything else, such as the meta's `from ... bearing ... distance`
 * example, opens the paste box with its text instead of losing it.
 */
function restoreInput(raw: string): void {
  const lines = splitPasted(raw);
  if (lines.length >= 2) {
    try {
      parsePoint(lines[0]);
      parsePoint(lines[1]);
      pointA.value = lines[0];
      pointB.value = lines[1];
      return;
    } catch {
      // Falls through to the paste box below.
    }
  }
  pasteText.value = raw;
  pasteOpen.value = true;
}

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined && frag.input !== "") restoreInput(frag.input);
  if (frag.opts.units !== undefined) units.value = frag.opts.units;
  if (frag.opts.magnetic !== undefined) magnetic.value = frag.opts.magnetic === "true";
  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- The two points -->
    <div class="flex flex-col gap-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="db-point-a" class="text-xs text-muted-foreground">Point A</Label>
          <div class="flex gap-2">
            <Input
              id="db-point-a"
              :model-value="pointA"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="40.7128, -74.0060"
              class="h-9 min-w-0 flex-1 bg-secondary font-mono"
              :aria-invalid="fieldA.error !== null"
              @update:model-value="(v) => (pointA = String(v))"
            />
            <Button
              variant="outline"
              size="icon-sm"
              class="mt-0.5 shrink-0"
              aria-label="Use my location for point A"
              :disabled="geoBusy !== null"
              @click="useMyLocation('a')"
            >
              <LocateFixed class="size-4" />
            </Button>
          </div>
          <p v-if="fieldA.error" class="text-xs text-destructive">{{ fieldA.error }}</p>
          <p v-else-if="fieldA.point" class="font-mono text-xs text-muted-foreground">
            {{ fieldA.point.lat.toFixed(5) }}, {{ fieldA.point.lon.toFixed(5) }}
          </p>
        </div>

        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="db-point-b" class="text-xs text-muted-foreground">Point B</Label>
          <div class="flex gap-2">
            <Input
              id="db-point-b"
              :model-value="pointB"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="51.5074, -0.1278"
              class="h-9 min-w-0 flex-1 bg-secondary font-mono"
              :aria-invalid="fieldB.error !== null"
              @update:model-value="(v) => (pointB = String(v))"
            />
            <Button
              variant="outline"
              size="icon-sm"
              class="mt-0.5 shrink-0"
              aria-label="Use my location for point B"
              :disabled="geoBusy !== null"
              @click="useMyLocation('b')"
            >
              <LocateFixed class="size-4" />
            </Button>
          </div>
          <p v-if="fieldB.error" class="text-xs text-destructive">{{ fieldB.error }}</p>
          <p v-else-if="fieldB.point" class="font-mono text-xs text-muted-foreground">
            {{ fieldB.point.lat.toFixed(5) }}, {{ fieldB.point.lon.toFixed(5) }}
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" @click="swap">
          <ArrowLeftRight class="size-4" />
          Swap A and B
        </Button>
        <p class="text-xs text-muted-foreground">
          Decimal degrees, degrees and decimal minutes, or full degrees minutes seconds, with or
          without N, S, E and W.
        </p>
      </div>

      <p v-if="geoNote" role="status" class="text-xs text-muted-foreground">{{ geoNote }}</p>
    </div>

    <!-- Options -->
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div v-if="unitOptions.length" class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Distance unit</span>
        <Segmented
          :options="unitOptions"
          label="Distance unit"
          :model-value="units"
          @update:model-value="(v) => (units = v)"
        />
      </div>
      <div v-if="hasMagnetic" class="flex flex-col gap-1.5">
        <Label for="db-magnetic" class="w-fit cursor-pointer text-xs text-muted-foreground">
          Magnetic declination and bearing
        </Label>
        <Switch
          id="db-magnetic"
          :model-value="magnetic"
          @update:model-value="(v) => (magnetic = Boolean(v))"
        />
      </div>
    </div>

    <!-- Rose and headline -->
    <div
      class="flex flex-col items-center gap-5 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)] sm:flex-row sm:items-center"
      aria-live="polite"
    >
      <svg
        viewBox="0 0 120 120"
        class="size-[180px] shrink-0"
        role="img"
        :aria-label="roseTitle"
        focusable="false"
      >
        <circle
          :cx="ROSE_CENTER"
          :cy="ROSE_CENTER"
          :r="ROSE_RADIUS"
          fill="var(--card)"
          stroke="var(--border)"
        />
        <line
          v-for="tick in roseTicks"
          :key="tick.deg"
          :x1="tick.x1"
          :y1="tick.y1"
          :x2="tick.x2"
          :y2="tick.y2"
          :stroke="tick.cardinal ? 'var(--muted-foreground)' : 'var(--border)'"
          stroke-width="1"
        />
        <text x="60" y="14" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">
          N
        </text>
        <text x="60" y="114" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">
          S
        </text>
        <text x="8" y="64" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">
          W
        </text>
        <text x="112" y="64" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">
          E
        </text>

        <g v-if="magneticBearing !== null" :transform="`rotate(${magneticBearing} 60 60)`">
          <line
            x1="60"
            y1="60"
            x2="60"
            y2="18"
            stroke="var(--muted-foreground)"
            stroke-width="1.5"
            stroke-dasharray="3 3"
          />
        </g>
        <g v-if="bearing !== null" :transform="`rotate(${bearing} 60 60)`">
          <path d="M60 16 L67 60 L60 53 L53 60 Z" fill="var(--primary)" />
          <path d="M60 104 L67 60 L60 67 L53 60 Z" fill="var(--input)" />
        </g>
        <circle cx="60" cy="60" r="3" fill="var(--foreground)" />
      </svg>

      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <template v-if="distance">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs text-muted-foreground">Distance on the WGS84 ellipsoid</div>
              <div class="font-mono text-3xl leading-tight font-semibold tabular-nums">
                {{ distance.value }}
                <span class="text-lg font-normal text-muted-foreground">{{ distance.unit }}</span>
              </div>
            </div>
            <CopyButton :text="`${distance.value} ${distance.unit}`" label="Copy" />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <div class="text-xs text-muted-foreground">Initial bearing (true)</div>
              <div class="font-mono text-lg tabular-nums">{{ bearingLabel }}</div>
            </div>
            <div v-if="magneticBearing !== null">
              <div class="text-xs text-muted-foreground">Magnetic bearing to steer</div>
              <div class="font-mono text-lg tabular-nums">
                {{ magneticBearing.toFixed(1) }}&#176;
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="runError">
          <p class="text-sm font-medium text-destructive">{{ runError.message }}</p>
          <p v-if="runError.fix" class="text-sm text-muted-foreground">{{ runError.fix }}</p>
        </template>

        <template v-else>
          <p class="text-sm text-muted-foreground">
            Fill both points to see the distance, the bearing to steer, and the needle above. It
            updates as you type.
          </p>
        </template>
      </div>
    </div>

    <!-- Secondary path: the old two line input -->
    <div class="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        class="w-fit"
        :aria-expanded="pasteOpen"
        @click="pasteOpen = !pasteOpen"
      >
        <component :is="pasteOpen ? ChevronDown : ChevronRight" class="size-4" />
        Paste both points
      </Button>
      <div v-if="pasteOpen" class="flex flex-col gap-2">
        <Textarea
          :model-value="pasteText"
          rows="3"
          spellcheck="false"
          placeholder="40.7128, -74.0060&#10;51.5074, -0.1278"
          class="resize-y bg-secondary font-mono text-sm"
          aria-label="Paste both points"
          @update:model-value="(v) => (pasteText = String(v))"
        />
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" @click="applyPaste">Fill the fields</Button>
          <p v-if="pasteError" class="text-xs text-destructive">{{ pasteError }}</p>
          <p v-else class="text-xs text-muted-foreground">
            Two coordinates, one per line or separated by a semicolon.
          </p>
        </div>
      </div>
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
