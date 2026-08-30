<!-- eslint-disable vue/multi-word-component-names -- "Toaster" is the name
     this pattern has everywhere; a second word would only pad it. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Check, Info, TriangleAlert, X } from "lucide-vue-next";
import { type Toast, dismissToast, subscribeToasts } from "@/lib/toast";

/**
 * The one toast renderer for the site. Mounted once in BaseLayout.
 *
 * **Why a component in the layout can show a message raised inside a panel.**
 * Astro hydrates every island as a separate Vue app, but all of them run in one
 * JavaScript realm and Vite emits `src/lib/toast.ts` as a single shared chunk
 * with a single URL. The browser module registry evaluates that URL once and
 * returns the same instance to every importer, so the store a CopyButton writes
 * to is literally the store this component subscribes to. No custom events, no
 * window globals, no cross-island provide/inject.
 *
 * The island carries `transition:persist`, so an Astro view transition keeps
 * this app alive across navigation and a toast raised just before a click
 * survives the swap. Timers are still re-armed from `createdAt` on mount, which
 * covers the other order of events: a toast queued by a panel that hydrated
 * before this island did.
 */

const toasts = ref<readonly Toast[]>([]);
const timers = new Map<string, number>();
/** Ids under the pointer. Hovering pauses the clock so a long message is readable. */
const paused = ref(new Set<string>());

let unsubscribe: (() => void) | null = null;

function clearTimer(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    timers.delete(id);
  }
}

/** Arm the dismissal clock for whatever time this toast has left. */
function arm(entry: Toast): void {
  clearTimer(entry.id);
  const remaining = entry.createdAt + entry.durationMs - Date.now();
  timers.set(
    entry.id,
    window.setTimeout(
      () => {
        timers.delete(entry.id);
        dismissToast(entry.id);
      },
      Math.max(0, remaining),
    ),
  );
}

function pause(id: string): void {
  clearTimer(id);
  const next = new Set(paused.value);
  next.add(id);
  paused.value = next;
}

function resume(entry: Toast): void {
  const next = new Set(paused.value);
  next.delete(entry.id);
  paused.value = next;
  // Restart the full window rather than the remainder: the reader just looked
  // away, so give them the same amount of time they would have had.
  arm({ ...entry, createdAt: Date.now() });
}

onMounted(() => {
  unsubscribe = subscribeToasts((list) => {
    toasts.value = list;
    const live = new Set(list.map((t) => t.id));
    for (const id of [...timers.keys()]) if (!live.has(id)) clearTimer(id);
    for (const entry of list) {
      if (!timers.has(entry.id) && !paused.value.has(entry.id)) arm(entry);
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  for (const id of [...timers.keys()]) clearTimer(id);
});

const ICONS = { default: Info, success: Check, error: TriangleAlert } as const;
</script>

<template>
  <!--
    The live region is always in the DOM, never behind a v-if: a region that
    appears at the same moment as its first message is not reliably announced.
    The container ignores the pointer so it never covers the tool underneath;
    each toast opts back in.
  -->
  <div
    class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end sm:px-0"
    role="status"
    aria-live="polite"
    aria-atomic="false"
    data-testid="toaster"
  >
    <TransitionGroup name="toast">
      <div
        v-for="entry in toasts"
        :key="entry.id"
        class="pointer-events-auto flex w-full max-w-[22rem] min-w-0 items-start gap-2.5 rounded-[14px] border border-border bg-card px-3.5 py-3 shadow-[var(--sh-lg)] sm:w-auto sm:min-w-[16rem]"
        data-testid="toast"
        :data-variant="entry.variant"
        @pointerenter="pause(entry.id)"
        @pointerleave="resume(entry)"
        @focusin="pause(entry.id)"
        @focusout="resume(entry)"
      >
        <component
          :is="ICONS[entry.variant]"
          class="mt-px size-4 shrink-0"
          :class="
            entry.variant === 'success'
              ? 'text-[color:var(--positive)]'
              : entry.variant === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
          "
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-foreground">{{ entry.title }}</p>
          <p
            v-if="entry.description"
            class="mt-0.5 text-[13.5px] leading-[1.5] text-muted-foreground"
          >
            {{ entry.description }}
          </p>
        </div>
        <!-- No focus utilities on the dismiss button: global.css owns the one
             :focus-visible treatment (DESIGN.md), and an `outline-none` here
             would have suppressed it. -->
        <button
          type="button"
          class="-mt-0.5 -mr-1 rounded-[8px] p-1 text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground motion-reduce:transition-none"
          aria-label="Dismiss notification"
          @click="dismissToast(entry.id)"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* 160ms on transform plus opacity, the DESIGN.md budget for movement. */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 120ms ease-out,
    transform 160ms cubic-bezier(0.2, 0.7, 0.3, 1);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* Leaving toasts are taken out of flow, at their static position, so the
   survivors slide down into the gap instead of jumping. */
.toast-leave-active {
  position: absolute;
}

.toast-move {
  transition: transform 160ms cubic-bezier(0.2, 0.7, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active,
  .toast-move {
    transition: none;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
