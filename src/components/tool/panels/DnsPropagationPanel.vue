<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ToolMeta, SelectOption, SelectOptionSpec } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  RESOLVERS,
  RECORD_TYPES,
  buildQueryUrl,
  parseDohResponse,
  compareAnswers,
  assertDomain,
  assertRecordType,
} from "@/tools/dns-propagation/index";
import type { ParsedDoh, PropagationSummary, ResolverAnswers } from "@/tools/dns-propagation/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Check, RefreshCw, Search, TriangleAlert } from "lucide-vue-next";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for DNS Propagation.
 *
 * The pure layer (PROJECT.md rule 27) builds the DoH request URLs, parses the
 * JSON responses, and compares them. This panel owns the one thing it cannot:
 * the network. Every fetch happens inside a submit or refresh handler, never at
 * setup time, so the server rendered shell never touches window or fetch.
 *
 * Unlike most tools here the queries do leave the device, by design: a DNS
 * lookup is a request to a resolver. meta.privacyNote says so and the panel
 * shows it under the controls.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * record type select
 * ------------------------------------------------------------------ */

/** Labels and synonyms for the record types the meta select does not list.
 * RECORD_TYPES is the source of truth for what can be queried, so anything it
 * gains that the meta has not caught up with still shows up in the dropdown. */
const EXTRA_TYPE_OPTIONS: Record<string, SelectOption> = {
  SRV: {
    value: "SRV",
    label: "SRV (service location)",
    synonyms: ["service record", "service location", "port", "sip", "xmpp", "minecraft srv"],
  },
  PTR: {
    value: "PTR",
    label: "PTR (reverse lookup)",
    synonyms: ["reverse dns", "pointer record", "rdns", "reverse lookup"],
  },
};

const metaTypeSpec = computed<SelectOptionSpec | null>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "type");
  return found && found.kind === "select" ? found : null;
});

/** The dropdown spec: the meta's curated labels first, then any remaining
 * RECORD_TYPES entry, so the list always covers exactly what can be queried. */
const typeSpec = computed<SelectOptionSpec>(() => {
  const base = metaTypeSpec.value;
  const fromMeta = (base?.options ?? []).filter((o) =>
    (RECORD_TYPES as readonly string[]).includes(o.value),
  );
  const seen = new Set(fromMeta.map((o) => o.value));
  const rest: SelectOption[] = [];
  for (const t of RECORD_TYPES) {
    if (seen.has(t)) continue;
    rest.push(EXTRA_TYPE_OPTIONS[t] ?? { value: t, label: t, synonyms: [t.toLowerCase()] });
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

type ResolverState = "idle" | "loading" | "ok" | "error";

interface ResolverRow {
  id: string;
  label: string;
  state: ResolverState;
  parsed: ParsedDoh | null;
  /** Short reason shown when state is "error", e.g. "unreachable". */
  error: string | null;
  /** Longer explanation under the reason. */
  detail: string | null;
}

const domain = ref("");
const type = ref("A");

/** The validated query the current results belong to. Refresh replays this,
 * not whatever is in the inputs right now. */
const lastQuery = ref<{ name: string; type: string } | null>(null);

const rows = ref<ResolverRow[]>([]);
const running = ref(false);
const inputError = ref<{ message: string; fix?: string } | null>(null);

/** Guards against two runs interleaving: a refresh started while an earlier
 * run is still settling must not have its results overwritten by the old one. */
let seq = 0;

function freshRows(): ResolverRow[] {
  return RESOLVERS.map((r) => ({
    id: r.id,
    label: r.label,
    state: "loading" as ResolverState,
    parsed: null,
    error: null,
    detail: null,
  }));
}

/* ------------------------------------------------------------------ *
 * the lookup itself, the only place this panel touches the network
 * ------------------------------------------------------------------ */

async function queryResolver(
  resolverId: string,
  name: string,
  recordType: string,
): Promise<{ parsed: ParsedDoh } | { error: string; detail: string }> {
  let response: Response;
  try {
    response = await fetch(buildQueryUrl(resolverId, name, recordType), {
      headers: { Accept: "application/dns-json" },
    });
  } catch {
    // A network failure and a blocked cross origin request are indistinguishable
    // from script, so both land here as "unreachable".
    return {
      error: "unreachable",
      detail:
        "The request did not complete. The resolver may be blocked on this network, by an extension, or by a cross origin policy.",
    };
  }

  if (!response.ok) {
    return {
      error: `HTTP ${response.status}`,
      detail: "The resolver answered, but not with a DNS response.",
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { error: "unreachable", detail: "The resolver response could not be read." };
  }

  try {
    return { parsed: parseDohResponse(body) };
  } catch (err) {
    return {
      error: "unreadable answer",
      detail: err instanceof Error ? err.message : "The resolver response could not be parsed.",
    };
  }
}

async function runLookup(name: string, recordType: string) {
  const runId = ++seq;
  running.value = true;
  rows.value = freshRows();

  const results = await Promise.allSettled(
    RESOLVERS.map((r) => queryResolver(r.id, name, recordType)),
  );
  if (runId !== seq) return;

  rows.value = RESOLVERS.map((r, i) => {
    const settled = results[i];
    const base = { id: r.id, label: r.label };
    if (!settled || settled.status === "rejected") {
      return {
        ...base,
        state: "error" as ResolverState,
        parsed: null,
        error: "unreachable",
        detail: "The request did not complete.",
      };
    }
    const value = settled.value;
    if ("parsed" in value) {
      return {
        ...base,
        state: "ok" as ResolverState,
        parsed: value.parsed,
        error: null,
        detail: null,
      };
    }
    return {
      ...base,
      state: "error" as ResolverState,
      parsed: null,
      error: value.error,
      detail: value.detail,
    };
  });

  running.value = false;
}

function submit() {
  inputError.value = null;
  let name: string;
  let recordType: string;
  try {
    name = assertDomain(domain.value);
    recordType = assertRecordType(type.value);
  } catch (err) {
    if (err instanceof ToolError) {
      inputError.value = { message: err.message, fix: err.fix };
    } else {
      inputError.value = {
        message: err instanceof Error ? err.message : "That lookup could not be started.",
      };
    }
    rows.value = [];
    lastQuery.value = null;
    return;
  }

  domain.value = name;
  type.value = recordType;
  lastQuery.value = { name, type: recordType };
  writeFragment({ input: name, opts: { type: recordType } });
  void runLookup(name, recordType);
}

function refresh() {
  const last = lastQuery.value;
  if (!last) return;
  void runLookup(last.name, last.type);
}

/* ------------------------------------------------------------------ *
 * comparison
 * ------------------------------------------------------------------ */

const answeredRows = computed(() => rows.value.filter((r) => r.state === "ok" && r.parsed));

const summary = computed<PropagationSummary | null>(() => {
  if (running.value || answeredRows.value.length === 0) return null;
  const entries: ResolverAnswers[] = answeredRows.value.map((r) => ({
    id: r.id,
    parsed: r.parsed as ParsedDoh,
  }));
  return compareAnswers(entries);
});

const hasResults = computed(() => rows.value.length > 0);

const unreachableCount = computed(() => rows.value.filter((r) => r.state === "error").length);

function ttlLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "TTL 0s";
  if (seconds < 60) return `TTL ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `TTL ${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `TTL ${hours}h ${minutes % 60}m`;
}

/* ------------------------------------------------------------------ *
 * fragment prefill: read once on mount, never auto run the lookup
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  if (state.input) domain.value = state.input;
  const fromHash = state.opts["type"];
  if (fromHash && (RECORD_TYPES as readonly string[]).includes(fromHash.toUpperCase())) {
    type.value = fromHash.toUpperCase();
  }
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- controls -->
    <form class="flex flex-col gap-3" @submit.prevent="submit">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label for="dnsp-domain" class="text-xs text-muted-foreground">Domain</Label>
          <Input
            id="dnsp-domain"
            v-model="domain"
            type="text"
            placeholder="example.com"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="inputError ? 'true' : undefined"
          />
        </div>

        <div class="flex w-full flex-col gap-1.5 sm:w-56">
          <Label for="dnsp-type" class="text-xs text-muted-foreground">Record type</Label>
          <SearchableSelect
            id="dnsp-type"
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

      <ErrorBanner v-if="inputError" :message="inputError.message" :hint="inputError.fix" />

      <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
        {{ props.meta.privacyNote }}
      </p>
    </form>

    <!-- verdict -->
    <div
      v-if="summary"
      role="status"
      class="flex flex-col gap-1 rounded-[10px] border p-3"
      :class="summary.agree ? 'border-primary ring-1 ring-primary/40' : 'border-border'"
    >
      <span class="flex items-center gap-2 text-sm font-semibold">
        <Check v-if="summary.agree" class="size-4 text-primary" aria-hidden="true" />
        <TriangleAlert v-else class="size-4 text-muted-foreground" aria-hidden="true" />
        {{
          summary.agree
            ? "All resolvers agree (propagation complete)"
            : "Answers differ (still propagating)"
        }}
      </span>
      <span class="text-xs text-muted-foreground">{{ summary.note }}</span>
      <span v-if="unreachableCount > 0" class="text-xs text-muted-foreground">
        {{ unreachableCount }} of {{ rows.length }} resolvers could not be reached, so this verdict
        covers the rest.
      </span>
    </div>

    <!-- per resolver comparison -->
    <div v-if="hasResults" class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div
        v-for="row in rows"
        :key="row.id"
        class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ row.label }}
          </span>
          <span
            class="rounded-full border px-2 py-0.5 text-[0.65rem] font-medium"
            :class="
              row.state === 'error'
                ? 'border-destructive/40 text-destructive'
                : 'border-border text-muted-foreground'
            "
          >
            {{
              row.state === "loading"
                ? "querying…"
                : row.state === "error"
                  ? row.error
                  : (row.parsed?.statusCode ?? "")
            }}
          </span>
        </div>

        <p v-if="row.state === 'loading'" class="text-xs text-muted-foreground">
          Waiting for an answer…
        </p>

        <p v-else-if="row.state === 'error'" class="text-xs text-muted-foreground">
          {{ row.detail }}
        </p>

        <template v-else-if="row.parsed">
          <ul v-if="row.parsed.answers.length > 0" class="flex flex-col gap-2">
            <li v-for="(answer, i) in row.parsed.answers" :key="`${row.id}-${i}`" class="min-w-0">
              <div class="font-mono text-sm break-words">{{ answer.data }}</div>
              <div class="text-xs text-muted-foreground">
                {{ answer.type }} · {{ ttlLabel(answer.ttl) }}
              </div>
            </li>
          </ul>
          <p v-else class="text-xs text-muted-foreground">
            No records returned. Status: {{ row.parsed.status }}.
          </p>
        </template>
      </div>
    </div>

    <p v-else-if="!inputError" class="text-xs text-muted-foreground">
      Enter a domain and pick a record type, then press Look up to query
      {{ RESOLVERS.map((r) => r.label).join(", ") }} at the same moment.
    </p>
  </div>
</template>
