<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { run, SHELF, type ShelfEntry } from "@/tools/bookmarklets/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, GripVertical, MousePointer2 } from "lucide-vue-next";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the Bookmarklet Shelf.
 *
 * Three tabs share one shape: JavaScript source in, a javascript: URL out,
 * built by the pure `run()` in the logic layer (rule 27). This panel only
 * adds the UI around that: draggable links, copy affordances, and an
 * expandable readable source view.
 *
 * On the javascript: href itself: Vue does not sanitize or warn on
 * javascript: URLs bound through :href. This was checked directly against
 * this repo's installed Vue: @vue/server-renderer's ssrRenderAttr only
 * HTML-escapes the value, and @vue/runtime-dom's patchAttr calls plain
 * el.setAttribute("href", value) with no protocol special-casing, so a
 * bound :href renders and hydrates as typed on both the server and client.
 * (The blocked-javascript-link warning some agents expect is a React
 * behavior, not a Vue one.) A plain :href binding is used below rather than
 * the imperative setAttribute-in-onMounted workaround, since there is
 * nothing here for that workaround to fix.
 */
defineProps<{ meta: ToolMeta }>();

interface ToolErrorLike {
  message: string;
  fix?: string;
}

function toToolError(e: unknown): ToolErrorLike {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/** Strips the common leading indentation off a template-literal source block
 * so the "view source" pre reads like a real file, not a nested object literal. */
function dedent(source: string): string {
  const lines = source.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.match(/^ */) ?? [""])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(min)).join("\n");
}

const tab = ref("shelf");

/* ------------------------------------------------------------------ *
 * Shelf: the nine ready made bookmarklets, encoded once at setup since
 * SHELF is static data and run() is pure.
 * ------------------------------------------------------------------ */

interface ShelfLink {
  entry: ShelfEntry;
  readable: string;
  href: string | null;
  error: ToolErrorLike | null;
  open: boolean;
}

const shelfLinks = ref<ShelfLink[]>(
  SHELF.map((entry) => {
    const readable = dedent(entry.source);
    try {
      return {
        entry,
        readable,
        href: run(entry.source, { mode: "encode" }) as string,
        error: null,
        open: false,
      };
    } catch (e) {
      return { entry, readable, href: null, error: toToolError(e), open: false };
    }
  }),
);

/* ------------------------------------------------------------------ *
 * Make your own: live encode, debounced.
 * ------------------------------------------------------------------ */

const customName = ref("Your bookmarklet");
const customSource = ref("");
const customUrl = ref<string | null>(null);
const customError = ref<ToolErrorLike | null>(null);

const customLength = computed(() => customUrl.value?.length ?? 0);

function encodeCustom() {
  if (!customSource.value.trim()) {
    customUrl.value = null;
    customError.value = null;
    return;
  }
  try {
    customUrl.value = run(customSource.value, { mode: "encode" }) as string;
    customError.value = null;
  } catch (e) {
    customUrl.value = null;
    customError.value = toToolError(e);
  }
}

let customDebounce: ReturnType<typeof setTimeout> | undefined;
watch(customSource, () => {
  clearTimeout(customDebounce);
  customDebounce = setTimeout(encodeCustom, 200);
});

/* ------------------------------------------------------------------ *
 * Decode: paste a javascript: URL, read the source back out.
 * ------------------------------------------------------------------ */

const decodeInput = ref("");
const decodedSource = ref<string | null>(null);
const decodeError = ref<ToolErrorLike | null>(null);

function decodeNow() {
  if (!decodeInput.value.trim()) {
    decodedSource.value = null;
    decodeError.value = null;
    return;
  }
  try {
    decodedSource.value = run(decodeInput.value, { mode: "decode" }) as string;
    decodeError.value = null;
  } catch (e) {
    decodedSource.value = null;
    decodeError.value = toToolError(e);
  }
}

let decodeDebounce: ReturnType<typeof setTimeout> | undefined;
watch(decodeInput, () => {
  clearTimeout(decodeDebounce);
  decodeDebounce = setTimeout(decodeNow, 200);
});

onUnmounted(() => {
  clearTimeout(customDebounce);
  clearTimeout(decodeDebounce);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="shelf"> Shelf </TabsTrigger>
        <TabsTrigger value="custom"> Make your own </TabsTrigger>
        <TabsTrigger value="decode"> Decode </TabsTrigger>
      </TabsList>

      <!-- Shelf -->
      <TabsContent value="shelf" class="flex flex-col gap-3 pt-4">
        <div
          class="flex items-center gap-2 rounded-[10px] border border-primary/30 bg-[var(--accent-soft)] px-3 py-2 text-sm text-primary"
        >
          <MousePointer2 class="size-4 shrink-0" aria-hidden="true" />
          <span>Drag a button to your bookmarks bar, then click it on any page.</span>
        </div>

        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div
            v-for="link in shelfLinks"
            :key="link.entry.name"
            class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <!-- This is our own generated bookmarklet source, never user input,
                   so binding it straight to href needs no extra sanitization. -->
              <a
                v-if="link.href"
                :href="link.href"
                draggable="true"
                class="inline-flex cursor-grab items-center gap-1.5 rounded-[8px] border border-primary/30 bg-card px-3 py-1.5 text-sm font-semibold text-primary shadow-[var(--sh-sm)] outline-none active:cursor-grabbing focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <GripVertical class="size-3.5 shrink-0" aria-hidden="true" />
                {{ link.entry.name }}
              </a>
              <span v-else class="text-sm font-semibold text-destructive">
                {{ link.entry.name }}
              </span>
              <CopyButton v-if="link.href" :text="link.href" label="Copy URL" />
            </div>

            <p class="text-sm text-muted-foreground">{{ link.entry.description }}</p>

            <ErrorBanner v-if="link.error" :message="link.error.message" :hint="link.error.fix" />

            <div>
              <Button variant="ghost" size="sm" @click="link.open = !link.open">
                <ChevronDown
                  class="size-3.5 transition-transform duration-[120ms]"
                  :class="link.open ? 'rotate-180' : ''"
                  aria-hidden="true"
                />
                {{ link.open ? "Hide source" : "View source" }}
              </Button>
              <pre
                v-if="link.open"
                class="mt-2 overflow-x-auto rounded-[8px] bg-background p-3 font-mono text-xs shadow-[var(--sh-inset)]"
                >{{ link.readable }}</pre>
            </div>
          </div>
        </div>
      </TabsContent>

      <!-- Make your own -->
      <TabsContent value="custom" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-col gap-1.5">
            <Label for="bm-custom-name" class="text-xs text-muted-foreground">Bookmark name</Label>
            <Input
              id="bm-custom-name"
              v-model="customName"
              placeholder="Your bookmarklet"
              class="h-9 bg-card"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="bm-custom-source" class="text-xs text-muted-foreground">
              JavaScript source
            </Label>
            <Textarea
              id="bm-custom-source"
              v-model="customSource"
              spellcheck="false"
              placeholder="alert('hello from a bookmarklet');"
              class="min-h-40 bg-card font-mono text-xs"
            />
          </div>

          <ErrorBanner v-if="customError" :message="customError.message" :hint="customError.fix" />

          <template v-if="customUrl">
            <div class="flex flex-col gap-1.5">
              <span class="text-xs text-muted-foreground">Bookmarklet URL</span>
              <div
                class="flex items-start gap-2 rounded-[8px] bg-card p-2 shadow-[var(--sh-inset)]"
              >
                <pre
                  class="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap"
                  >{{ customUrl }}</pre>
                <CopyButton :text="customUrl" label="Copy URL" />
              </div>
            </div>

            <div>
              <!-- Generated from the reader's own textarea, never rendered as HTML,
                   so it carries no more risk than any other bookmarklet on this page. -->
              <a
                :href="customUrl"
                draggable="true"
                class="inline-flex cursor-grab items-center gap-1.5 rounded-[8px] border border-primary/30 bg-card px-3 py-1.5 text-sm font-semibold text-primary shadow-[var(--sh-sm)] outline-none active:cursor-grabbing focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <GripVertical class="size-3.5 shrink-0" aria-hidden="true" />
                {{ customName.trim() || "Your bookmarklet" }}
              </a>
            </div>
          </template>

          <p class="text-xs text-muted-foreground tabular-nums">{{ customLength }} characters</p>
        </div>
      </TabsContent>

      <!-- Decode -->
      <TabsContent value="decode" class="pt-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-col gap-1.5">
            <Label for="bm-decode-input" class="text-xs text-muted-foreground">
              Bookmarklet URL
            </Label>
            <Textarea
              id="bm-decode-input"
              v-model="decodeInput"
              spellcheck="false"
              placeholder="javascript:(() =&gt; { ... })()"
              class="min-h-24 bg-card font-mono text-xs"
            />
          </div>

          <ErrorBanner v-if="decodeError" :message="decodeError.message" :hint="decodeError.fix" />

          <div v-if="decodedSource" class="flex flex-col gap-1.5">
            <span class="text-xs text-muted-foreground">Decoded source</span>
            <div class="flex items-start gap-2 rounded-[8px] bg-card p-2 shadow-[var(--sh-inset)]">
              <pre class="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">{{
                decodedSource
              }}</pre>
              <CopyButton :text="decodedSource" label="Copy source" />
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>

    <p class="text-xs text-muted-foreground">
      {{
        meta.privacyNote ??
        "Every bookmarklet here runs entirely in your browser, so your files and inputs never leave your device."
      }}
    </p>
  </div>
</template>
