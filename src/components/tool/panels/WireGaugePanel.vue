<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { run } from "@/tools/wire-gauge-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText } from "@/lib/key-value";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import CopyButton from "../CopyButton.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Wire Gauge Calculator.
 *
 * The generic shell gives this tool one text box, so a reader has to already
 * know that "20A 30m 12awg 120V" is the shape voltage-drop mode wants. This
 * panel gives each calculation labeled fields instead: an AWG picker for
 * lookup, and current/length/voltage/material for the two circuit modes.
 *
 * ALL MATH STILL COMES FROM run() (PROJECT.md rule 27). The panel only
 * composes the tool's own key=value text syntax out of the fields (see
 * `composed`) and renders whatever comes back, so the page, the curl
 * endpoint, and a shared link can never drift from the pure logic layer. The
 * reference table below is not a retyped copy of the AWG constants either:
 * every row is `run()` called once per common gauge in lookup mode.
 *
 * TWO INPUT SOURCES
 * -----------------
 * `source` says which one is live. "fields" composes the text line from the
 * controls. "typed" sends the free text box straight through, which is how a
 * link shared from the old generic shell still works. The tool's own results
 * do not echo current, voltage, or length back (only the gauge and the
 * material), so while typed is live those three fields simply keep whatever
 * they last held rather than guessing; gauge and material do follow the
 * typed line, read from the result's own "Wire"/"Gauge" and "Material" rows.
 * Touching any field switches back to "fields" without clearing the box.
 *
 * Every browser read happens in onMounted or a handler, so the server
 * rendered shell never touches window or history.
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

const modeOptions = computed<SegmentedOption[]>(() =>
  (modeSpec.value?.options ?? []).map((o) => ({ value: o.value, label: o.label })),
);

/** "4/0", "3/0", "2/0", "1/0" for the ought sizes; every other AWG token is its own label. */
const OUGHT_LABELS: Record<string, string> = {
  "0000": "4/0",
  "000": "3/0",
  "00": "2/0",
  "0": "1/0",
};

function gaugeDisplayLabel(value: string): string {
  return `${OUGHT_LABELS[value] ?? value} AWG`;
}

/** Every raw AWG token the tool's own parser accepts: the four ought sizes, then 1 to 40. */
const GAUGE_TOKENS: string[] = [
  "0000",
  "000",
  "00",
  "0",
  ...Array.from({ length: 40 }, (_, i) => String(i + 1)),
];

function gaugeSynonyms(value: string): string[] {
  const ought = OUGHT_LABELS[value];
  const base = [value, `${value}awg`, `#${value}`, `${value}ga`, `${value} gauge`];
  return ought ? [...base, ought, `${ought} awg`, `${ought} gauge`] : base;
}

/**
 * A locally built select spec, the same way the photography panel builds one
 * for aperture and ND stops: the tool's own logic has no need of an option
 * list this granular, so the panel owns it rather than pushing UI concerns
 * into meta.ts. Every value here is a raw token `run()` already accepts bare,
 * so composing the text line never needs to reshape it.
 */
const GAUGE_SPEC: SelectOptionSpec = {
  kind: "select",
  id: "wire-gauge",
  label: "Gauge",
  default: "12",
  options: GAUGE_TOKENS.map((value) => ({
    value,
    label: gaugeDisplayLabel(value),
    synonyms: gaugeSynonyms(value),
  })),
};

const MATERIAL_OPTIONS: SegmentedOption[] = [
  { value: "copper", label: "Copper" },
  { value: "aluminum", label: "Aluminum" },
];

const UNIT_OPTIONS: SegmentedOption[] = [
  { value: "m", label: "m" },
  { value: "ft", label: "ft" },
];

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const fields = reactive({
  mode: modeSpec.value?.default ?? "lookup",
  gauge: GAUGE_SPEC.default,
  amps: "15",
  volts: "120",
  length: "25",
  lengthUnit: "m",
  material: "copper",
  maxDropPct: "3",
});

type FieldKey = keyof typeof fields;

const typed = ref("");
const typedOpen = ref(false);
const refOpen = ref(false);
const source = ref<"fields" | "typed">("fields");

interface PanelError {
  message: string;
  fix?: string;
}

const output = ref<Record<string, string> | null>(null);
const error = ref<PanelError | null>(null);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

function describe(err: unknown): PanelError {
  return err instanceof ToolError
    ? { message: err.message, fix: err.fix }
    : { message: err instanceof Error ? err.message : String(err) };
}

/* ------------------------------------------------------------------ *
 * composing the tool's own text syntax
 * ------------------------------------------------------------------ */

/**
 * One `key=value` token, or null when the field is blank. Spaces are
 * stripped so a token never splits in two: the tool tokenizes on whitespace,
 * and an empty value ("current=") is a parse error rather than an omission.
 */
function token(key: string, value: string): string | null {
  const v = value.replace(/\s+/g, "");
  return v === "" ? null : `${key}=${v}`;
}

/** Length carries its unit glued on, so it needs its own blank check. */
function lengthToken(): string | null {
  const v = fields.length.replace(/\s+/g, "");
  return v === "" ? null : `length=${v}${fields.lengthUnit}`;
}

const composed = computed<string>(() => {
  if (fields.mode === "lookup") return fields.gauge;

  const parts: (string | null)[] = [
    token("current", fields.amps),
    lengthToken(),
    token("voltage", fields.volts),
    token("material", fields.material),
  ];
  if (fields.mode === "voltage-drop") parts.push(token("gauge", fields.gauge));
  if (fields.mode === "size-for") parts.push(token("maxdrop", fields.maxDropPct));

  return parts.filter((p): p is string => p !== null).join(" ");
});

const activeInput = computed(() => (source.value === "typed" ? typed.value : composed.value));

/* ------------------------------------------------------------------ *
 * reading the answer back into the fields
 * ------------------------------------------------------------------ */

/**
 * Fills what can honestly be recovered from a result while the typed line is
 * live: the gauge (from voltage-drop's "Wire" row or lookup's "Gauge" row,
 * when it is an AWG size rather than a metric one) and the material. Current,
 * voltage, and length are never echoed by any mode's output, so they are left
 * exactly as the fields last held them.
 */
function syncFromResult(result: Record<string, string>): void {
  const gaugeText = result["Wire"] ?? result["Gauge"];
  const m = gaugeText?.match(/^(\S+)\s+AWG$/);
  if (m) {
    const raw = m[1];
    const found = Object.entries(OUGHT_LABELS).find(([, label]) => label === raw);
    const value = found ? found[0] : raw;
    if (GAUGE_TOKENS.includes(value)) fields.gauge = value;
  }

  const material = result["Material"];
  if (material === "copper" || material === "aluminum") fields.material = material;
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
    const result = run(input, { mode: fields.mode });
    output.value = result;
    error.value = null;
    // The typed line is the authority while it is live, so the fields follow
    // it as far as the result lets them.
    if (source.value === "typed") syncFromResult(result);
  } catch (e) {
    output.value = null;
    error.value = describe(e);
  }
}

/** Panel only choices ride along in the fragment so a shared link restores them. */
function panelOpts(): Record<string, string> {
  const opts: Record<string, string> = { mode: fields.mode, gauge: fields.gauge };
  if (fields.mode !== "lookup") {
    opts.amps = fields.amps;
    opts.volts = fields.volts;
    opts.length = fields.length;
    opts.unit = fields.lengthUnit;
    opts.material = fields.material;
  }
  if (fields.mode === "size-for") opts.maxdrop = fields.maxDropPct;
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
 * fields, not the typed line, are the live input.
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
 * headline: the one number worth setting in large type, per mode
 * ------------------------------------------------------------------ */

interface Headline {
  label: string;
  value: string;
  sub?: string;
}

const headline = computed<Headline | null>(() => {
  const out = output.value;
  if (!out) return null;

  if (fields.mode === "voltage-drop" && "Voltage drop" in out) {
    return {
      label: "Voltage drop",
      value: `${out["Voltage drop"]} (${out["Percent drop"]})`,
      sub: out["Verdict"],
    };
  }

  if (fields.mode === "size-for" && "Recommended gauge" in out) {
    return {
      label: "Recommended gauge",
      value: out["Recommended gauge"],
      sub: [out["Ampacity constraint"], out["Voltage drop constraint"]].filter(Boolean).join(" "),
    };
  }

  return null;
});

const allRowsText = computed<string>(() =>
  output.value ? rowsToText(recordToRows(output.value)) : "",
);

/* ------------------------------------------------------------------ *
 * reference table: every row is the tool's own lookup, never a retyped
 * constant (PROJECT.md rule 27)
 * ------------------------------------------------------------------ */

/** Common sizes with full ampacity coverage: NEC 310.16 (14 to 4/0) plus the chassis table (16 to 30). */
const REFERENCE_GAUGES = [
  "0000",
  "000",
  "00",
  "0",
  "1",
  "2",
  "3",
  "4",
  "6",
  "8",
  "10",
  "12",
  "14",
  "16",
  "18",
  "20",
  "22",
  "24",
  "26",
  "28",
  "30",
];

interface ReferenceRow {
  gauge: string;
  diameter: string;
  area: string;
  resistance: string;
  ampacity: string;
}

/** The single ampacity figure the table shows: the NEC 60C column, or the chassis open-air figure below 14 AWG. */
function firstAmpacity(out: Record<string, string>): string {
  const nec = out["Ampacity, NEC 310.16 copper (60C / 75C / 90C)"];
  if (nec) return nec.split(" / ")[0];
  const chassis = out["Chassis wiring reference (hobbyist, not code)"];
  const chassisMatch = chassis?.match(/^([\d.]+\s*A)/);
  return chassisMatch ? chassisMatch[1] : "not tabulated";
}

function referenceRow(gaugeToken: string): ReferenceRow | null {
  try {
    const out = run(gaugeToken, { mode: "lookup" });
    return {
      gauge: out["Gauge"] ?? gaugeToken,
      diameter: out["Diameter"]?.split(" (")[0] ?? "-",
      area: out["Area"]?.split(" (")[0] ?? "-",
      resistance: out["Resistance (copper, 20C)"] ?? "-",
      ampacity: firstAmpacity(out),
    };
  } catch {
    return null;
  }
}

/** Computed once: the gauge list is fixed, and every row is a real call into `run()`. */
const referenceRows: ReferenceRow[] = REFERENCE_GAUGES.map(referenceRow).filter(
  (row): row is ReferenceRow => row !== null,
);

/** Highlights the reference row matching the current selection, or size-for's recommended gauge. */
const activeGaugeLabel = computed<string | null>(() =>
  fields.mode === "size-for"
    ? (output.value?.["Recommended gauge"] ?? null)
    : gaugeDisplayLabel(fields.gauge),
);

const typedNote = computed(() =>
  source.value === "typed" && typed.value.trim()
    ? "This line is running now. Gauge and material above follow what the calculator read from it; current, voltage, and length keep whatever you last set, since the result does not echo those back."
    : "Write it the way the calculator reads it, for example 12 awg or 20A 30m 12awg 120V copper.",
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
  fields.gauge = pickOption(GAUGE_SPEC, frag.opts.gauge) ?? fields.gauge;
  if (frag.opts.amps !== undefined) fields.amps = frag.opts.amps;
  if (frag.opts.volts !== undefined) fields.volts = frag.opts.volts;
  if (frag.opts.length !== undefined) fields.length = frag.opts.length;
  fields.lengthUnit = pickSegment(UNIT_OPTIONS, frag.opts.unit) ?? fields.lengthUnit;
  fields.material = pickSegment(MATERIAL_OPTIONS, frag.opts.material) ?? fields.material;
  if (frag.opts.maxdrop !== undefined) fields.maxDropPct = frag.opts.maxdrop;

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
      <div v-if="fields.mode !== 'size-for'" class="flex min-w-0 flex-col gap-1.5">
        <OptionControl
          :spec="GAUGE_SPEC"
          :model-value="fields.gauge"
          @update:model-value="(v: unknown) => setField('gauge', String(v))"
        />
      </div>

      <div v-if="fields.mode !== 'lookup'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="wg-current" class="text-xs text-muted-foreground">Current</Label>
        <Input
          id="wg-current"
          :model-value="fields.amps"
          type="number"
          inputmode="decimal"
          min="0"
          step="0.1"
          placeholder="15"
          class="h-8 font-mono"
          @update:model-value="(v) => setField('amps', String(v))"
        />
      </div>

      <div v-if="fields.mode !== 'lookup'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="wg-voltage" class="text-xs text-muted-foreground">Voltage</Label>
        <Input
          id="wg-voltage"
          :model-value="fields.volts"
          type="number"
          inputmode="decimal"
          min="0"
          step="1"
          placeholder="120"
          class="h-8 font-mono"
          @update:model-value="(v) => setField('volts', String(v))"
        />
      </div>

      <div v-if="fields.mode !== 'lookup'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="wg-length" class="text-xs text-muted-foreground">Length, one way</Label>
        <div class="flex items-center gap-2">
          <Input
            id="wg-length"
            :model-value="fields.length"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.1"
            placeholder="25"
            class="h-8 min-w-0 flex-1 font-mono"
            @update:model-value="(v) => setField('length', String(v))"
          />
          <Segmented
            :model-value="fields.lengthUnit"
            :options="UNIT_OPTIONS"
            label="Length unit"
            size="sm"
            @update:model-value="(v: string) => setField('lengthUnit', v)"
          />
        </div>
      </div>

      <div v-if="fields.mode !== 'lookup'" class="flex min-w-0 flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Conductor material</span>
        <Segmented
          :model-value="fields.material"
          :options="MATERIAL_OPTIONS"
          label="Conductor material"
          @update:model-value="(v: string) => setField('material', v)"
        />
      </div>

      <div v-if="fields.mode === 'size-for'" class="flex min-w-0 flex-col gap-1.5">
        <Label for="wg-maxdrop" class="text-xs text-muted-foreground">Max voltage drop (%)</Label>
        <Input
          id="wg-maxdrop"
          :model-value="fields.maxDropPct"
          type="number"
          inputmode="decimal"
          min="0"
          step="0.5"
          placeholder="3"
          class="h-8 font-mono"
          @update:model-value="(v) => setField('maxDropPct', String(v))"
        />
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
      <span v-if="headline.sub" class="text-sm text-muted-foreground">{{ headline.sub }}</span>
    </div>

    <div
      v-else-if="error"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span class="text-sm font-medium text-destructive">{{ error.message }}</span>
      <span v-if="error.fix" class="text-sm text-muted-foreground">{{ error.fix }}</span>
    </div>

    <p v-else-if="!output" class="text-sm text-muted-foreground">
      Fill in the fields above to see the numbers here.
    </p>

    <div v-if="output" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          {{ fields.mode === "lookup" ? "Wire properties" : "Full result" }}
        </span>
        <CopyButton :text="allRowsText" label="Copy all" />
      </div>
      <KeyValueGrid :record="output" />
    </div>

    <div class="flex flex-col gap-2">
      <div>
        <Button
          variant="ghost"
          size="sm"
          class="-ml-2.5 text-muted-foreground"
          :aria-expanded="refOpen"
          aria-controls="wg-reference"
          @click="refOpen = !refOpen"
        >
          <ChevronRight
            class="size-4 transition-transform duration-150 motion-reduce:transition-none"
            :class="refOpen ? 'rotate-90' : ''"
          />
          Reference table
        </Button>
      </div>

      <div
        v-show="refOpen"
        id="wg-reference"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <p class="text-xs text-muted-foreground">
          Copper wire, common sizes. Each row is this tool's own lookup, not a separate table.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr class="border-b text-left text-xs text-muted-foreground">
                <th class="py-2 pr-3 font-medium">AWG</th>
                <th class="py-2 pr-3 text-right font-medium">Diameter</th>
                <th class="py-2 pr-3 text-right font-medium">Area</th>
                <th class="py-2 pr-3 text-right font-medium">Ohm/km</th>
                <th class="py-2 text-right font-medium">Ampacity</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in referenceRows"
                :key="row.gauge"
                class="border-b border-border/60"
                :class="row.gauge === activeGaugeLabel ? 'bg-primary/10' : ''"
              >
                <td class="py-2 pr-3 font-mono font-medium">{{ row.gauge }}</td>
                <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ row.diameter }}</td>
                <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ row.area }}</td>
                <td class="py-2 pr-3 text-right font-mono tabular-nums">{{ row.resistance }}</td>
                <td class="py-2 text-right font-mono tabular-nums">{{ row.ampacity }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <div>
        <Button
          variant="ghost"
          size="sm"
          class="-ml-2.5 text-muted-foreground"
          :aria-expanded="typedOpen"
          aria-controls="wg-typed"
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
        id="wg-typed"
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
          placeholder="20A 30m 12awg 120V"
          aria-label="Type the calculation"
          class="h-9 border-0 bg-card font-mono"
          @update:model-value="(v) => setTyped(String(v))"
        />
        <p class="text-xs text-muted-foreground">{{ typedNote }}</p>
      </div>
    </div>
  </div>
</template>
