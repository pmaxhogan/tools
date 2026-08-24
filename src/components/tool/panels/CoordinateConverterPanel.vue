<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ExternalLink, LocateFixed } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import { run, type CoordinateOpts } from "@/tools/coordinate-converter/index";
import { coerceOptValue, readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText, type KeyValueRow } from "@/lib/key-value";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Coordinate Converter.
 *
 * The tool's best trick is that it works out for itself which of nine
 * notations you pasted, and the generic shell buries that as one row halfway
 * down a table. Here it is a row of chips above the field, lit as you type, so
 * the answer to "did it understand my MGRS reference" arrives before you read
 * a single output value.
 *
 * The chips are read straight out of the tool's own "Detected format" rows
 * (PROJECT.md rule 27): the panel never parses a coordinate itself, which is
 * also why two point input keeps working without a second code path. The map
 * links are lifted out of the same result and rendered as real links rather
 * than as text to copy, and everything else goes to the shared grid.
 *
 * Nothing touches `window`, `history`, or `navigator` until `onMounted` or a
 * click handler. Location is read only when the reader presses "Use my
 * location", it lands in the visible field first, and the URL is written from
 * what the field holds.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * options, seeded from the tool's own meta so the defaults never drift
 * ------------------------------------------------------------------ */

const optionSpecs = computed(() => props.meta.options ?? []);

function defaultOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of props.meta.options ?? []) out[spec.id] = spec.default;
  return out;
}

const opts = ref<Record<string, unknown>>(defaultOpts());

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const text = ref<string>("");

const geoBusy = ref<boolean>(false);
const geoNote = ref<string | null>(null);

const output = ref<Record<string, string> | null>(null);
const runError = ref<{ message: string; fix?: string } | null>(null);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

function describe(err: unknown): { message: string; fix?: string } {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : String(err) };
}

/** An empty field is a tool waiting for input, never a red error. */
function evaluate(): void {
  if (!text.value.trim()) {
    output.value = null;
    runError.value = null;
    return;
  }
  try {
    // The bag is built from the meta's own specs, so every id the tool reads is
    // present with the type its spec declares; the assertion only tells the
    // compiler what the schema already guarantees.
    output.value = run(text.value, opts.value as CoordinateOpts);
    runError.value = null;
  } catch (err) {
    output.value = null;
    runError.value = describe(err);
  }
}

/* ------------------------------------------------------------------ *
 * detected format chips
 * ------------------------------------------------------------------ */

/**
 * One chip per notation the reader might have pasted. The tool reports the
 * format as free text that sometimes carries a size ("Plus Code (10 digits)")
 * and sometimes names the site a link came from ("Google Maps link"), so each
 * chip owns the test that recognizes its own family rather than comparing
 * strings.
 */
const FORMAT_CHIPS: readonly { id: string; label: string; match: (format: string) => boolean }[] = [
  { id: "dd", label: "Decimal", match: (f) => f.startsWith("Decimal degrees") },
  { id: "dms", label: "DMS", match: (f) => f.startsWith("DMS") },
  { id: "ddm", label: "DDM", match: (f) => f.startsWith("DDM") },
  { id: "utm", label: "UTM", match: (f) => f === "UTM" },
  { id: "mgrs", label: "MGRS", match: (f) => f === "MGRS" },
  { id: "plus", label: "Plus Code", match: (f) => f.startsWith("Plus Code") },
  { id: "geohash", label: "Geohash", match: (f) => f.startsWith("Geohash") },
  { id: "geouri", label: "geo URI", match: (f) => f === "geo URI" },
  { id: "link", label: "Map link", match: (f) => f.endsWith("link") },
];

interface Detection {
  /** "Point 1", "Point 2", or "" for the single point case. */
  prefix: string;
  format: string;
  activeId: string | null;
}

const detections = computed<Detection[]>(() => {
  const out = output.value;
  if (!out) return [];
  const found: Detection[] = [];
  for (const [key, value] of Object.entries(out)) {
    if (!key.endsWith("Detected format")) continue;
    found.push({
      prefix: key.slice(0, key.length - "Detected format".length).trim(),
      format: value,
      activeId: FORMAT_CHIPS.find((chip) => chip.match(value))?.id ?? null,
    });
  }
  return found;
});

/* ------------------------------------------------------------------ *
 * splitting the result: map links out, everything else to the grid
 * ------------------------------------------------------------------ */

const LINK_LABELS = ["OpenStreetMap", "Google Maps", "Apple Maps"];

function isLinkRow(key: string, value: string): boolean {
  return LINK_LABELS.some((label) => key.endsWith(label)) && /^https?:\/\//.test(value);
}

const mapLinks = computed<{ key: string; label: string; url: string }[]>(() =>
  Object.entries(output.value ?? {})
    .filter(([key, value]) => isLinkRow(key, value))
    .map(([key, value]) => ({ key, label: key, url: value })),
);

const gridRows = computed<KeyValueRow[]>(() =>
  recordToRows(output.value ?? {}).filter((row) => !isLinkRow(row.key, row.value)),
);

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
    geoNote.value = "This browser offers no location API. Paste a coordinate instead.";
    return;
  }
  geoBusy.value = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      geoBusy.value = false;
      text.value = `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`;
      geoNote.value = "Filled from your device. The position stays in this tab.";
    },
    (error) => {
      geoBusy.value = false;
      geoNote.value =
        error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. Paste a coordinate instead."
          : error.code === error.TIMEOUT
            ? "The location request timed out. Try again, or paste a coordinate."
            : "Your location is not available right now. Paste a coordinate instead.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  );
}

function setOption(id: string, value: unknown): void {
  opts.value = { ...opts.value, [id]: value };
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

function optsAsStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of props.meta.options ?? []) out[spec.id] = String(opts.value[spec.id]);
  return out;
}

function schedule(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({ input: text.value || undefined, opts: optsAsStrings() });
  }, 120);
}

watch([text, opts], schedule, { deep: true });

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) text.value = frag.input;
  const restored = { ...opts.value };
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw !== undefined) restored[spec.id] = coerceOptValue(spec, raw);
  }
  opts.value = restored;
  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        <Label for="coord-input" class="text-xs text-muted-foreground">Coordinate</Label>
        <Button
          variant="outline"
          size="sm"
          :disabled="geoBusy"
          aria-label="Use my location"
          @click="useMyLocation"
        >
          <LocateFixed class="size-4" />
          Use my location
        </Button>
      </div>
      <Textarea
        id="coord-input"
        :model-value="text"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        placeholder="40.7128, -74.0060"
        class="resize-y bg-secondary font-mono text-sm"
        :aria-invalid="runError !== null"
        @update:model-value="(v) => (text = String(v))"
      />

      <!-- Detected format -->
      <div v-if="detections.length" class="flex flex-col gap-1.5" aria-live="polite">
        <div
          v-for="detection in detections"
          :key="detection.prefix || 'single'"
          class="flex flex-wrap items-center gap-1.5"
        >
          <span class="text-xs text-muted-foreground">
            {{ detection.prefix ? `${detection.prefix} detected` : "Detected" }}
          </span>
          <span
            v-for="chip in FORMAT_CHIPS"
            :key="chip.id"
            class="rounded-[8px] border px-2 py-0.5 text-xs"
            :class="
              chip.id === detection.activeId
                ? 'border-transparent bg-primary text-primary-foreground bg-[image:var(--grad-brand)]'
                : 'border-border bg-secondary text-muted-foreground'
            "
            :aria-current="chip.id === detection.activeId ? 'true' : undefined"
          >
            {{ chip.label }}
          </span>
        </div>
      </div>

      <p v-else-if="runError" role="alert" class="flex flex-col gap-0.5">
        <span class="text-sm font-medium text-destructive">{{ runError.message }}</span>
        <span v-if="runError.fix" class="text-sm text-muted-foreground">{{ runError.fix }}</span>
      </p>

      <p v-else class="text-xs text-muted-foreground">
        Decimal degrees, DMS, DDM, UTM, MGRS, a Plus Code, a geohash, a geo URI or a pasted map
        link. Two points, separated by a semicolon or a new line, add the distance between them.
      </p>

      <p v-if="geoNote" role="status" class="text-xs text-muted-foreground">{{ geoNote }}</p>
    </div>

    <!-- Options -->
    <div v-if="optionSpecs.length" class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <OptionControl
        v-for="spec in optionSpecs"
        :key="spec.id"
        :spec="spec"
        :model-value="opts[spec.id]"
        class="w-44"
        @update:model-value="(v) => setOption(spec.id, v)"
      />
    </div>

    <!-- Every format at once -->
    <div v-if="output" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          All formats
        </span>
        <CopyButton :text="allRowsText" label="Copy all" />
      </div>
      <KeyValueGrid :rows="gridRows" />

      <div v-if="mapLinks.length" class="flex flex-wrap items-center gap-2 px-3 py-2">
        <span class="text-xs text-muted-foreground">Open in</span>
        <a
          v-for="link in mapLinks"
          :key="link.key"
          :href="link.url"
          target="_blank"
          rel="noreferrer noopener"
          class="inline-flex items-center gap-1 rounded-[8px] border bg-card px-2.5 py-1 text-xs transition-colors hover:bg-accent"
        >
          {{ link.label }}
          <ExternalLink class="size-3" />
        </a>
      </div>
    </div>
  </div>
</template>
