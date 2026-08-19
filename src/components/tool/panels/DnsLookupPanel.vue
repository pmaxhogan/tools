<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ToolMeta, SelectOption, SelectOptionSpec } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  RESOLVERS,
  RECORD_TYPES,
  run,
  parseDohResponse,
  normalizeInput,
  isIPv4,
  isIPv6,
  toPtrName,
} from "@/tools/dns-lookup/index";
import type { ParsedDoh, DnsLookupResult } from "@/tools/dns-lookup/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "@/components/tool/CopyButton.vue";
import { Check, RefreshCw, Search, TriangleAlert } from "lucide-vue-next";

/**
 * Bespoke panel for DNS Lookup. Sibling of DnsPropagationPanel, scaled down to
 * one resolver: same structure, styling, and fetch conventions, but a single
 * query instead of a three way comparison.
 *
 * The pure layer (PROJECT.md rule 27) builds the DoH request URL, validates
 * the domain or IP, and parses the JSON response. This panel owns the one
 * thing it cannot: the network. Every fetch happens inside a submit or
 * refresh handler, never at setup time, so the server rendered shell never
 * touches window or fetch.
 *
 * `run()` is called with the plain text input (not the JSON path) purely to
 * reuse its validation and request URL building, the same normalizeInput,
 * IP detection, and PTR override logic that buildQueryUrl relies on, so
 * nothing here re-implements the hostname or IP address rules. The actual
 * fetch and rendering then use parseDohResponse directly so every answer can
 * be shown as its own row with a copy button, matching DnsPropagationPanel.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * resolver and record type selects
 * ------------------------------------------------------------------ */

function metaSelectSpec(id: string): SelectOptionSpec | null {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === id);
  return found && found.kind === "select" ? found : null;
}

/** The resolver dropdown: the meta's curated labels first, then any
 * RESOLVERS entry the meta has not caught up with, so the list always
 * covers exactly what can be queried. */
const resolverSpec = computed<SelectOptionSpec>(() => {
  const base = metaSelectSpec("resolver");
  const fromMeta = (base?.options ?? []).filter((o) => RESOLVERS.some((r) => r.id === o.value));
  const seen = new Set(fromMeta.map((o) => o.value));
  const rest: SelectOption[] = [];
  for (const r of RESOLVERS) {
    if (seen.has(r.id)) continue;
    rest.push({ value: r.id, label: r.label, synonyms: [r.label.toLowerCase()] });
  }
  return {
    kind: "select",
    id: "resolver",
    label: base?.label ?? "Resolver",
    default: "cloudflare",
    options: [...fromMeta, ...rest],
  };
});

/** The record type dropdown, built the same defensive way against
 * RECORD_TYPES, the source of truth for what can be queried. */
const typeSpec = computed<SelectOptionSpec>(() => {
  const base = metaSelectSpec("type");
  const fromMeta = (base?.options ?? []).filter((o) =>
    (RECORD_TYPES as readonly string[]).includes(o.value),
  );
  const seen = new Set(fromMeta.map((o) => o.value));
  const rest: SelectOption[] = [];
  for (const t of RECORD_TYPES) {
    if (seen.has(t)) continue;
    rest.push({ value: t, label: t, synonyms: [t.toLowerCase()] });
  }
  return {
    kind: "select",
    id: "type",
    label: base?.label ?? "Record type",
    default: "A",
    options: [...fromMeta, ...rest],
  };
});

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface LastQuery {
  requestUrl: string;
  resolverLabel: string;
  /** Set when the input was an IP address and the query used PTR instead of,
   * or in addition to confirming, the selected record type. */
  reverseNote: string | null;
}

const domain = ref("");
const type = ref("A");
const resolver = ref("cloudflare");

const lastQuery = ref<LastQuery | null>(null);
const parsed = ref<ParsedDoh | null>(null);
const running = ref(false);
const inputError = ref<{ message: string; fix?: string } | null>(null);
const networkError = ref<{ message: string; detail: string } | null>(null);

/** Guards against a refresh started while an earlier run is still settling
 * overwriting the newer results with the old ones. */
let seq = 0;

/** Live hint shown next to the record type select while typing, before the
 * lookup runs, so the PTR override is not a surprise after pressing Look up. */
const liveIpNote = computed<string | null>(() => {
  const raw = domain.value.trim();
  if (!raw) return null;
  const host = normalizeInput(raw);
  if (!host || !(isIPv4(host) || isIPv6(host))) return null;
  try {
    return `This is an IP address, so the lookup will use PTR (reverse) at ${toPtrName(host)}.`;
  } catch {
    return "This is an IP address, so the lookup will use PTR (reverse).";
  }
});

/* ------------------------------------------------------------------ *
 * the lookup itself, the only place this panel touches the network
 * ------------------------------------------------------------------ */

async function runLookup(requestUrl: string) {
  const runId = ++seq;
  running.value = true;
  parsed.value = null;
  networkError.value = null;

  let response: Response;
  try {
    response = await fetch(requestUrl, { headers: { Accept: "application/dns-json" } });
  } catch {
    // A network failure and a blocked cross origin request are indistinguishable
    // from script, so both land here as "unreachable", separate from a valid
    // NXDOMAIN answer which arrives as a normal, successful response.
    if (runId !== seq) return;
    networkError.value = {
      message: "unreachable",
      detail:
        "The request did not complete. The resolver may be blocked on this network, by an extension, or by a cross origin policy.",
    };
    running.value = false;
    return;
  }
  if (runId !== seq) return;

  if (!response.ok) {
    networkError.value = {
      message: `HTTP ${response.status}`,
      detail: "The resolver answered, but not with a DNS response.",
    };
    running.value = false;
    return;
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    if (runId !== seq) return;
    networkError.value = { message: "unreachable", detail: "The resolver response could not be read." };
    running.value = false;
    return;
  }
  if (runId !== seq) return;

  try {
    parsed.value = parseDohResponse(body);
  } catch (err) {
    networkError.value = {
      message: "unreadable answer",
      detail: err instanceof Error ? err.message : "The resolver response could not be parsed.",
    };
  }

  running.value = false;
}

function submit() {
  inputError.value = null;
  networkError.value = null;

  let result: DnsLookupResult;
  try {
    result = run(domain.value, { type: type.value, resolver: resolver.value });
  } catch (err) {
    if (err instanceof ToolError) {
      inputError.value = { message: err.message, fix: err.fix };
    } else {
      inputError.value = {
        message: err instanceof Error ? err.message : "That lookup could not be started.",
      };
    }
    lastQuery.value = null;
    parsed.value = null;
    return;
  }

  const requestUrl = result["Request URL"];
  if (!requestUrl) {
    // run() only omits a request URL for the paste-JSON path, which this
    // panel never sends, so this is a defensive guard, not an expected path.
    inputError.value = { message: "That lookup could not be started." };
    return;
  }

  domain.value = normalizeInput(domain.value);
  lastQuery.value = {
    requestUrl,
    resolverLabel: result["Resolver"] ?? resolver.value,
    reverseNote: result["Reverse lookup"] ?? null,
  };
  writeFragment({ input: domain.value, opts: { type: type.value, resolver: resolver.value } });
  void runLookup(requestUrl);
}

function refresh() {
  const last = lastQuery.value;
  if (!last) return;
  void runLookup(last.requestUrl);
}

/* ------------------------------------------------------------------ *
 * display helpers
 * ------------------------------------------------------------------ */

function ttlLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "TTL 0s";
  if (seconds < 60) return `TTL ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `TTL ${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `TTL ${hours}h ${minutes % 60}m`;
}

const statusOk = computed(
  () => parsed.value?.statusCode === "NOERROR" && parsed.value.answers.length > 0,
);

/* ------------------------------------------------------------------ *
 * fragment prefill: read once on mount, never auto run the lookup
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  if (state.input) domain.value = state.input;
  const fromType = state.opts["type"];
  if (fromType && (RECORD_TYPES as readonly string[]).includes(fromType.toUpperCase())) {
    type.value = fromType.toUpperCase();
  }
  const fromResolver = state.opts["resolver"];
  if (fromResolver && RESOLVERS.some((r) => r.id === fromResolver)) {
    resolver.value = fromResolver;
  }
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- controls -->
    <form class="flex flex-col gap-3" @submit.prevent="submit">
      <div class="flex flex-col gap-1.5">
        <Label for="dnsl-domain" class="text-xs text-muted-foreground">Domain or IP address</Label>
        <Input
          id="dnsl-domain"
          v-model="domain"
          type="text"
          placeholder="example.com or 192.0.2.1"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="inputError ? 'true' : undefined"
        />
      </div>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex w-full flex-col gap-1.5 sm:w-56">
          <Label for="dnsl-resolver" class="text-xs text-muted-foreground">Resolver</Label>
          <SearchableSelect
            id="dnsl-resolver"
            :spec="resolverSpec"
            :model-value="resolver"
            @update:model-value="(v: string) => (resolver = v)"
          />
        </div>

        <div class="flex w-full flex-col gap-1.5 sm:w-56">
          <Label for="dnsl-type" class="text-xs text-muted-foreground">Record type</Label>
          <SearchableSelect
            id="dnsl-type"
            :spec="typeSpec"
            :model-value="type"
            @update:model-value="(v: string) => (type = v)"
          />
        </div>

        <div class="flex items-center gap-2">
          <Button type="submit" :disabled="running">
            <Search class="size-3.5" aria-hidden="true" />
            {{ running ? "Looking up…" : "Look up" }}
          </Button>
          <Button
            v-if="lastQuery"
            type="button"
            variant="outline"
            :disabled="running"
            @click="refresh"
          >
            <RefreshCw class="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>

      <p v-if="liveIpNote" class="text-xs text-muted-foreground">{{ liveIpNote }}</p>

      <div
        v-if="inputError"
        role="alert"
        class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
      >
        <span class="font-semibold text-destructive">{{ inputError.message }}</span>
        <span v-if="inputError.fix" class="text-muted-foreground">{{ inputError.fix }}</span>
      </div>

      <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
        {{ props.meta.privacyNote }}
      </p>
    </form>

    <!-- request URL, curl-friendly -->
    <div
      v-if="lastQuery"
      class="flex flex-col gap-1.5 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Request URL
        </span>
        <CopyButton :text="lastQuery.requestUrl" label="Copy" />
      </div>
      <code class="font-mono text-xs break-all">{{ lastQuery.requestUrl }}</code>
      <p v-if="lastQuery.reverseNote" class="text-xs text-muted-foreground">
        {{ lastQuery.reverseNote }}
      </p>
    </div>

    <!-- result -->
    <p v-if="running" class="text-xs text-muted-foreground">Waiting for {{ lastQuery?.resolverLabel }}…</p>

    <div
      v-else-if="networkError"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">{{ networkError.message }}</span>
      <span class="text-muted-foreground">{{ networkError.detail }}</span>
    </div>

    <div v-else-if="parsed" class="flex flex-col gap-3">
      <div
        role="status"
        class="flex flex-col gap-1 rounded-[10px] border p-3"
        :class="statusOk ? 'border-primary ring-1 ring-primary/40' : 'border-border'"
      >
        <span class="flex items-center gap-2 text-sm font-semibold">
          <Check v-if="statusOk" class="size-4 text-primary" aria-hidden="true" />
          <TriangleAlert v-else class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ parsed.status }}
        </span>
        <span v-if="parsed.question" class="text-xs text-muted-foreground">{{ parsed.question }}</span>
      </div>

      <ul v-if="parsed.answers.length > 0" class="flex flex-col gap-2">
        <li
          v-for="(answer, i) in parsed.answers"
          :key="`${answer.name}-${answer.type}-${i}`"
          class="flex items-start justify-between gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="min-w-0">
            <div class="font-mono text-sm break-words">{{ answer.data }}</div>
            <div class="text-xs text-muted-foreground">
              {{ answer.name }} · {{ answer.type }} · {{ ttlLabel(answer.ttl) }}
            </div>
          </div>
          <CopyButton :text="answer.data" />
        </li>
      </ul>
      <p v-else class="text-xs text-muted-foreground">
        No records returned. Status: {{ parsed.status }}.
      </p>
    </div>

    <p v-else-if="!inputError" class="text-xs text-muted-foreground">
      Enter a domain or IP address, pick a resolver and record type, then press Look up.
    </p>
  </div>
</template>
