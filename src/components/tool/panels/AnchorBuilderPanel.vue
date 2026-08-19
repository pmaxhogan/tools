<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  run,
  normalizeAnchorName,
  SUPPORT_NOTES,
  type AnchorPositioningOpts,
} from "@/tools/css-anchor-positioning-builder/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for the CSS Anchor Positioning Builder.
 *
 * The pure layer (PROJECT.md rule 27) builds the whole HTML plus CSS document
 * and owns every option rule; this panel only renders it. The one thing it adds
 * is a live preview, which the generic ToolShell cannot give: the generated
 * snippet has to run somewhere, and running it inside the page would leak its
 * class names and its @position-try rules into the site's own stylesheet.
 *
 * The preview is a fully sandboxed iframe (sandbox="", so no script, no form
 * submission, no same origin access) driven by srcdoc. Nothing in the generated
 * code needs script: popovertarget opens a popover declaratively, and hover or
 * focus reveals the non popover patterns, so a script free frame still shows
 * the real behavior. No network request is involved at any point.
 */
const props = defineProps<{ meta: ToolMeta }>();

interface PanelError {
  message: string;
  fix?: string;
}

interface Generated {
  /** The full run() output, separator included. This is what "Copy all" copies. */
  code: string;
  /** The HTML snippet: everything before the CSS separator. */
  html: string;
  /** The stylesheet: everything after it. */
  css: string;
  /** id of the positioned element, used to style the preview's menu items. */
  elementId: string;
  /** The anchor name with its two leading dashes, for example "--tip". */
  resolvedName: string;
  /** The same name without them, the prefix every generated class shares. */
  base: string;
}

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

const anchorName = ref("");
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

/** Legal values for one of the meta selects, used to vet a shared link. */
function optionValues(id: string): string[] {
  const spec = props.meta.options?.find((o) => o.id === id);
  if (!spec || spec.kind !== "select") return [];
  return (spec.options ?? []).map((o) => o.value);
}

/* ------------------------------------------------------------------ *
 * debounced snapshot: what the generator actually sees
 * ------------------------------------------------------------------ */

interface Snapshot {
  name: string;
  opts: AnchorPositioningOpts;
}

/**
 * Seeded synchronously from the defaults, so the code blocks render on the
 * server too: generating is pure, with no clock to debounce against and no DOM
 * to read.
 */
const snapshot = ref<Snapshot>({
  name: "",
  opts: { ...opts.value } as AnchorPositioningOpts,
});

let timer: ReturnType<typeof setTimeout> | undefined;

function commit(): void {
  snapshot.value = { name: anchorName.value, opts: { ...opts.value } as AnchorPositioningOpts };
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    commit();
    writeFragment({
      input: anchorName.value.trim() || undefined,
      opts: {
        pattern: String(opts.value.pattern ?? ""),
        area: String(opts.value.area ?? ""),
      },
    });
  }, 200);
}

watch([anchorName, opts], schedule, { deep: true });

/* ------------------------------------------------------------------ *
 * generation
 * ------------------------------------------------------------------ */

/** The separator the logic layer writes between the markup and the stylesheet. */
const CSS_SEPARATOR = /^\/\* =+ CSS =+ \*\/$/m;

function splitOutput(code: string): { html: string; css: string } {
  const match = CSS_SEPARATOR.exec(code);
  if (!match) return { html: code, css: "" };
  return {
    html: code.slice(0, match.index).trimEnd(),
    css: code.slice(match.index + match[0].length).replace(/^\n+/, ""),
  };
}

function readElementId(html: string): string {
  return /\bid="([^"]+)"/.exec(html)?.[1] ?? "";
}

function readError(e: unknown): PanelError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

const build = computed<{ value: Generated | null; error: PanelError | null }>(() => {
  try {
    const resolvedName = normalizeAnchorName(snapshot.value.name);
    const code = run(snapshot.value.name, snapshot.value.opts);
    const { html, css } = splitOutput(code);
    return {
      value: {
        code,
        html,
        css,
        elementId: readElementId(html),
        resolvedName,
        base: resolvedName.slice(2),
      },
      error: null,
    };
  } catch (e) {
    return { value: null, error: readError(e) };
  }
});

const generated = computed(() => build.value.value);
const error = computed(() => build.value.error);

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

/** Mirrors the site theme so the frame does not flash white on a dark page. */
const isDark = ref(false);
/** null until mounted: the panel never guesses support on the server. */
const supportsAnchor = ref<boolean | null>(null);

let themeWatcher: MutationObserver | null = null;

/**
 * Just enough style to make the frame read as a page rather than a raw user
 * agent document. Only the trigger and the menu items are touched: every rule
 * that does the positioning comes from the generated stylesheet, so the preview
 * shows what the copied code actually does.
 */
function previewBaseCss(g: Generated, dark: boolean): string {
  const bg = dark ? "#1D1B18" : "#FFFFFF";
  const fg = dark ? "#EDE9E3" : "#2A2622";
  const line = dark ? "#403A33" : "#D8D1C6";
  const surface = dark ? "#252220" : "#F6F4F1";
  const blocks = [
    `:root { color-scheme: ${dark ? "dark" : "light"}; }`,
    "* { box-sizing: border-box; }",
    "body {\n" +
      "  margin: 0;\n" +
      `  background: ${bg};\n` +
      `  color: ${fg};\n` +
      '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;\n' +
      "  font-size: 15px;\n" +
      "  line-height: 1.5;\n" +
      "}",
    ".anchor-preview-stage {\n" +
      "  display: grid;\n" +
      "  place-items: center;\n" +
      "  min-height: 100vh;\n" +
      "  padding: 28px;\n" +
      "}",
    `.${g.base}-trigger {\n` +
      "  font: inherit;\n" +
      `  color: ${fg};\n` +
      `  background: ${surface};\n` +
      `  border: 1px solid ${line};\n` +
      "  border-radius: 8px;\n" +
      "  padding: 6px 12px;\n" +
      "  cursor: pointer;\n" +
      "}",
    `.${g.base}-trigger:focus-visible { outline: 2px solid #8A79F5; outline-offset: 2px; }`,
  ];
  if (g.elementId) {
    blocks.push(
      `#${g.elementId} button {\n` +
        "  display: block;\n" +
        "  width: 100%;\n" +
        "  font: inherit;\n" +
        "  color: inherit;\n" +
        "  text-align: left;\n" +
        "  background: transparent;\n" +
        "  border: 0;\n" +
        "  border-radius: 4px;\n" +
        "  padding: 4px 6px;\n" +
        "  cursor: pointer;\n" +
        "}",
      `#${g.elementId} button:hover { background: rgba(255, 255, 255, 0.16); }`,
      `#${g.elementId} p { margin: 0; }`,
    );
  }
  return blocks.join("\n");
}

const previewDoc = computed(() => {
  const g = generated.value;
  if (!g) return "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<style>\n${previewBaseCss(g, isDark.value)}\n</style>`,
    `<style>\n${g.css}\n</style>`,
    "</head>",
    "<body>",
    '<div class="anchor-preview-stage">',
    g.html,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
});

const previewHint = computed(() =>
  snapshot.value.opts.popoverApi === false
    ? "Hover the button in the preview, or tab to it, to reveal the positioned element."
    : "Click the button in the preview to open the positioned element.",
);

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  supportsAnchor.value =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("anchor-name: --a");

  const readTheme = () => {
    isDark.value = document.documentElement.classList.contains("dark");
  };
  readTheme();
  themeWatcher = new MutationObserver(readTheme);
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  // A shared link carries the anchor name, the pattern, and the placement.
  // Anything else in the hash is ignored, and a value the meta does not list is
  // dropped rather than handed to the generator, so an old link cannot fail on
  // load.
  const frag = readFragment();
  if (frag.input !== undefined) anchorName.value = frag.input;
  const pattern = frag.opts["pattern"];
  if (pattern && optionValues("pattern").includes(pattern)) opts.value.pattern = pattern;
  const area = frag.opts["area"];
  if (area && optionValues("area").includes(area)) opts.value.area = area;

  // Apply the link at once: the watcher above would otherwise hold the shared
  // state behind the debounce, and would then write the same hash straight back.
  if (timer) clearTimeout(timer);
  timer = undefined;
  commit();
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  themeWatcher?.disconnect();
  themeWatcher = null;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid gap-4 lg:grid-cols-2">
      <!-- controls -->
      <div class="flex flex-col gap-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="anchor-name" class="text-xs text-muted-foreground">Anchor name</Label>
          <Input
            id="anchor-name"
            v-model="anchorName"
            type="text"
            placeholder="--anchor"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="h-8"
            :aria-invalid="error ? 'true' : undefined"
          />
          <p class="text-xs text-muted-foreground">
            CSS anchor names start with two dashes, so tip becomes --tip.
            <span v-if="generated" class="font-mono">Using {{ generated.resolvedName }}.</span>
          </p>
        </div>

        <div v-if="meta.options?.length" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <OptionControl
            v-for="spec in meta.options"
            :key="spec.id"
            v-model="opts[spec.id]"
            :spec="spec"
          />
        </div>
      </div>

      <!-- live preview -->
      <div class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Live preview
          </span>
          <Badge
            v-if="supportsAnchor !== null"
            :variant="supportsAnchor ? 'default' : 'secondary'"
            class="max-w-full"
          >
            Your browser supports anchor positioning: {{ supportsAnchor ? "yes" : "no" }}
          </Badge>
        </div>

        <div class="overflow-hidden rounded-[10px] border shadow-[var(--sh-inset)]">
          <iframe
            v-if="generated"
            title="Live preview of the generated anchor positioned element"
            sandbox=""
            :srcdoc="previewDoc"
            class="block h-[300px] w-full border-0 bg-transparent"
          ></iframe>
          <p v-else class="grid h-[300px] place-items-center px-4 text-sm text-muted-foreground">
            The preview appears again once the options above produce valid CSS.
          </p>
        </div>

        <p class="text-xs text-muted-foreground">
          {{ previewHint }} The frame is fully sandboxed: it runs no script and makes no request.
        </p>
      </div>
    </div>

    <!-- input or option error -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <!-- generated code -->
    <div v-if="generated" class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Generated code
        </span>
        <CopyButton :text="generated.code" label="Copy all" />
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            HTML
          </span>
          <CopyButton :text="generated.html" label="Copy" />
        </div>
        <pre class="max-h-72 overflow-auto px-3 pb-2 font-mono text-sm whitespace-pre">{{
          generated.html
        }}</pre>
      </div>

      <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            CSS
          </span>
          <CopyButton :text="generated.css" label="Copy" />
        </div>
        <pre class="max-h-96 overflow-auto px-3 pb-2 font-mono text-sm whitespace-pre">{{
          generated.css
        }}</pre>
      </div>
    </div>

    <!-- support notes -->
    <details class="rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
      <summary class="cursor-pointer text-sm font-medium">Browser support notes</summary>
      <ul class="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
        <li v-for="note in SUPPORT_NOTES" :key="note">{{ note }}</li>
      </ul>
      <p class="mt-3 text-sm text-muted-foreground">
        Every result ends with an @supports block, so a browser without anchor positioning still
        places the element somewhere sensible.
      </p>
    </details>
  </div>
</template>
