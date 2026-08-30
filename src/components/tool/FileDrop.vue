<script lang="ts">
/**
 * Document paste, shared by every mounted FileDrop.
 *
 * Module scope on purpose. A panel with two zones (before/after, cover/track)
 * mounts two of these, and one listener per instance meant one Ctrl+V loaded
 * the same file into both of them. So there is exactly one document listener
 * however many zones are on the page, and it hands the paste to a single zone:
 * the one focus is inside, and otherwise the first one mounted. Zones that are
 * disabled, that opted out with `:paste="false"`, or whose element is no longer
 * in the document are not candidates at all.
 */
interface PasteTarget {
  root: () => HTMLElement | null;
  enabled: () => boolean;
  handle: (files: File[]) => void;
}

const pasteTargets: PasteTarget[] = [];
let pasteListener: ((event: ClipboardEvent) => void) | null = null;

function onDocumentPaste(event: ClipboardEvent): void {
  const candidates = pasteTargets.filter((target) => {
    const root = target.root();
    return target.enabled() && !!root && root.isConnected;
  });
  if (candidates.length === 0) return;
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;

  const active = document.activeElement;
  const focused = active
    ? candidates.find((target) => {
        const root = target.root();
        return !!root && (root === active || root.contains(active));
      })
    : undefined;
  (focused ?? candidates[0])?.handle(files);
}

function addPasteTarget(target: PasteTarget): void {
  pasteTargets.push(target);
  if (!pasteListener) {
    pasteListener = onDocumentPaste;
    document.addEventListener("paste", pasteListener);
  }
}

function removePasteTarget(target: PasteTarget): void {
  const index = pasteTargets.indexOf(target);
  if (index >= 0) pasteTargets.splice(index, 1);
  if (pasteTargets.length === 0 && pasteListener) {
    document.removeEventListener("paste", pasteListener);
    pasteListener = null;
  }
}
</script>

<script setup lang="ts">
/**
 * The one file drop zone. Every panel that takes a file uses this instead of
 * hand rolling the inset well, the hidden input, and the drag state.
 *
 * What it covers, drawn from the 43 panels that rolled their own:
 *   - drop, click to pick, keyboard activation, and clipboard paste
 *   - a compact single line variant for panels that already show a file and
 *     only need a "replace it" affordance
 *   - an `actions` slot for the buttons panels put beside the zone
 *     ("Load sample", "Use camera", "Open folder")
 *   - the cross tool carry chip, so a file given to one tool is one click
 *     away in the next one
 *
 * Nothing here reads or writes storage. The carried file lives in the in
 * memory store in src/lib/carry-input.ts: your files and inputs never leave
 * your device.
 */
import { computed, inject, onMounted, onUnmounted, ref, useSlots } from "vue";
import { Upload, X } from "lucide-vue-next";
import {
  clearCarriedInput,
  carriedFileMatches,
  getCarriedInput,
  setCarriedInput,
  shouldOfferCarried,
  subscribeCarriedInput,
  type CarriedInput,
} from "@/lib/carry-input";

const props = withDefaults(
  defineProps<{
    /** HTML accept filter, e.g. "image/*" or ".gpx,.kml". */
    accept?: string;
    /** Accept more than one file. */
    multiple?: boolean;
    /** Headline inside the zone. */
    label?: string;
    /** Second line, e.g. "PNG, JPEG or WebP up to 50 MB". */
    hint?: string;
    disabled?: boolean;
    /** Listen for document paste events carrying files while mounted. */
    paste?: boolean;
    /** Single line variant for a zone that only replaces an existing file. */
    compact?: boolean;
    /** Pick a whole folder (webkitdirectory). */
    directory?: boolean;
    /**
     * Drop the zone's own padding, for a default slot body that brings its own
     * layout. Without it a rich body has to fight the padding, which is what
     * `compact` was being misused for.
     */
    bare?: boolean;
  }>(),
  {
    accept: undefined,
    multiple: false,
    label: "Drop a file here or click to choose",
    hint: undefined,
    disabled: false,
    paste: true,
    compact: false,
    directory: false,
    bare: false,
  },
);

const emit = defineEmits<{ files: [files: File[]] }>();

const slots = useSlots();

/* PanelHost provides both. Outside a panel they are empty and the carry
   store is left alone, because an unnamed source reads as nonsense in the
   chip on the next tool. */
const toolSlug = inject("toolSlug", "");
const toolName = inject("toolName", "");

const inputEl = ref<HTMLInputElement | null>(null);
/** The wrapper element, so the shared paste listener can tell where focus is. */
const rootEl = ref<HTMLElement | null>(null);
const dragDepth = ref(0);
const dragging = computed(() => dragDepth.value > 0 && !props.disabled);

/* A folder picker is always multi file, whatever the caller asked for. */
const acceptsMany = computed(() => props.multiple || props.directory);

/* webkitdirectory is not in Vue's typed attribute set, so bind it as an
   object: one attribute, no cast, still type checked at the call sites. */
const extraInputAttrs = computed(() => (props.directory ? { webkitdirectory: "" } : {}));

const ariaLabel = computed(() => {
  if (!props.hint) return props.label;
  const head = props.label.replace(/[.!?]\s*$/, "");
  return `${head}. ${props.hint}`;
});

/* ---------------------------------------------------------------- */
/* carried input                                                     */
/* ---------------------------------------------------------------- */

const carried = ref<CarriedInput | null>(getCarriedInput());
let unsubscribe: (() => void) | null = null;

const carriedOffer = computed(() => {
  const value = carried.value;
  if (!value || props.disabled) return null;
  if (!shouldOfferCarried(value, toolSlug)) return null;
  if (!carriedFileMatches(value, props.accept)) return null;
  return value.file ? { file: value.file, fromName: value.fromName } : null;
});

function useCarried(): void {
  const offer = carriedOffer.value;
  if (!offer) return;
  emitFiles([offer.file]);
}

function dismissCarried(): void {
  clearCarriedInput();
}

/* ---------------------------------------------------------------- */
/* files in                                                          */
/* ---------------------------------------------------------------- */

function emitFiles(list: File[]): void {
  const files = acceptsMany.value ? list : list.slice(0, 1);
  if (files.length === 0) return;
  emit("files", files);
  const first = files[0];
  if (toolSlug && first) {
    setCarriedInput({
      kind: "file",
      file: first,
      fromSlug: toolSlug,
      fromName: toolName,
      at: Date.now(),
    });
  }
}

/**
 * Open the file picker. Exposed two ways, because a click on a button inside
 * the zone deliberately does not reach the zone's own handler: as a scoped
 * slot prop (`<template #default="{ open }">`) for a custom body, and through
 * a template ref (`dropRef.open()`) for a button that lives outside the zone.
 */
function openPicker(): void {
  if (props.disabled) return;
  inputEl.value?.click();
}

defineExpose({ open: openPicker });

function onPick(event: Event): void {
  const el = event.target as HTMLInputElement;
  emitFiles(Array.from(el.files ?? []));
  // Reset so picking the same file again still fires a change event.
  el.value = "";
}

function onDrop(event: DragEvent): void {
  dragDepth.value = 0;
  if (props.disabled) return;
  emitFiles(Array.from(event.dataTransfer?.files ?? []));
}

function onDragEnter(): void {
  if (props.disabled) return;
  dragDepth.value += 1;
}

/* Moving over a child fires dragleave on the parent, so count enters and
   leaves instead of trusting a single flag. */
function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

/* ---------------------------------------------------------------- */
/* activation                                                        */
/* ---------------------------------------------------------------- */

/* The zone behaves like a button, but the actions slot puts real buttons
   inside it. A click that started on one of those is theirs, not ours. */
function onZoneClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  if (target?.closest("button, a, input, label, select, textarea")) return;
  openPicker();
}

function onZoneKey(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  openPicker();
}

/* ---------------------------------------------------------------- */
/* paste                                                             */
/* ---------------------------------------------------------------- */

const pasteTarget: PasteTarget = {
  root: () => rootEl.value,
  enabled: () => props.paste && !props.disabled,
  handle: (files) => emitFiles(files),
};

onMounted(() => {
  unsubscribe = subscribeCarriedInput((value) => {
    carried.value = value;
  });
  addPasteTarget(pasteTarget);
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
  removePasteTarget(pasteTarget);
});
</script>

<template>
  <div ref="rootEl" class="flex flex-col gap-2">
    <div
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-label="ariaLabel"
      :aria-disabled="disabled ? 'true' : undefined"
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)] transition-colors duration-[120ms] ease-out"
      :class="[
        dragging ? 'ring-2 ring-ring' : '',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-accent',
        bare ? '' : compact ? 'px-3 py-2' : 'px-4 py-6',
      ]"
      @click="onZoneClick"
      @keydown.enter="onZoneKey"
      @keydown.space="onZoneKey"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <input
        ref="inputEl"
        type="file"
        class="hidden"
        :accept="accept"
        :multiple="acceptsMany"
        :disabled="disabled"
        v-bind="extraInputAttrs"
        @change="onPick"
      />

      <slot :open="openPicker">
        <div
          v-if="compact"
          class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          data-testid="filedrop-body"
        >
          <Upload class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 truncate font-medium">{{ label }}</span>
          <span v-if="hint" class="min-w-0 truncate text-xs text-muted-foreground">
            {{ hint }}
          </span>
          <div v-if="slots.actions" class="ml-auto flex items-center gap-1">
            <slot name="actions" />
          </div>
        </div>

        <div
          v-else
          class="flex flex-col items-center gap-1.5 text-center"
          data-testid="filedrop-body"
        >
          <Upload class="size-5 text-muted-foreground" aria-hidden="true" />
          <p class="text-sm font-medium">{{ label }}</p>
          <p v-if="hint" class="max-w-[52ch] text-xs text-muted-foreground">{{ hint }}</p>
          <div v-if="slots.actions" class="mt-1.5 flex flex-wrap items-center justify-center gap-2">
            <slot name="actions" />
          </div>
        </div>
      </slot>

      <!-- A custom body replaces the built in one, actions outlet included, so
           the outlet is rendered again here for that case. Exactly one of the
           two ever renders: this one only when the default slot took over. -->
      <div
        v-if="slots.default && slots.actions"
        class="mt-2 flex flex-wrap items-center gap-2"
        :class="compact ? '' : 'justify-center'"
      >
        <slot name="actions" />
      </div>
    </div>

    <!-- Cross tool carry: the file the last tool held, one click away. -->
    <span
      v-if="carriedOffer"
      class="inline-flex max-w-full items-center gap-1 self-start rounded-[8px] border bg-card py-1 pr-1 pl-1 text-xs shadow-[var(--sh-sm)]"
    >
      <button
        type="button"
        class="min-w-0 truncate rounded-[6px] px-1.5 py-0.5 font-medium transition-colors duration-[120ms] hover:bg-secondary"
        @click="useCarried"
      >
        Use {{ carriedOffer.file.name }} from {{ carriedOffer.fromName }}
      </button>
      <button
        type="button"
        aria-label="Dismiss the carried file"
        class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-[120ms] hover:bg-secondary hover:text-foreground"
        @click="dismissCarried"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </span>
  </div>
</template>
