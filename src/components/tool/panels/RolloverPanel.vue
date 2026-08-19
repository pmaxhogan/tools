<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { Play, RotateCcw, Square } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import {
  classifyRollover,
  GHOSTING_GUIDANCE,
  initialState,
  KEY_LAYOUT,
  maxRollover,
  recordEvent,
  run,
  type RolloverEvent,
  type RolloverState,
} from "@/tools/key-rollover-tester/index";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the key rollover tester: a live "hold down keys" capture
 * surface plus a lit keyboard diagram, mirroring KeycodePanel's approach of
 * feeding real KeyboardEvents through the same pure `index.ts` a JSON paste
 * would use. The big counters read `state` directly so they update every
 * keystroke; the "Details" disclosure instead serializes the recorded events
 * and calls `run()`, exercising the same path the curl API would take.
 */
defineProps<{ meta: ToolMeta }>();

/** Recorded keydown/keyup pairs, fed to `run()` for the Details disclosure. */
const MAX_EVENTS = 4000;

const state = ref<RolloverState>(initialState);
const events = ref<RolloverEvent[]>([]);
const testActive = ref(false);
const captureRegion = ref<HTMLDivElement | null>(null);

/** F5 and F12 stay live so refreshing or opening devtools still works mid test. */
const ALLOW_DEFAULT_CODES = new Set(["F5", "F12"]);

let listenersAttached = false;

function pushEvent(ev: RolloverEvent) {
  events.value.push(ev);
  if (events.value.length > MAX_EVENTS) {
    events.value.splice(0, events.value.length - MAX_EVENTS);
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (!ALLOW_DEFAULT_CODES.has(e.code)) e.preventDefault();
  // Auto-repeat while a key stays held is not a new press: recordEvent would
  // already treat it as a no-op, but skipping it here also keeps the events
  // log (and the Details report) free of repeat noise.
  if (e.repeat) return;

  const ev: RolloverEvent = { type: "keydown", code: e.code, key: e.key, timestamp: e.timeStamp };
  state.value = recordEvent(state.value, ev);
  pushEvent(ev);
}

function onKeyUp(e: KeyboardEvent) {
  if (!ALLOW_DEFAULT_CODES.has(e.code)) e.preventDefault();

  const ev: RolloverEvent = { type: "keyup", code: e.code, key: e.key, timestamp: e.timeStamp };
  state.value = recordEvent(state.value, ev);
  pushEvent(ev);
}

function attachListeners() {
  if (listenersAttached) return;
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  listenersAttached = true;
}

function detachListeners() {
  if (!listenersAttached) return;
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  listenersAttached = false;
}

function startTest() {
  testActive.value = true;
  attachListeners();
  captureRegion.value?.focus();
}

function stopTest() {
  testActive.value = false;
  detachListeners();
  // No more keyup events will arrive once listeners are gone, so anything
  // still marked held would otherwise stay lit forever. History (max chord,
  // total presses) is untouched.
  state.value = { ...state.value, heldOrder: [], heldKeys: {} };
}

function resetTest() {
  state.value = initialState;
  events.value = [];
}

onUnmounted(detachListeners);

/* ---------------------------------------------------------------- */
/* live counters                                                     */
/* ---------------------------------------------------------------- */

const heldNow = computed(() => state.value.heldOrder.length);
const maxAtOnce = computed(() => maxRollover(state.value));
const verdict = computed(() => classifyRollover(maxAtOnce.value));
const chordOrder = computed(() =>
  state.value.maxChordKeys.length ? state.value.maxChordKeys.join(" then ") : "none yet",
);

function isHeld(code: string | null): boolean {
  return code !== null && code in state.value.heldKeys;
}

/** Was pressed at some point this session but is not held right now. */
function wasPressed(code: string | null): boolean {
  return code !== null && !isHeld(code) && code in state.value.pressCounts;
}

function keyClasses(code: string | null): string {
  if (code === null) return "invisible";
  if (isHeld(code)) {
    return "border border-transparent bg-[image:var(--grad-brand)] text-primary-foreground shadow-[var(--sh-sm)]";
  }
  if (wasPressed(code)) return "border bg-accent text-foreground";
  return "border bg-card text-muted-foreground";
}

/* ---------------------------------------------------------------- */
/* details disclosure: exercises run() on the serialized events      */
/* ---------------------------------------------------------------- */

const detailsOutput = computed<Record<string, string> | null>(() => {
  if (events.value.length === 0) return null;
  return run(JSON.stringify({ events: events.value }), {});
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- controls -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Button v-if="!testActive" size="lg" @click="startTest">
          <Play class="size-4" aria-hidden="true" />
          Start test
        </Button>
        <Button v-else variant="secondary" size="lg" @click="stopTest">
          <Square class="size-4" aria-hidden="true" />
          Stop
        </Button>

        <Button variant="outline" @click="resetTest">
          <RotateCcw class="size-4" aria-hidden="true" />
          Reset
        </Button>
      </div>

      <div
        ref="captureRegion"
        tabindex="0"
        role="application"
        aria-label="Key rollover capture area"
        class="rounded-[14px] px-4 py-6 text-center text-sm shadow-[var(--sh-inset)] transition-colors"
        :class="testActive ? 'bg-accent text-foreground' : 'bg-secondary text-muted-foreground'"
      >
        {{
          testActive
            ? "Listening. Hold down as many keys as you can, ideally a combo you would actually use."
            : "Click Start test, then hold down keys here."
        }}
      </div>
    </div>

    <!-- live counters -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Held now
          </div>
          <div class="mt-1 font-mono text-3xl font-semibold tabular-nums">{{ heldNow }}</div>
        </div>
        <div class="rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Max at once
          </div>
          <div class="mt-1 font-mono text-3xl font-semibold tabular-nums">{{ maxAtOnce }}</div>
        </div>
        <div class="rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Verdict
          </div>
          <div class="mt-1 font-mono text-xl font-semibold">{{ verdict }}</div>
        </div>
      </div>

      <p class="text-sm text-muted-foreground">
        Largest chord, in press order:
        <span class="font-mono text-foreground">{{ chordOrder }}</span>
      </p>
    </div>

    <!-- keyboard diagram -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >Live diagram</span
      >
      <div class="overflow-x-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]">
        <div class="flex min-w-[880px] flex-col gap-1">
          <div v-for="(row, ri) in KEY_LAYOUT" :key="ri" class="flex gap-1">
            <div
              v-for="(k, ki) in row"
              :key="ki"
              class="flex h-9 items-center justify-center rounded-[8px] text-[11px] font-mono transition-colors sm:h-10"
              :style="{ flex: `${k.width} ${k.width} 0%` }"
              :class="keyClasses(k.code)"
            >
              <span v-if="k.code">{{ k.label }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- guidance -->
    <div class="flex flex-col gap-2 rounded-[18px] border bg-card p-5 text-sm text-muted-foreground shadow-[var(--sh-sm)] sm:p-6">
      <p>{{ GHOSTING_GUIDANCE }}</p>
      <p>
        Your operating system and browser swallow some combinations before this page ever sees
        them, such as Windows+L, Alt+Tab, and Ctrl+Alt+Delete. Those never register here, even on
        a full NKRO keyboard. Many keyboards also fall back to the USB boot protocol, the same
        legacy mode used by PC BIOS and boot loaders, which can only report up to six regular keys
        held at once: if the count above always stops at 6, that may be the keyboard reporting in
        that mode rather than a hard hardware limit.
      </p>
    </div>

    <!-- details -->
    <details class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
      <summary class="cursor-pointer text-sm text-muted-foreground">Details</summary>
      <div class="mt-3">
        <OutputView v-if="detailsOutput" :output="detailsOutput" />
        <p v-else class="text-sm text-muted-foreground">
          No key events recorded yet. Start the test and press some keys.
        </p>
      </div>
    </details>
  </div>
</template>
