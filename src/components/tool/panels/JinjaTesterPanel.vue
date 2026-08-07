<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ToolError, type ToolMeta } from '@/tools/types';
import {
  buildRenderProgram,
  extractResult,
  formatError,
  parseStatesInput,
  type TemplateError,
} from '@/tools/jinja-template-tester/index';
import { shouldAutoDownload, isMetered, onConnectionChange } from '@/lib/connection';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import CopyButton from '../CopyButton.vue';

/**
 * Bespoke panel for the Jinja Template Tester.
 *
 * The generic ToolShell cannot host this one: rendering needs real Python
 * jinja2, which only exists in the browser through Pyodide, a WebAssembly
 * download of about 13 MB. It starts automatically on an unmetered connection
 * and waits for a one-tap start on a metered one. Everything around the engine
 * that can be pure lives in src/tools/jinja-template-tester/ and is tested in
 * Node; this file owns the two editors, the engine download, and the render
 * loop.
 *
 * Self-hosting: scripts/prepare-pyodide.mjs stages the runtime and the jinja2
 * and MarkupSafe wheels into /pyodide/. The loader is imported from that path
 * at runtime, with a vite-ignore hint on the dynamic import so Vite does not
 * try to bundle Pyodide's Node-only branches, and loadPyodide is pointed at the
 * same path, so nothing a visitor loads comes from a CDN.
 *
 * Nothing touches Pyodide until the user asks to load the engine, so the
 * component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

/* Pyodide's own package types are installed, so the loader and instance are
 * fully typed even though the module is imported from a runtime URL. */
type PyodideModule = typeof import('pyodide');
type PyodideAPI = Awaited<ReturnType<PyodideModule['loadPyodide']>>;

const PYODIDE_DIR = '/pyodide/';
const MANIFEST_URL = `${PYODIDE_DIR}manifest.json`;
const CACHE_PREFIX = 'pyodide-';

interface PyodideManifest {
  pyodideVersion: string;
  totalBytes: number;
  files: { name: string; bytes: number }[];
}

/* ---------------------------------------------------------------- */
/* defaults                                                          */
/* ---------------------------------------------------------------- */

const DEFAULT_TEMPLATE = `The kitchen is {{ states("sensor.kitchen_temperature") }}{{ state_attr("sensor.kitchen_temperature", "unit_of_measurement") }}.
{% if is_state("light.living_room", "on") %}
The living room light is on at {{ state_attr("light.living_room", "brightness") }}/255 brightness.
{% else %}
The living room light is off.
{% endif %}
{% set ns = namespace(open=0) %}
{% for door in states.binary_sensor %}
{% if door.state == "on" %}{% set ns.open = ns.open + 1 %}{% endif %}
{% endfor %}
Open doors: {{ ns.open }}. Rendered at {{ now().strftime("%H:%M") }}.`;

const DEFAULT_STATE = `sensor.kitchen_temperature:
  state: "21.5"
  attributes:
    unit_of_measurement: "°C"
    friendly_name: Kitchen Temperature
light.living_room:
  state: "on"
  attributes:
    brightness: 200
binary_sensor.front_door:
  state: "off"
binary_sensor.back_door:
  state: "on"`;

/* ---------------------------------------------------------------- */
/* state                                                            */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps the capability check off the server. */
const supported = ref(false);

const templateText = ref(DEFAULT_TEMPLATE);
const stateText = ref(DEFAULT_STATE);

type EngineState = 'idle' | 'loading' | 'starting' | 'ready' | 'error';
const engineState = ref<EngineState>('idle');
const engineError = ref<{ message: string; fix?: string } | null>(null);

const downloadedBytes = ref(0);
const totalBytes = ref(0);

/** True when a metered or Save-Data connection is holding the auto-start back. */
const metered = ref(false);
/** Consumed once by the connection listener if a metered link turns unmetered. */
let pendingAutoStart = false;
let stopConnectionWatch: () => void = () => {};

const output = ref('');
const renderError = ref<TemplateError | null>(null);
const stateError = ref<{ message: string; fix?: string } | null>(null);

/** The Pyodide instance is never made reactive: Vue must not proxy the runtime. */
let pyodide: PyodideAPI | null = null;
let loadPromise: Promise<void> | null = null;

/** Render serialization: one run at a time, with a re-run if input changed. */
let rendering = false;
let dirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/* ---------------------------------------------------------------- */
/* derived                                                          */
/* ---------------------------------------------------------------- */

const approxMb = computed(() => {
  const bytes = totalBytes.value || 13_667_583;
  return Math.round(bytes / (1024 * 1024));
});

const downloadPercent = computed(() => {
  if (!totalBytes.value) return 0;
  return Math.min(100, Math.round((downloadedBytes.value / totalBytes.value) * 100));
});

const engineButtonLabel = computed(() => {
  if (engineState.value === 'error') return 'Try loading the engine again';
  return metered.value
    ? `Load the template engine (about ${approxMb.value} MB)`
    : 'Load the template engine';
});

const ready = computed(() => engineState.value === 'ready');

/* ---------------------------------------------------------------- */
/* engine download                                                  */
/* ---------------------------------------------------------------- */

/**
 * Opens the versioned cache for this Pyodide build and evicts every older one,
 * so an engine upgrade never leaves a dead copy behind. Returns null when Cache
 * Storage is unavailable, which happens in some private browsing modes.
 */
async function openVersionCache(version: string): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  const name = `${CACHE_PREFIX}${version}`;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => caches.delete(k)),
    );
    return await caches.open(name);
  } catch {
    return null;
  }
}

/** Streams a response body, reporting each chunk so the byte counter is live. */
async function readWithProgress(response: Response, onChunk: (bytes: number) => void): Promise<void> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onChunk(buffer.byteLength);
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) onChunk(value.byteLength);
  }
}

/**
 * Fetches every staged file once, into the versioned cache, reporting bytes as
 * they arrive. loadPyodide fetches the same URLs immediately afterwards and is
 * served from that cache (through the service worker) or the HTTP cache, so the
 * engine downloads exactly once.
 */
async function prefetchEngine(manifest: PyodideManifest): Promise<void> {
  const cache = await openVersionCache(manifest.pyodideVersion);
  const onChunk = (bytes: number) => {
    downloadedBytes.value = Math.min(downloadedBytes.value + bytes, totalBytes.value);
  };

  for (const file of manifest.files) {
    if (file.name === 'manifest.json') continue;
    const url = `${PYODIDE_DIR}${file.name}`;
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) {
          await readWithProgress(hit, onChunk);
          continue;
        }
      } catch {
        // A broken cache entry is not worth failing the load over.
      }
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new ToolError(
        'engine-download',
        `The template engine could not be downloaded (${response.status} on ${file.name}).`,
        'Check your connection and try loading the engine again.',
      );
    }
    if (cache) {
      try {
        await cache.put(url, response.clone());
      } catch {
        // Storing is best effort; the load still works from the network copy.
      }
    }
    await readWithProgress(response, onChunk);
  }
  downloadedBytes.value = totalBytes.value;
}

async function startEngine(): Promise<void> {
  engineState.value = 'loading';
  engineError.value = null;
  downloadedBytes.value = 0;

  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) {
    throw new ToolError(
      'engine-missing',
      'The template engine files are not available on this server.',
      'Reload the page. If it keeps failing, the site build did not publish the engine.',
    );
  }
  const manifest = (await manifestRes.json()) as PyodideManifest;
  totalBytes.value = manifest.totalBytes;

  await prefetchEngine(manifest);

  engineState.value = 'starting';
  const mod = (await import(/* @vite-ignore */ `${PYODIDE_DIR}pyodide.mjs`)) as PyodideModule;
  const instance = await mod.loadPyodide({ indexURL: PYODIDE_DIR });
  await instance.loadPackage('jinja2');

  // Make now() and the timestamp filters use the visitor's own time zone, the
  // way a Home Assistant instance uses its configured zone.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      instance.runPython(
        `import os, time\ntry:\n    os.environ['TZ'] = ${JSON.stringify(tz)}\n    time.tzset()\nexcept Exception:\n    pass\n`,
      );
    }
  } catch {
    // Falling back to UTC for now() is acceptable and is noted in the reference.
  }

  pyodide = instance;
  engineState.value = 'ready';
}

function loadEngine(): void {
  if (!supported.value || engineState.value === 'loading' || engineState.value === 'starting') {
    return;
  }
  // A press (or the automatic start) commits to the download, so drop any hold.
  pendingAutoStart = false;
  loadPromise ??= startEngine()
    .then(() => {
      scheduleRender(0);
    })
    .catch((err: unknown) => {
      engineState.value = 'error';
      pyodide = null;
      loadPromise = null;
      engineError.value =
        err instanceof ToolError
          ? { message: err.message, fix: err.fix }
          : {
              message: 'The template engine failed to start in this browser.',
              fix: 'Reload the page and try again. A current version of Chrome, Edge, Firefox, or Safari is required.',
            };
    });
}

/* ---------------------------------------------------------------- */
/* rendering                                                        */
/* ---------------------------------------------------------------- */

async function renderNow(): Promise<void> {
  if (!pyodide || !ready.value) return;
  if (rendering) {
    dirty = true;
    return;
  }
  rendering = true;
  dirty = false;

  // Parsing the sample state is pure and can throw a ToolError with a fix.
  let program: string;
  try {
    const states = parseStatesInput(stateText.value);
    stateError.value = null;
    program = buildRenderProgram(states, templateText.value);
  } catch (err) {
    stateError.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : String(err) };
    rendering = false;
    return;
  }

  try {
    const result = await pyodide.runPythonAsync(program);
    output.value = extractResult(result);
    renderError.value = null;
  } catch (err) {
    renderError.value = formatError(err instanceof Error ? err.message : String(err));
  } finally {
    rendering = false;
    if (dirty) void renderNow();
  }
}

function scheduleRender(delay = 250): void {
  if (!ready.value) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void renderNow();
  }, delay);
}

watch([templateText, stateText], () => scheduleRender());

/* ---------------------------------------------------------------- */
/* lifecycle                                                        */
/* ---------------------------------------------------------------- */

/**
 * Starts the engine download without a click on first visit, unless the
 * connection is metered or Save-Data. When it is, the panel keeps a one-tap
 * start and remembers to auto-start later if the link turns unmetered.
 */
function autoStartEngine(): void {
  if (engineState.value !== 'idle') return;
  if (shouldAutoDownload()) {
    loadEngine();
  } else {
    metered.value = true;
    pendingAutoStart = true;
  }
}

onMounted(() => {
  supported.value =
    typeof WebAssembly !== 'undefined' && typeof URL !== 'undefined' && typeof fetch !== 'undefined';
  if (!supported.value) return;
  metered.value = isMetered();
  autoStartEngine();
  stopConnectionWatch = onConnectionChange(() => {
    metered.value = isMetered();
    if (pendingAutoStart && shouldAutoDownload()) {
      pendingAutoStart = false;
      autoStartEngine();
    }
  });
});

onUnmounted(() => {
  stopConnectionWatch();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  // Pyodide holds a large wasm heap; drop the reference so the tab can reclaim
  // it when the panel goes away. There is no public teardown in the API.
  pyodide = null;
  loadPromise = null;
});

/* ---------------------------------------------------------------- */
/* reference copy                                                   */
/* ---------------------------------------------------------------- */

const stubbedFunctions = [
  ['states("entity.id")', 'the state string, or None when the entity is not in your sample'],
  ['states.sensor.kitchen', 'the state object: .state, .attributes, .name, .entity_id'],
  ['is_state("entity.id", "on")', 'True when the sampled state matches'],
  ['state_attr("entity.id", "attr")', 'an attribute value from your sample, or None'],
  ['is_state_attr("entity.id", "attr", v)', 'True when the sampled attribute matches'],
  ['has_value("entity.id")', 'True unless the state is unknown or unavailable'],
  ['now(), utcnow()', 'the real current time, in your browser time zone'],
  ['as_timestamp, as_datetime, as_local', 'the Home Assistant time helpers'],
  ['timedelta, strptime', 'from the Python datetime module'],
  ['float, int, timestamp_custom filters', 'the common Home Assistant filters'],
];
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Editors -->
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label
          for="jinja-template"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Template
        </Label>
        <Textarea
          id="jinja-template"
          v-model="templateText"
          spellcheck="false"
          rows="14"
          class="min-h-56 resize-y bg-secondary font-mono text-sm shadow-[var(--sh-inset)]"
          placeholder="{{ states('sensor.kitchen_temperature') }}"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label
          for="jinja-state"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Sample entity state (YAML or JSON)
        </Label>
        <Textarea
          id="jinja-state"
          v-model="stateText"
          spellcheck="false"
          rows="14"
          class="min-h-56 resize-y bg-secondary font-mono text-sm shadow-[var(--sh-inset)]"
          placeholder="sensor.kitchen_temperature:&#10;  state: '21.5'"
        />
      </div>
    </div>

    <!-- State parse error -->
    <div
      v-if="stateError"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ stateError.message }}
      </p>
      <p
        v-if="stateError.fix"
        class="mt-1 text-muted-foreground"
      >
        {{ stateError.fix }}
      </p>
    </div>

    <!-- Engine opt-in card -->
    <div
      v-if="!ready"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-sm font-medium">Load the template engine</span>
          <span class="text-xs text-muted-foreground">
            About {{ approxMb }} MB, one time, then cached for later visits. Served from this site,
            runs entirely in this tab.
          </span>
        </div>
        <Button
          size="sm"
          :disabled="!supported || engineState === 'loading' || engineState === 'starting'"
          @click="loadEngine"
        >
          {{ engineButtonLabel }}
        </Button>
      </div>

      <div
        v-if="engineState === 'loading' || engineState === 'starting'"
        class="flex flex-col gap-2"
      >
        <div class="flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ engineState === 'starting' ? 'Starting Python and loading jinja2…' : 'Downloading the engine…' }}</span>
          <span class="tabular-nums">{{ engineState === 'starting' ? '' : `${downloadPercent}%` }}</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-card">
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-150"
            :style="{ width: engineState === 'starting' ? '100%' : `${downloadPercent}%` }"
          />
        </div>
      </div>

      <p
        v-if="metered && engineState === 'idle'"
        class="text-xs text-muted-foreground"
      >
        Your connection looks metered, so the engine waits for you to start it.
      </p>

      <p
        v-if="!supported"
        class="text-xs text-muted-foreground"
      >
        This browser cannot run the template engine. A current version of Chrome, Edge, Firefox, or
        Safari is required.
      </p>

      <div
        v-if="engineError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ engineError.message }}
        </p>
        <p
          v-if="engineError.fix"
          class="mt-1 text-muted-foreground"
        >
          {{ engineError.fix }}
        </p>
      </div>
    </div>

    <!-- Output -->
    <div
      v-if="ready"
      class="flex flex-col gap-1.5"
    >
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Rendered output
        </span>
        <CopyButton
          :text="output"
          label="Copy"
        />
      </div>

      <div
        v-if="renderError"
        role="alert"
        class="rounded-[10px] border border-destructive/50 bg-destructive/5 px-3 py-3 text-sm shadow-[var(--sh-inset)]"
      >
        <p class="font-medium text-destructive">
          <span
            v-if="renderError.line !== null"
            class="font-mono"
          >Line {{ renderError.line }}: </span>{{ renderError.message }}
        </p>
        <p class="mt-1 font-mono text-xs text-muted-foreground">
          {{ renderError.errorType }}
        </p>
      </div>

      <pre
        v-else
        class="max-h-96 overflow-auto rounded-[10px] bg-secondary px-3 py-3 font-mono text-sm whitespace-pre-wrap shadow-[var(--sh-inset)]"
      >{{ output === '' ? '(empty output)' : output }}</pre>
    </div>

    <!-- Reference -->
    <details class="rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
      <summary class="cursor-pointer text-sm font-medium">
        Supported Home Assistant functions and caveats
      </summary>
      <div class="mt-3 flex flex-col gap-3 text-sm">
        <p class="text-muted-foreground">
          The engine is real Python jinja2, so syntax, filters, tests, and namespace() behave
          exactly as Home Assistant's do. The Home Assistant functions below are stubbed over the
          sample state you provide, not read from a live instance.
        </p>
        <ul class="flex flex-col gap-1.5">
          <li
            v-for="[name, note] in stubbedFunctions"
            :key="name"
            class="flex flex-col gap-0.5 sm:flex-row sm:gap-3"
          >
            <code class="shrink-0 font-mono text-xs text-foreground sm:w-72">{{ name }}</code>
            <span class="text-xs text-muted-foreground">{{ note }}</span>
          </li>
        </ul>
        <p class="text-muted-foreground">
          Not stubbed, because they need a running instance or the network: service calls, expand()
          over live groups, distance() to real coordinates, and device or area lookups. These read
          from a live Home Assistant, so they cannot be reproduced from sample data here.
        </p>
        <p class="text-muted-foreground">
          Everything runs in this tab: your files and inputs never leave your device.
        </p>
      </div>
    </details>
  </div>
</template>
