<script setup lang="ts">
import { computed, ref } from "vue";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { run, type PrivacyLevel } from "@/tools/http-header-inspector/index";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import OutputView from "../OutputView.vue";
import { Loader2, RefreshCw } from "lucide-vue-next";

/**
 * Bespoke panel for the HTTP Header Inspector.
 *
 * Two tabs feed the same pure run() function: "My headers" fetches this
 * site's own /api/http-header-inspector endpoint (a click-to-fire GET, never
 * on mount, so the server rendered shell never touches fetch), and "Paste
 * headers" analyzes text typed or pasted in, only on an explicit click.
 * Switching the view selector never refetches or reruns the network call: it
 * just recomputes run() over whichever text is already loaded.
 *
 * The explained view needs structured rows (name, value, explanation, a
 * privacy badge), but run() returns that as one bracket tagged string per
 * row so it stays a plain Record<string,string> for the generic ToolShell
 * and the curl API. This panel parses that tagged text back into rows
 * instead of duplicating HEADER_DOCS or its casing table.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * view select (explained / raw / curl)
 * ------------------------------------------------------------------ */

const viewSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "view");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "view",
    label: "View",
    default: "explained",
    options: [
      { value: "explained", label: "Explained", synonyms: ["annotated", "with descriptions"] },
      { value: "raw", label: "Raw values", synonyms: ["values only", "plain"] },
      { value: "curl", label: "As curl command", synonyms: ["curl", "shell command"] },
    ],
  };
});

const view = ref("explained");

/* ------------------------------------------------------------------ *
 * tabs and their source text
 * ------------------------------------------------------------------ */

const activeTab = ref("fetch");

const fetchedText = ref<string | null>(null);
const fetchLoading = ref(false);
const fetchError = ref<{ message: string; fix?: string } | null>(null);

const pasteText = ref("");
const lastPasteText = ref<string | null>(null);
const pasteError = ref<{ message: string; fix?: string } | null>(null);

async function fetchHeaders() {
  fetchLoading.value = true;
  fetchError.value = null;
  try {
    const response = await fetch("/api/http-header-inspector", {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      fetchError.value = {
        message: `The request failed with HTTP ${response.status}.`,
        fix: "Try again in a moment.",
      };
      return;
    }
    fetchedText.value = await response.text();
  } catch {
    fetchError.value = {
      message: "The request did not complete.",
      fix: "Check your connection and try again.",
    };
  } finally {
    fetchLoading.value = false;
  }
}

function analyzePaste() {
  pasteError.value = null;
  const text = pasteText.value.trim();
  if (!text) {
    pasteError.value = {
      message: "Paste header text first.",
      fix: 'Try "Name: value" lines, one per line (a curl -v transcript works too), or a JSON object of headers.',
    };
    return;
  }
  lastPasteText.value = text;
}

/* ------------------------------------------------------------------ *
 * run() over whichever text is loaded, reparsed into structured rows
 * for the explained view
 * ------------------------------------------------------------------ */

interface ExplainedRow {
  name: string;
  value: string;
  explanation: string;
  privacy: PrivacyLevel | null;
}

interface Analysis {
  error: { message: string; fix?: string } | null;
  raw: string | Record<string, string> | null;
  explainedRows: ExplainedRow[];
  summaryText: string | null;
}

const EMPTY_ANALYSIS: Analysis = { error: null, raw: null, explainedRows: [], summaryText: null };

/** Splits one explained-view row's value back into the raw value, the
 * explanation, and the privacy tag, undoing the "value [explanation]
 * [privacy: level]" format run() builds for the generic ToolShell. */
function parseExplainedRow(name: string, raw: string): ExplainedRow {
  let text = raw;
  let privacy: PrivacyLevel | null = null;
  const privacyMatch = text.match(/ \[privacy: (low|medium|high)\]$/);
  if (privacyMatch) {
    privacy = privacyMatch[1] as PrivacyLevel;
    text = text.slice(0, text.length - privacyMatch[0].length);
  }
  const lastBracket = text.lastIndexOf(" [");
  if (lastBracket === -1 || !text.endsWith("]")) {
    return { name, value: text, explanation: "", privacy };
  }
  return {
    name,
    value: text.slice(0, lastBracket),
    explanation: text.slice(lastBracket + 2, text.length - 1),
    privacy,
  };
}

function analyzeText(text: string | null, viewValue: string): Analysis {
  if (!text) return EMPTY_ANALYSIS;
  try {
    const output = run(text, { view: viewValue });
    if (viewValue !== "explained" || typeof output === "string") {
      return { error: null, raw: output, explainedRows: [], summaryText: null };
    }
    const rows = Object.entries(output)
      .filter(([name]) => name !== "Summary")
      .map(([name, value]) => parseExplainedRow(name, value));
    return { error: null, raw: null, explainedRows: rows, summaryText: output.Summary ?? null };
  } catch (err) {
    if (err instanceof ToolError) {
      return { error: { message: err.message, fix: err.fix }, raw: null, explainedRows: [], summaryText: null };
    }
    return {
      error: { message: err instanceof Error ? err.message : "That could not be analyzed." },
      raw: null,
      explainedRows: [],
      summaryText: null,
    };
  }
}

const fetchAnalysis = computed(() => analyzeText(fetchedText.value, view.value));
const pasteAnalysis = computed(() => analyzeText(lastPasteText.value, view.value));

const activeAnalysis = computed(() =>
  activeTab.value === "fetch" ? fetchAnalysis.value : pasteAnalysis.value,
);
const activeHasResult = computed(() =>
  activeTab.value === "fetch" ? fetchedText.value !== null : lastPasteText.value !== null,
);

/* ------------------------------------------------------------------ *
 * privacy badge styling, DESIGN token colored
 * ------------------------------------------------------------------ */

const PRIVACY_LABEL: Record<PrivacyLevel, string> = { low: "Low", medium: "Medium", high: "High" };

const PRIVACY_BADGE_CLASS: Record<PrivacyLevel, string> = {
  low: "bg-[var(--positive-soft)] text-[var(--positive)]",
  medium: "bg-[var(--accent-soft)] text-primary",
  high: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="activeTab" class="w-full">
      <TabsList class="flex w-full flex-wrap">
        <TabsTrigger value="fetch">My headers</TabsTrigger>
        <TabsTrigger value="paste">Paste headers</TabsTrigger>
      </TabsList>

      <TabsContent value="fetch" class="flex flex-col gap-3 pt-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs text-muted-foreground">
            Nothing runs until you press the button. This fetches the headers your browser just
            sent to this site's own worker for this request.
          </p>
          <Button :disabled="fetchLoading" @click="fetchHeaders">
            <Loader2 v-if="fetchLoading" class="size-3.5 animate-spin" aria-hidden="true" />
            <RefreshCw v-else class="size-3.5" aria-hidden="true" />
            {{
              fetchLoading ? "Fetching…" : fetchedText ? "Refresh my headers" : "Show my headers"
            }}
          </Button>
        </div>

        <div
          v-if="fetchError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ fetchError.message }}</span>
          <span v-if="fetchError.fix" class="text-muted-foreground">{{ fetchError.fix }}</span>
        </div>
      </TabsContent>

      <TabsContent value="paste" class="flex flex-col gap-3 pt-4">
        <div class="flex flex-col gap-1.5">
          <Label for="hi-paste" class="text-xs text-muted-foreground">Header text</Label>
          <Textarea
            id="hi-paste"
            v-model="pasteText"
            rows="8"
            class="font-mono text-xs"
            spellcheck="false"
            placeholder='Name: value, one per line (a curl -v transcript works too), or a JSON object like {"user-agent": "..."}'
          />
        </div>
        <div class="flex justify-end">
          <Button type="button" @click="analyzePaste">Analyze headers</Button>
        </div>

        <div
          v-if="pasteError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ pasteError.message }}</span>
          <span v-if="pasteError.fix" class="text-muted-foreground">{{ pasteError.fix }}</span>
        </div>
      </TabsContent>
    </Tabs>

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>

    <p
      v-if="!activeHasResult"
      class="rounded-[10px] bg-secondary p-4 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
    >
      Nothing has run yet. Click "Show my headers" above, or paste header text and click
      "Analyze headers", to see results here.
    </p>

    <template v-else>
      <div
        v-if="activeAnalysis.error"
        role="alert"
        class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
      >
        <span class="font-semibold text-destructive">{{ activeAnalysis.error.message }}</span>
        <span v-if="activeAnalysis.error.fix" class="text-muted-foreground">{{
          activeAnalysis.error.fix
        }}</span>
      </div>

      <template v-else>
        <div class="flex flex-col gap-1.5 sm:w-56">
          <Label for="hi-view" class="text-xs text-muted-foreground">View</Label>
          <SearchableSelect
            id="hi-view"
            :spec="viewSpec"
            :model-value="view"
            @update:model-value="(v: string) => (view = v)"
          />
        </div>

        <template v-if="view === 'explained'">
          <div
            v-if="activeAnalysis.summaryText"
            class="flex flex-col gap-1 rounded-[14px] border border-primary/40 p-4 shadow-[var(--sh-sm)] ring-1 ring-primary/20"
          >
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >Summary</span
            >
            <p class="text-sm">{{ activeAnalysis.summaryText }}</p>
          </div>

          <div class="flex flex-col gap-2">
            <div
              v-for="row in activeAnalysis.explainedRows"
              :key="row.name"
              class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono text-sm font-semibold">{{ row.name }}</span>
                <Badge
                  v-if="row.privacy"
                  variant="outline"
                  :class="PRIVACY_BADGE_CLASS[row.privacy]"
                >
                  {{ PRIVACY_LABEL[row.privacy] }}
                </Badge>
                <Badge v-else variant="outline" class="text-muted-foreground">Unlisted</Badge>
              </div>
              <div class="flex items-start justify-between gap-2">
                <span class="min-w-0 flex-1 font-mono text-sm break-words whitespace-pre-wrap">{{
                  row.value
                }}</span>
                <CopyButton :text="row.value" />
              </div>
              <p v-if="row.explanation" class="text-xs text-muted-foreground">
                {{ row.explanation }}
              </p>
            </div>
          </div>
        </template>

        <OutputView v-else :output="activeAnalysis.raw!" />
      </template>
    </template>
  </div>
</template>
