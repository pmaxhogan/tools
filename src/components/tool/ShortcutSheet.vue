<script setup lang="ts">
import { computed } from "vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TOOL_SHORTCUTS, type ShortcutSpec } from "@/lib/shortcuts";

/**
 * The "?" help sheet: every shortcut in TOOL_SHORTCUTS, formatted for the
 * visitor's platform (Ctrl on Windows/Linux, Cmd on macOS/iOS). Visibility is
 * owned by the caller through `open`/`update:open`, the same controlled
 * pattern OptionControl uses for its `modelValue`, so ToolShell (and later
 * PanelHost, for bespoke panels) can open this from its own shortcut handler.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

function setOpen(value: boolean) {
  emit("update:open", value);
}

/**
 * True on macOS/iOS. Read once at module scope: this file only ever runs in
 * the browser (ShortcutSheet has no server-rendered path that needs the value
 * before mount), and a visitor does not switch platforms mid-session.
 */
const isApplePlatform =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

interface ShortcutRow {
  label: string;
  keys: string[];
}

/** The chip sequence for one shortcut: modifiers first, then the key itself. */
function keysFor(spec: ShortcutSpec): string[] {
  const keys: string[] = [];
  if (spec.ctrlOrCmd) keys.push(isApplePlatform ? "Cmd" : "Ctrl");
  if (spec.shift) keys.push("Shift");
  keys.push(spec.displayKey ?? spec.key);
  return keys;
}

const rows = computed<ShortcutRow[]>(() =>
  TOOL_SHORTCUTS.map((spec) => ({ label: spec.label, keys: keysFor(spec) })),
);
</script>

<template>
  <Dialog :open="props.open" @update:open="setOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Available on every tool page.</DialogDescription>
      </DialogHeader>
      <ul class="space-y-2.5 text-sm">
        <li v-for="row in rows" :key="row.label" class="flex items-center justify-between gap-4">
          <span class="text-muted-foreground">{{ row.label }}</span>
          <span class="flex shrink-0 items-center gap-1">
            <template v-for="(key, i) in row.keys" :key="i">
              <kbd>{{ key }}</kbd>
              <span v-if="i < row.keys.length - 1" class="text-muted-foreground" aria-hidden="true"
                >+</span
              >
            </template>
          </span>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
