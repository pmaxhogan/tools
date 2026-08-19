<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { SelectOption, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { run } from "@/tools/echo/index";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "@/components/tool/CopyButton.vue";
import OutputView from "@/components/tool/OutputView.vue";
import { Radio, Send, TriangleAlert } from "lucide-vue-next";

/**
 * Bespoke panel for Echo Endpoint.
 *
 * The pure layer (`src/tools/echo/index.ts`) only knows how to format an
 * EchoRequest object it is handed (rule 27); this panel owns the one thing
 * it cannot: calling /api/echo itself. Every fetch happens inside a button
 * click handler, never at setup time, so the server rendered shell never
 * touches window or fetch. Switching the format toggle re-runs run() on the
 * response already in hand instead of firing a new request.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * format toggle, sourced from meta so the labels never drift
 * ------------------------------------------------------------------ */

const FORMAT_FALLBACK: SelectOption[] = [
  { value: "json", label: "JSON", synonyms: ["pretty json", "raw json"] },
  { value: "text", label: "Plain text", synonyms: ["plain", "txt", "lines"] },
  { value: "table", label: "Table", synonyms: ["rows", "record", "key value"] },
];

const formatOptions = computed<SelectOption[]>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "format");
  const spec = found && found.kind === "select" ? found : null;
  return spec?.options ?? FORMAT_FALLBACK;
});

/** Starts on "table" per spec: the first call renders as rows, and the
 * toggle only changes how the same cached response is displayed. */
const format = ref("table");

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const postBody = ref('{"hello":"world"}');

/** Raw JSON text of the last successful /api/echo response, fed through
 * run() on every render. Null before the first call: a legitimate "nothing
 * fetched yet" state, not an error. */
const lastResponseJson = ref<string | null>(null);

const loading = ref(false);
/** Which button is in flight, so only that button's label changes. */
const activeAction = ref<"get" | "post" | null>(null);
const error = ref<string | null>(null);

/** Guards against an older request settling after a newer one, so a slow GET
 * cannot overwrite the result of a POST fired after it. */
let seq = 0;

async function callEcho(method: "GET" | "POST") {
  const id = ++seq;
  error.value = null;
  loading.value = true;
  activeAction.value = method === "GET" ? "get" : "post";

  try {
    const res =
      method === "GET"
        ? await fetch("/api/echo", { method: "GET" })
        : await fetch("/api/echo", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Demo": "1" },
            body: postBody.value,
          });
    const text = await res.text();
    if (id !== seq) return;

    if (!res.ok) {
      error.value = `The endpoint answered with HTTP ${res.status}.`;
      return;
    }
    lastResponseJson.value = text;
  } catch {
    // A network failure and a blocked request are indistinguishable from
    // script, so both land here as "did not complete".
    if (id !== seq) return;
    error.value = "The request did not complete. Check your connection and try again.";
  } finally {
    if (id === seq) {
      loading.value = false;
      activeAction.value = null;
    }
  }
}

function callGet() {
  void callEcho("GET");
}

function callPost() {
  void callEcho("POST");
}

/* ------------------------------------------------------------------ *
 * feed the cached response through run(), never a new fetch
 * ------------------------------------------------------------------ */

type Formatted =
  | { kind: "ok"; output: string | Record<string, string> }
  | { kind: "error"; message: string };

const formatted = computed<Formatted | null>(() => {
  const raw = lastResponseJson.value;
  if (!raw) return null;
  try {
    return { kind: "ok", output: run(raw, { format: format.value }) };
  } catch (err) {
    if (err instanceof ToolError) return { kind: "error", message: err.message };
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "That response could not be read.",
    };
  }
});

/* ------------------------------------------------------------------ *
 * terminal card: absolute URL, computed lazily so the SSR shell never
 * touches window.location
 * ------------------------------------------------------------------ */

const origin = ref("https://tools.maxhogan.dev");

onMounted(() => {
  origin.value = window.location.origin;
});

const curlLines = computed(() => {
  const base = `${origin.value}/api/echo`;
  return [
    `curl ${base}`,
    `curl -X POST -d '{"a":1}' -H 'Content-Type: application/json' ${base}`,
    `curl -H 'X-Custom: value' ${base}`,
  ];
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>

    <!-- actions -->
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button type="button" :disabled="loading" @click="callGet">
          <Radio class="size-3.5" aria-hidden="true" />
          {{ loading && activeAction === "get" ? "Calling…" : "Call the endpoint" }}
        </Button>
      </div>

      <div class="flex flex-col gap-2">
        <Label for="echo-post-body" class="text-xs text-muted-foreground">POST body</Label>
        <Textarea
          id="echo-post-body"
          v-model="postBody"
          rows="3"
          spellcheck="false"
          class="font-mono text-xs"
        />
        <div>
          <Button type="button" variant="outline" :disabled="loading" @click="callPost">
            <Send class="size-3.5" aria-hidden="true" />
            {{ loading && activeAction === "post" ? "Sending…" : "Send a POST" }}
          </Button>
        </div>
      </div>
    </div>

    <!-- format toggle -->
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Output format">
      <Button
        v-for="opt in formatOptions"
        :key="opt.value"
        type="button"
        size="sm"
        :variant="format === opt.value ? 'default' : 'outline'"
        :aria-pressed="format === opt.value"
        @click="format = opt.value"
      >
        {{ opt.label }}
      </Button>
    </div>

    <!-- network error -->
    <div
      v-if="error"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="flex items-center gap-2 font-semibold text-destructive">
        <TriangleAlert class="size-4" aria-hidden="true" />
        {{ error }}
      </span>
    </div>

    <!-- result -->
    <OutputView v-if="formatted?.kind === 'ok'" :output="formatted.output" />

    <div
      v-else-if="formatted?.kind === 'error'"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">{{ formatted.message }}</span>
    </div>

    <p v-else-if="!error" class="text-xs text-muted-foreground">
      Press "Call the endpoint" or "Send a POST" to see the live response here.
    </p>

    <!-- terminal card -->
    <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Try it from a terminal
      </span>
      <div
        v-for="line in curlLines"
        :key="line"
        class="flex items-center justify-between gap-2"
      >
        <code class="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre">{{
          line
        }}</code>
        <CopyButton :text="line" />
      </div>
    </div>
  </div>
</template>
