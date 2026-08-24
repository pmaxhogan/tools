<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { run } from "@/tools/photography-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the photography calculators.
 *
 * The generic shell gives this tool one text box, so a photographer has to
 * remember that "50mm f/2.8 3m" means depth of field while "1/125 ND1000"
 * means a long exposure. This panel gives each calculation the fields it
 * actually has, and draws depth of field as a distance bar instead of leaving
 * the near and far limits as two numbers in a list.
 *
 * ALL MATH STILL COMES FROM run() (PROJECT.md rule 27). The panel only
 * composes the tool's own text syntax out of the fields and renders what comes
 * back, so the page, the curl endpoint, and a shared link cannot drift.
 *
 * TWO INPUT SOURCES
 * -----------------
 * `source` says which one is live. "fields" composes a key=value line from the
 * controls. "typed" sends the free text box straight through, which is how a
 * link shared from the old generic shell still works. While the typed line is
 * live the fields follow it, filled from the result's own echo rows ("Setup",
 * "Sensor", "Aperture", ...) rather than from a second copy of the parser,
 * which would be exactly the duplicated logic rule 27 exists to prevent.
 * Touching any field switches back to "fields" without clearing the box.
 *
 * Every browser read happens in onMounted or a handler, so the server rendered
 * shell never touches window or history.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * option specs
 * ------------------------------------------------------------------ */

function selectSpec(id: string): SelectOptionSpec | null {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec && spec.kind === "select" ? spec : null;
}

const modeSpec = computed(() => selectSpec("mode"));
const sensorSpec = computed(() => selectSpec("sensor"));

/**
 * The meta labels spell each calculation out in full ("Exposure value and
 * equivalents") because a dropdown has room for that. A segmented row does
 * not, so the leading phrase is used and the rest is dropped. Derived from
 * meta rather than retyped, so renaming a mode there renames it here too.
 */
function shortLabel(label: string): string {
  return label.split(" and ")[0];
}

const modeOptions = computed<SegmentedOption[]>(() =>
  (modeSpec.value?.options ?? []).map((o) => ({ value: o.value, label: shortLabel(o.label) })),
);

/** Aperture is a select rather than a number box: f-stops are a known series. */
const APERTURE_STOPS = [
  "1",
  "1.2",
  "1.4",
  "1.8",
  "2",
  "2.8",
  "3.5",
  "4",
  "5.6",
  "6.3",
  "8",
  "11",
  "16",
  "22",
  "32",
];

const APERTURE_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "photo-aperture",
  label: "Aperture",
  default: "2.8",
  options: APERTURE_STOPS.map((v) => ({
    value: v,
    label: `f/${v}`,
    synonyms: [`f${v}`, `f/${v}`, v],
  })),
};

/**
 * ND filters carry their marketed factor, which is what the tool's parser
 * reads and what the answer is computed from: ND1000 blocks a factor of 1000,
 * not the 1024 of a true ten stop filter. The stop count is deliberately not
 * repeated here, because the result grid prints the logic layer's own.
 */
const ND_FACTORS = [2, 4, 8, 16, 32, 64, 128, 256, 400, 1000, 100000];

const ND_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "photo-nd",
  label: "ND filter",
  default: "ND1000",
  options: ND_FACTORS.map((f) => ({
    value: `ND${f}`,
    label: `ND${f}`,
    synonyms: [`${f}x`, `nd ${f}`, "neutral density", "long exposure"],
  })),
};

const UNIT_OPTIONS: SegmentedOption[] = [
  { value: "m", label: "m" },
  { value: "ft", label: "ft" },
];

/** Which of the four exposure quantities the calculator works out for you. */
const SOLVE_OPTIONS: SegmentedOption[] = [
  { value: "ev", label: "Exposure value" },
  { value: "aperture", label: "Aperture" },
  { value: "shutter", label: "Shutter" },
  { value: "iso", label: "ISO" },
];

const ORIENTATION_OPTIONS: SegmentedOption[] = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
];

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

/**
 * One reactive bag rather than a ref per field: a template unwraps a ref to
 * its value, so a shared `setField(ref, value)` helper would receive a string
 * and silently write nothing. Keying the bag keeps one setter for every
 * control, which is what marks the fields as the live input source.
 */
const fields = reactive({
  mode: modeSpec.value?.default ?? "dof",
  sensor: sensorSpec.value?.default ?? "full-frame",
  focal: "50",
  aperture: "2.8",
  distance: "3",
  distanceUnit: "m",
  shutter: "1/125",
  iso: "100",
  ev: "15",
  nd: "ND1000",
  solveFor: "ev",
  orientation: "landscape",
  sensorWidth: "",
  sensorHeight: "",
});

type FieldKey = keyof typeof fields;

const typed = ref("");
const typedOpen = ref(false);
const source = ref<"fields" | "typed">("fields");

const output = ref<Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

const needsSensor = computed(() => fields.mode !== "exposure" && fields.mode !== "nd");
const isCustomSensor = computed(() => needsSensor.value && fields.sensor === "custom");
const showFocal = computed(() => fields.mode !== "exposure" && fields.mode !== "nd");
const showAperture = computed(
  () =>
    fields.mode === "dof" ||
    fields.mode === "hyperfocal" ||
    (fields.mode === "exposure" && fields.solveFor !== "aperture"),
);
const showShutter = computed(
  () => fields.mode === "nd" || (fields.mode === "exposure" && fields.solveFor !== "shutter"),
);

/* ------------------------------------------------------------------ *
 * composing the tool's own text syntax
 * ------------------------------------------------------------------ */

/**
 * One `key=value` token, or null when the field is blank. Spaces are stripped
 * so a token never splits in two: the tool tokenizes on whitespace, and an
 * empty value ("focal=") is a parse error rather than an omission.
 */
function token(key: string, value: string): string | null {
  const v = value.replace(/\s+/g, "");
  return v === "" ? null : `${key}=${v}`;
}

const composed = computed<string>(() => {
  const parts: (string | null)[] = [];

  switch (fields.mode) {
    case "hyperfocal":
      parts.push(token("focal", fields.focal), token("aperture", fields.aperture));
      // Hyperfocal takes no subject distance, but the answer is still printed
      // in whichever unit system the input used, and only a distance token can
      // say which that is. runHyperfocal never reads the value, so this token
      // is a unit switch and nothing else.
      if (fields.distanceUnit === "ft") parts.push("distance=1ft");
      break;
    case "exposure":
      if (fields.solveFor !== "ev") parts.push(token("ev", fields.ev));
      if (fields.solveFor !== "aperture") parts.push(token("aperture", fields.aperture));
      if (fields.solveFor !== "shutter") parts.push(token("shutter", fields.shutter));
      if (fields.solveFor !== "iso") parts.push(token("iso", fields.iso));
      break;
    case "nd":
      parts.push(token("shutter", fields.shutter), token("nd", fields.nd));
      break;
    case "fov":
      parts.push(token("focal", fields.focal));
      break;
    default:
      parts.push(token("focal", fields.focal), token("aperture", fields.aperture));
      if (fields.distance.trim() !== "") {
        parts.push(token("distance", `${fields.distance}${fields.distanceUnit}`));
      }
  }

  if (isCustomSensor.value) {
    parts.push(
      token("sensorWidth", fields.sensorWidth),
      token("sensorHeight", fields.sensorHeight),
    );
  }

  return parts.filter((p): p is string => p !== null).join(" ");
});

const activeInput = computed(() => (source.value === "typed" ? typed.value : composed.value));

/* ------------------------------------------------------------------ *
 * reading the answer back into the fields
 * ------------------------------------------------------------------ */

/** "3.00 m", "9.84 ft". Returns null for "infinity" and anything unexpected. */
function readDistance(raw: string | undefined): { value: number; unit: string } | null {
  const m = raw?.match(/^(\d*\.?\d+)\s*(m|ft)$/);
  return m ? { value: Number(m[1]), unit: m[2] } : null;
}

/** "1/125 s", "2 s", "90 s (1 min 30 s)" back to something the parser reads. */
function readShutter(raw: string | undefined): string | null {
  const m = raw?.match(/^([\d./]+)\s*s\b/);
  return m ? m[1] : null;
}

/** Every mode prints a row no other mode prints, which is what names it. */
const MODE_MARKERS: { key: string; mode: string }[] = [
  { key: "Total depth of field", mode: "dof" },
  { key: "Near limit at hyperfocal focus", mode: "hyperfocal" },
  { key: "EV at ISO 100", mode: "exposure" },
  { key: "Base shutter", mode: "nd" },
  { key: "Crop factor", mode: "fov" },
];

/**
 * Fills the fields from a result. Only the tool's own echo rows are read, so
 * what the fields show is what the calculator understood, down to the sensor
 * label and the unit system.
 */
function syncFromResult(result: Record<string, string>): void {
  const marker = MODE_MARKERS.find((m) => m.key in result);
  if (marker) fields.mode = marker.mode;

  const sensorOption = sensorSpec.value?.options?.find((o) => o.label === result.Sensor);
  if (sensorOption) fields.sensor = sensorOption.value;

  const setup = result.Setup ?? "";
  const setupFocal = setup.match(/^(\d*\.?\d+)\s*mm/);
  if (setupFocal) fields.focal = setupFocal[1];
  const setupAperture = setup.match(/at f\/(\d*\.?\d+)/);
  if (setupAperture) fields.aperture = setupAperture[1];

  const focused = readDistance(setup.match(/focused at (.+)$/)?.[1]);
  if (focused) {
    fields.distance = String(focused.value);
    fields.distanceUnit = focused.unit;
  } else {
    const hyperfocal = readDistance(result["Hyperfocal distance"]);
    if (hyperfocal) fields.distanceUnit = hyperfocal.unit;
  }

  const shot = readShutter(result.Shutter ?? result["Base shutter"]);
  if (shot) fields.shutter = shot;

  const shotAperture = result.Aperture?.match(/^f\/(\d*\.?\d+)$/);
  if (shotAperture) fields.aperture = shotAperture[1];

  const shotIso = result.ISO?.match(/^ISO\s*(\d*\.?\d+)$/);
  if (shotIso) fields.iso = shotIso[1];

  const nd = result["ND filter"]?.match(/^(ND\d+)/);
  if (nd && ND_SPEC.options?.some((o) => o.value === nd[1])) fields.nd = nd[1];
}

/* ------------------------------------------------------------------ *
 * running
 * ------------------------------------------------------------------ */

function evaluate(): void {
  const input = activeInput.value.trim();
  if (!input) {
    output.value = null;
    error.value = null;
    return;
  }
  try {
    const result = run(input, { mode: fields.mode, sensor: fields.sensor });
    output.value = result;
    error.value = null;
    // The typed line is the authority while it is live, so the fields follow
    // it. Writing them schedules this same run again with identical values,
    // which settles on the second pass rather than looping.
    if (source.value === "typed") syncFromResult(result);
  } catch (e) {
    output.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

/** Panel only choices ride along in the fragment so a shared link restores them. */
function panelOpts(): Record<string, string> {
  const opts: Record<string, string> = { mode: fields.mode, sensor: fields.sensor };
  if (fields.distanceUnit !== "m") opts.unit = fields.distanceUnit;
  if (fields.solveFor !== "ev") opts.solve = fields.solveFor;
  if (fields.orientation !== "landscape") opts.orient = fields.orientation;
  return opts;
}

function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({ input: activeInput.value || undefined, opts: panelOpts() });
  }, 120);
}

/**
 * Every control routes through here: setting a field is also what says the
 * fields, not the typed line, are the live input. A watcher could not tell the
 * two apart, because filling the fields from a result writes them too.
 */
function setField(key: FieldKey, value: string): void {
  fields[key] = value;
  source.value = "fields";
  schedule();
}

function setTyped(value: string): void {
  typed.value = value;
  source.value = "typed";
  schedule();
}

/* ------------------------------------------------------------------ *
 * the depth of field bar
 * ------------------------------------------------------------------ */

interface DofBar {
  nearPct: number;
  farPct: number;
  subjectPct: number | null;
  hyperPct: number | null;
  nearLabel: string;
  farLabel: string;
  subjectLabel: string | null;
  hyperLabel: string | null;
  loLabel: string;
  hiLabel: string;
  summary: string;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/**
 * Distances run over orders of magnitude (a near limit of 2.7 m against a
 * hyperfocal of 30 m), so the bar is logarithmic: every doubling takes the
 * same width, which is the only scale on which a shallow depth of field is
 * still visible next to the horizon. Every label on it is a string the logic
 * layer formatted, so the bar and the grid always agree.
 */
const dofBar = computed<DofBar | null>(() => {
  const out = output.value;
  if (!out) return null;

  const isDof = "Near limit" in out;
  const nearRaw = isDof ? out["Near limit"] : out["Near limit at hyperfocal focus"];
  const farRaw = isDof ? out["Far limit"] : out["Far limit at hyperfocal focus"];
  const near = readDistance(nearRaw);
  const hyper = readDistance(out["Hyperfocal distance"]);
  if (!near || !hyper || near.value <= 0) return null;

  // "infinity" is what the logic layer prints past the hyperfocal distance,
  // and it is the whole of the far limit in hyperfocal mode.
  const far = readDistance(farRaw);
  const subject = isDof ? readDistance(out.Setup?.match(/focused at (.+)$/)?.[1]) : null;

  const lo = near.value * 0.4;
  const hi = (far ? Math.max(far.value, hyper.value) : Math.max(hyper.value, near.value * 4)) * 1.6;
  if (!(hi > lo)) return null;

  const span = Math.log(hi) - Math.log(lo);
  const pct = (v: number): number => clampPct(((Math.log(v) - Math.log(lo)) / span) * 100);
  const nearPct = pct(near.value);

  return {
    nearPct,
    farPct: far ? pct(far.value) : 100,
    subjectPct: subject ? pct(subject.value) : null,
    hyperPct: isDof ? pct(hyper.value) : null,
    nearLabel: nearRaw ?? "",
    farLabel: farRaw ?? "infinity",
    subjectLabel: subject ? `${subject.value.toFixed(2)} ${subject.unit}` : null,
    hyperLabel: isDof ? (out["Hyperfocal distance"] ?? null) : null,
    loLabel: `${lo.toFixed(2)} ${near.unit}`,
    hiLabel: far ? `${hi.toFixed(2)} ${near.unit}` : "∞",
    summary: `In focus from ${nearRaw} to ${farRaw ?? "infinity"}.`,
  };
});

/** The one number worth setting in large type, per calculation. */
const HEADLINE_KEYS: Record<string, string> = {
  dof: "Total depth of field",
  hyperfocal: "Hyperfocal distance",
  exposure: "EV at ISO 100",
  nd: "New shutter",
  fov: "Diagonal angle of view",
};

const headline = computed<{ label: string; value: string } | null>(() => {
  const out = output.value;
  const key = HEADLINE_KEYS[fields.mode];
  if (!out || !key || !(key in out)) return null;
  return { label: key, value: out[key] };
});

/**
 * Field of view is computed from the sensor's width and height, which are the
 * long and short edges of a landscape frame. Turning the camera on its side
 * swaps which one is horizontal, so the panel swaps the two labels rather than
 * feeding the calculator a rotated sensor: the angles themselves are identical
 * either way, and the numbers stay the tool's own.
 */
const rows = computed<Record<string, string> | null>(() => {
  const out = output.value;
  if (!out) return null;
  if (fields.mode !== "fov" || fields.orientation !== "portrait") return out;

  const swapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(out)) {
    if (key === "Horizontal angle of view") swapped["Vertical angle of view"] = value;
    else if (key === "Vertical angle of view") swapped["Horizontal angle of view"] = value;
    else if (key.startsWith("Frame width at")) swapped[key.replace("width", "height")] = value;
    else if (key.startsWith("Frame height at")) swapped[key.replace("height", "width")] = value;
    else swapped[key] = value;
  }
  return swapped;
});

const typedNote = computed(() =>
  source.value === "typed" && typed.value.trim()
    ? "This line is running now. The fields above show what the calculator read from it."
    : "Write it the way you would say it out loud. The fields above fill in from what the calculator reads.",
);

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

/** A fragment value is only honored when the spec actually offers it. */
function pickOption(spec: SelectOptionSpec | null, raw: string | undefined): string | null {
  if (!raw || !spec?.options) return null;
  return spec.options.some((o) => o.value === raw) ? raw : null;
}

function pickSegment(options: SegmentedOption[], raw: string | undefined): string | null {
  if (!raw) return null;
  return options.some((o) => o.value === raw) ? raw : null;
}

onMounted(() => {
  const frag = readFragment();

  fields.mode = pickOption(modeSpec.value, frag.opts.mode) ?? fields.mode;
  fields.sensor = pickOption(sensorSpec.value, frag.opts.sensor) ?? fields.sensor;
  fields.distanceUnit = pickSegment(UNIT_OPTIONS, frag.opts.unit) ?? fields.distanceUnit;
  fields.solveFor = pickSegment(SOLVE_OPTIONS, frag.opts.solve) ?? fields.solveFor;
  fields.orientation = pickSegment(ORIENTATION_OPTIONS, frag.opts.orient) ?? fields.orientation;

  // A shared link carries the free text shorthand, so it becomes the live
  // input and the box holding it opens, the way the generic shell does it.
  if (frag.input) {
    typed.value = frag.input;
    source.value = "typed";
    typedOpen.value = true;
  }

  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{ modeSpec?.label ?? "Calculation" }}
      </span>
      <Segmented
        :model-value="fields.mode"
        :options="modeOptions"
        :label="modeSpec?.label ?? 'Calculation'"
        @update:model-value="(v: string) => setField('mode', v)"
      />
    </div>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div v-if="showFocal" class="flex min-w-0 flex-col gap-1.5">
        <Label for="photo-focal" class="text-xs text-muted-foreground">Focal length (mm)</Label>
        <Input
          id="photo-focal"
          :model-value="fields.focal"
          type="number"
          inputmode="decimal"
          min="1"
          step="1"
          placeholder="50"
          class="h-8"
          @update:model-value="(v) => setField('focal', String(v))"
        />
      </div>

      <div v-if="showAperture" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="APERTURE_SPEC"
          :model-value="fields.aperture"
          @update:model-value="(v: unknown) => setField('aperture', String(v))"
        />
      </div>

      <div v-if="fields.mode === 'dof'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="photo-distance" class="text-xs text-muted-foreground">Subject distance</Label>
        <div class="flex items-center gap-2">
          <Input
            id="photo-distance"
            :model-value="fields.distance"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.1"
            placeholder="3"
            class="h-8 min-w-0 flex-1"
            @update:model-value="(v) => setField('distance', String(v))"
          />
          <Segmented
            :model-value="fields.distanceUnit"
            :options="UNIT_OPTIONS"
            label="Distance unit"
            size="sm"
            @update:model-value="(v: string) => setField('distanceUnit', v)"
          />
        </div>
      </div>

      <div v-if="fields.mode === 'hyperfocal'" class="flex min-w-0 flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Distances in</span>
        <Segmented
          :model-value="fields.distanceUnit"
          :options="UNIT_OPTIONS"
          label="Distances in"
          @update:model-value="(v: string) => setField('distanceUnit', v)"
        />
      </div>

      <div v-if="fields.mode === 'exposure'" class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
        <span class="text-xs text-muted-foreground">Solve for</span>
        <Segmented
          :model-value="fields.solveFor"
          :options="SOLVE_OPTIONS"
          label="Solve for"
          @update:model-value="(v: string) => setField('solveFor', v)"
        />
      </div>

      <div v-if="showShutter" class="flex min-w-0 flex-col gap-1.5">
        <Label for="photo-shutter" class="text-xs text-muted-foreground">
          {{ fields.mode === "nd" ? "Base shutter" : "Shutter" }}
        </Label>
        <Input
          id="photo-shutter"
          :model-value="fields.shutter"
          type="text"
          inputmode="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="1/125"
          class="h-8 font-mono"
          @update:model-value="(v) => setField('shutter', String(v))"
        />
      </div>

      <div
        v-if="fields.mode === 'exposure' && fields.solveFor !== 'iso'"
        class="flex min-w-0 flex-col gap-1.5"
      >
        <Label for="photo-iso" class="text-xs text-muted-foreground">ISO</Label>
        <Input
          id="photo-iso"
          :model-value="fields.iso"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          placeholder="100"
          class="h-8"
          @update:model-value="(v) => setField('iso', String(v))"
        />
      </div>

      <div
        v-if="fields.mode === 'exposure' && fields.solveFor !== 'ev'"
        class="flex min-w-0 flex-col gap-1.5"
      >
        <Label for="photo-ev" class="text-xs text-muted-foreground">Exposure value (ISO 100)</Label>
        <Input
          id="photo-ev"
          :model-value="fields.ev"
          type="number"
          inputmode="decimal"
          step="0.5"
          placeholder="15"
          class="h-8"
          @update:model-value="(v) => setField('ev', String(v))"
        />
      </div>

      <div v-if="fields.mode === 'nd'" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="ND_SPEC"
          :model-value="fields.nd"
          @update:model-value="(v: unknown) => setField('nd', String(v))"
        />
      </div>

      <div v-if="fields.mode === 'fov'" class="flex min-w-0 flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Orientation</span>
        <Segmented
          :model-value="fields.orientation"
          :options="ORIENTATION_OPTIONS"
          label="Orientation"
          @update:model-value="(v: string) => setField('orientation', v)"
        />
      </div>

      <div v-if="needsSensor && sensorSpec" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="sensorSpec"
          :model-value="fields.sensor"
          @update:model-value="(v: unknown) => setField('sensor', String(v))"
        />
      </div>

      <template v-if="isCustomSensor">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="photo-sensor-w" class="text-xs text-muted-foreground">
            Sensor width (mm)
          </Label>
          <Input
            id="photo-sensor-w"
            :model-value="fields.sensorWidth"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.1"
            placeholder="36"
            class="h-8"
            @update:model-value="(v) => setField('sensorWidth', String(v))"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="photo-sensor-h" class="text-xs text-muted-foreground">
            Sensor height (mm)
          </Label>
          <Input
            id="photo-sensor-h"
            :model-value="fields.sensorHeight"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.1"
            placeholder="24"
            class="h-8"
            @update:model-value="(v) => setField('sensorHeight', String(v))"
          />
        </div>
      </template>
    </div>

    <div
      v-if="dofBar"
      class="flex flex-col gap-2"
      role="img"
      :aria-label="`Distance bar. ${dofBar.summary}`"
    >
      <div class="relative h-6 overflow-hidden rounded-[6px] bg-secondary shadow-[var(--sh-inset)]">
        <span
          class="absolute inset-y-0 rounded-[6px] bg-[image:var(--grad-brand)] opacity-90"
          :style="{ left: `${dofBar.nearPct}%`, width: `${dofBar.farPct - dofBar.nearPct}%` }"
        />
        <span
          v-if="dofBar.hyperPct !== null"
          class="absolute inset-y-0 border-l border-dashed border-foreground/60"
          :style="{ left: `${dofBar.hyperPct}%` }"
        />
        <span
          v-if="dofBar.subjectPct !== null"
          class="absolute inset-y-0 w-px bg-foreground"
          :style="{ left: `${dofBar.subjectPct}%` }"
        />
      </div>

      <div class="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>{{ dofBar.loLabel }}</span>
        <span>{{ dofBar.hiLabel }}</span>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span class="flex items-center gap-1.5">
          <span class="h-2 w-4 rounded-[2px] bg-[image:var(--grad-brand)]" />
          In focus {{ dofBar.nearLabel }} to {{ dofBar.farLabel }}
        </span>
        <span v-if="dofBar.subjectLabel" class="flex items-center gap-1.5">
          <span class="h-3 w-px bg-foreground" />
          Subject {{ dofBar.subjectLabel }}
        </span>
        <span v-if="dofBar.hyperLabel" class="flex items-center gap-1.5">
          <span class="h-3 border-l border-dashed border-foreground/60" />
          Hyperfocal {{ dofBar.hyperLabel }}
        </span>
      </div>
    </div>

    <div
      v-if="headline"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary px-4 py-3 shadow-[var(--sh-inset)]"
      aria-live="polite"
    >
      <span class="text-xs text-muted-foreground">{{ headline.label }}</span>
      <span class="font-mono text-2xl leading-tight font-semibold tabular-nums">
        {{ headline.value }}
      </span>
    </div>

    <div
      v-else-if="error"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-sm font-medium text-destructive">{{ error.message }}</span>
      <span v-if="error.fix" class="text-sm text-muted-foreground">{{ error.fix }}</span>
    </div>

    <p v-else class="text-sm text-muted-foreground">
      Fill in the fields above to see the numbers here.
    </p>

    <KeyValueGrid v-if="rows" :record="rows" />

    <div class="flex flex-col gap-2">
      <div>
        <Button
          variant="ghost"
          size="sm"
          class="-ml-2.5 text-muted-foreground"
          :aria-expanded="typedOpen"
          aria-controls="photo-typed"
          @click="typedOpen = !typedOpen"
        >
          <ChevronRight
            class="size-4 transition-transform duration-150 motion-reduce:transition-none"
            :class="typedOpen ? 'rotate-90' : ''"
          />
          Type it
        </Button>
      </div>

      <div
        v-show="typedOpen"
        id="photo-typed"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <Input
          :model-value="typed"
          type="text"
          inputmode="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="50mm f/2.8 3m"
          aria-label="Type the calculation"
          class="h-9 border-0 bg-card font-mono"
          @update:model-value="(v) => setTyped(String(v))"
        />
        <p class="text-xs text-muted-foreground">{{ typedNote }}</p>
      </div>
    </div>
  </div>
</template>
