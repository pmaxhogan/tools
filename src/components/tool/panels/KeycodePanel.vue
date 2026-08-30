<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { run } from "@/tools/keycode/index";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the keycode tool: a live "press any key" capture
 * surface instead of the generic paste-JSON shell. Serializes the real
 * KeyboardEvent and feeds it through the same pure `run()` the textarea
 * version uses, so the readout logic never diverges.
 */
defineProps<{ meta: ToolMeta }>();

interface HistoryEntry {
  /** Dedupe/display identity: the raw event.key. */
  id: string;
  label: string;
  code: string;
  output: Record<string, string>;
}

const output = ref<Record<string, string> | null>(null);
const pad = ref<HTMLElement>();
const padFocused = ref(false);
const currentLabel = ref<string | null>(null);
const currentCode = ref<string | null>(null);
const currentId = ref<string | null>(null);
const history = ref<HistoryEntry[]>([]);

/** Renders " " as "Space"; every other key renders as-is. */
function keyLabel(key: string): string {
  return key === " " ? "Space" : key;
}

/** Keys that would scroll or move focus if left to the browser default. */
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/**
 * Swallowing Tab, Space and the arrows is the whole point of a key tester, but
 * doing it on `window` unconditionally makes the rest of the page unreachable
 * by keyboard: no header, no theme toggle, no copy buttons. So the readout
 * listens everywhere and the suppression is scoped to the capture pad. Focus
 * the pad and it eats those keys; Escape or a click elsewhere hands them back.
 */
function shouldPreventDefault(e: KeyboardEvent): boolean {
  if (!padFocused.value) return false;
  return e.key === " " || NAV_KEYS.has(e.key);
}

function pushHistory(entry: HistoryEntry) {
  history.value = [entry, ...history.value.filter((h) => h.id !== entry.id)].slice(0, 5);
}

async function handleKeyDown(e: KeyboardEvent) {
  if (shouldPreventDefault(e)) e.preventDefault();
  // The way out of the capture pad for someone using only a keyboard.
  if (e.key === "Escape" && padFocused.value) pad.value?.blur();

  const serialized = {
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    which: e.which,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    repeat: e.repeat,
    location: e.location,
  };

  const result = await run(JSON.stringify(serialized), {});
  const label = keyLabel(e.key);

  output.value = result;
  currentLabel.value = label;
  currentCode.value = e.code;
  currentId.value = e.key;

  if (!e.repeat) {
    pushHistory({ id: e.key, label, code: e.code, output: result });
  }
}

/** Clicking the pad body focuses it, so a mouse user gets capture as well. */
function focusPad() {
  pad.value?.focus();
}

function selectHistory(entry: HistoryEntry) {
  output.value = entry.output;
  currentLabel.value = entry.label;
  currentCode.value = entry.code;
  currentId.value = entry.id;
}

onMounted(() => window.addEventListener("keydown", handleKeyDown));
onUnmounted(() => window.removeEventListener("keydown", handleKeyDown));
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div
      ref="pad"
      tabindex="0"
      role="group"
      aria-label="Key capture pad. Press any key to inspect the event it fires."
      aria-describedby="keycode-pad-hint"
      class="flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-4 rounded-[14px] bg-secondary p-8 text-center shadow-[var(--sh-inset)]"
      @focus="padFocused = true"
      @blur="padFocused = false"
      @mousedown.prevent="focusPad"
    >
      <div aria-live="polite" class="flex flex-col items-center gap-4">
        <template v-if="currentLabel === null">
          <p class="text-muted-foreground">Press any key</p>
        </template>
        <template v-else>
          <kbd
            class="rounded-[8px] border bg-card px-6 py-4 font-mono text-4xl leading-none font-semibold shadow-[var(--sh-sm)]"
            >{{ currentLabel }}</kbd
          >
          <p class="font-mono text-sm text-muted-foreground">
            {{ currentCode }}
          </p>
        </template>
      </div>
    </div>

    <p id="keycode-pad-hint" class="text-xs text-muted-foreground">
      <template v-if="padFocused">
        The pad has focus, so Tab, Space and the arrow keys are captured here instead of moving the
        page. Press Escape to hand them back.
      </template>
      <template v-else>
        Every key press is read anywhere on the page. Click the pad, or tab to it, to capture Tab,
        Space and the arrow keys too.
      </template>
    </p>

    <div v-if="history.length" class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >Recent keys</span
      >
      <div class="flex flex-wrap gap-2">
        <button
          v-for="entry in history"
          :key="entry.id"
          type="button"
          class="rounded-[8px] border px-3 py-1.5 font-mono text-sm transition-colors"
          :class="
            entry.id === currentId
              ? 'border-transparent bg-primary bg-[image:var(--grad-brand)] text-primary-foreground shadow-[var(--sh-sm)]'
              : 'bg-secondary hover:bg-accent'
          "
          :title="entry.output['Event summary']"
          :aria-pressed="entry.id === currentId"
          @click="selectHistory(entry)"
        >
          {{ entry.label }}
        </button>
      </div>
    </div>

    <OutputView v-if="output !== null" :output="output" />

    <p v-if="output !== null" class="text-xs text-muted-foreground">
      keyCode and which are deprecated legacy values, shown here for compatibility work only.
    </p>
  </div>
</template>
