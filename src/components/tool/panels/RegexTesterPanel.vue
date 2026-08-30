<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  applyReplacement,
  buildRegex,
  CHEAT_SHEET,
  explainPattern,
  findMatches,
  FLAG_MEANINGS,
  MAX_MATCHES,
  type RegexMatch,
} from "@/tools/regex-tester/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the regex tester.
 *
 * The generic shell can only print rows, and the whole point of a regex tester
 * is seeing the matches sitting inside the text. So this panel paints the
 * highlights, lists the capture groups as chips, previews the replacement, and
 * shows the plain English breakdown side by side, all from the same pure
 * functions in src/tools/regex-tester/index.ts that run() calls. The two
 * surfaces can never disagree about what matched.
 *
 * Every browser read happens in onMounted or a handler, so the server rendered
 * shell never touches window or history.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* defaults                                                          */
/* ---------------------------------------------------------------- */

const DEFAULT_PATTERN = "(?<user>[\\w.]+)@(?<host>[\\w.]+\\.\\w+)";
const DEFAULT_FLAGS = "g";
const DEFAULT_REPLACEMENT = "$<user> at $<host>";
const DEFAULT_TEXT =
  "Contact ann@example.com or bob.jones@mail.example.org.\nBilling goes to accounts@example.com.";

/** The flags offered as toggles, in the order the MDN table lists them. */
const FLAG_TOGGLES = ["g", "i", "m", "s", "u", "y"] as const;

/* ---------------------------------------------------------------- */
/* state                                                            */
/* ---------------------------------------------------------------- */

const pattern = ref(DEFAULT_PATTERN);
const flags = ref(DEFAULT_FLAGS);
const replacement = ref(DEFAULT_REPLACEMENT);
const text = ref(DEFAULT_TEXT);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

const error = ref<{ message: string; hint?: string } | null>(null);
const matches = ref<RegexMatch[]>([]);
const truncated = ref(false);
const replaced = ref<string | null>(null);

/* ---------------------------------------------------------------- */
/* derived                                                          */
/* ---------------------------------------------------------------- */

/** The pattern broken into readable lines. Never throws, so it always renders. */
const explanation = computed(() => (pattern.value ? explainPattern(pattern.value) : []));

/** The flags spelled out under the toggles. */
const flagSummary = computed(() => {
  const on = FLAG_TOGGLES.filter((f) => flags.value.includes(f));
  if (on.length === 0) return "No flags: the search stops at the first match.";
  return on.map((f) => `${f}: ${FLAG_MEANINGS[f]}`).join(". ") + ".";
});

/**
 * The test text split into highlighted and plain runs. Built from the same
 * offsets the match list shows, so a highlight and its row always agree.
 */
const segments = computed(() => {
  const out: { key: string; text: string; match: number | null }[] = [];
  let cursor = 0;
  for (const m of matches.value) {
    if (m.start > cursor) {
      out.push({ key: `p${cursor}`, text: text.value.slice(cursor, m.start), match: null });
    }
    // A zero length match has nothing to paint, so it is skipped here and
    // still counted in the list below.
    if (m.end > m.start) {
      out.push({ key: `m${m.start}`, text: text.value.slice(m.start, m.end), match: m.number });
    }
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < text.value.length) {
    out.push({ key: `p${cursor}`, text: text.value.slice(cursor), match: null });
  }
  return out;
});

const matchCountLabel = computed(() => {
  if (error.value) return "";
  const n = matches.value.length;
  if (n === 0) return "No matches";
  return `${n} ${n === 1 ? "match" : "matches"}${truncated.value ? ` (stopped at ${MAX_MATCHES.toLocaleString("en-US")})` : ""}`;
});

/** Plain text of the match list, for the copy button. */
const matchListText = computed(() =>
  matches.value
    .map((m) => {
      const groups = m.groups
        .filter((g) => g.value !== undefined)
        .map((g) => `${g.name ?? g.number}=${g.value}`)
        .join(", ");
      return `${m.number}. [${m.start}-${m.end}] ${m.value}${groups ? `  ${groups}` : ""}`;
    })
    .join("\n"),
);

/** Plain text of the explanation, for the copy button. */
const explanationText = computed(() =>
  explanation.value.map((t) => `${"  ".repeat(t.depth)}${t.source}  ${t.description}`).join("\n"),
);

const showEmptyState = computed(
  () => !error.value && pattern.value.trim() === "" && text.value === "",
);

/* ---------------------------------------------------------------- */
/* evaluation                                                       */
/* ---------------------------------------------------------------- */

function clearResults() {
  matches.value = [];
  truncated.value = false;
  replaced.value = null;
}

/**
 * An empty pattern is a tester waiting for input, not a failure, so it clears
 * the results without the red banner that buildRegex would raise.
 */
function evaluate() {
  if (pattern.value === "") {
    error.value = null;
    clearResults();
    return;
  }
  try {
    const regex = buildRegex(pattern.value, flags.value);
    const set = findMatches(regex, text.value);
    matches.value = set.matches;
    truncated.value = set.truncated;
    replaced.value =
      replacement.value === "" ? null : applyReplacement(regex, text.value, replacement.value);
    error.value = null;
  } catch (e) {
    clearResults();
    error.value =
      e instanceof ToolError
        ? { message: e.message, hint: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A half typed pattern throws on almost every keystroke, so evaluation and the
 * URL write both wait for a short pause instead of flashing an error per key.
 */
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: text.value || undefined,
      opts: {
        pattern: pattern.value,
        flags: flags.value,
        replacement: replacement.value,
      },
    });
  }, 120);
}

watch([pattern, flags, replacement, text], schedule);

function toggleFlag(flag: string) {
  flags.value = flags.value.includes(flag)
    ? flags.value
        .split("")
        .filter((f) => f !== flag)
        .join("")
    : flags.value + flag;
}

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) text.value = frag.input;
  if (frag.opts.pattern !== undefined) pattern.value = frag.opts.pattern;
  if (frag.opts.flags !== undefined) flags.value = frag.opts.flags;
  if (frag.opts.replacement !== undefined) replacement.value = frag.opts.replacement;
  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- pattern and flags -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-2">
        <label
          for="regex-pattern"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Pattern
        </label>
        <div
          class="flex items-center gap-1 rounded-[10px] bg-secondary px-3 shadow-[var(--sh-inset)]"
        >
          <span aria-hidden="true" class="font-mono text-lg text-muted-foreground">/</span>
          <Input
            id="regex-pattern"
            :model-value="pattern"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="(?<user>\w+)@(\w+\.\w+)"
            class="h-auto flex-1 rounded-none border-0 bg-transparent px-1 py-3 font-mono text-base shadow-none focus-visible:ring-0 md:text-base"
            @update:model-value="(v) => (pattern = String(v))"
          />
          <span aria-hidden="true" class="font-mono text-lg text-muted-foreground">/</span>
          <span class="font-mono text-lg text-muted-foreground">{{ flags }}</span>
        </div>
      </div>

      <fieldset class="flex flex-col gap-2">
        <legend class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Flags
        </legend>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="flag in FLAG_TOGGLES"
            :key="flag"
            type="button"
            class="rounded-[8px] border px-3 py-1.5 font-mono text-sm transition-colors"
            :class="flags.includes(flag) ? 'border-ring bg-accent' : 'bg-secondary hover:bg-accent'"
            :aria-pressed="flags.includes(flag)"
            :title="FLAG_MEANINGS[flag]"
            @click="toggleFlag(flag)"
          >
            {{ flag }}
          </button>
        </div>
        <p class="text-xs text-muted-foreground">{{ flagSummary }}</p>
      </fieldset>
    </div>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.hint" mono />

    <!-- test text and highlighting -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-2">
        <label
          for="regex-text"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Test text
        </label>
        <Textarea
          id="regex-text"
          :model-value="text"
          rows="6"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="Paste the text you want to search."
          class="rounded-[10px] border-0 bg-secondary font-mono text-sm shadow-[var(--sh-inset)]"
          @update:model-value="(v) => (text = String(v))"
        />
      </div>

      <EmptyState
        v-if="showEmptyState"
        title="Nothing to test yet"
        hint="Type a pattern above and paste some text to search. Matches highlight as you type."
        icon="WholeWord"
      />

      <div v-else class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Highlighted
          </span>
          <span class="text-sm text-muted-foreground" aria-live="polite">
            {{ matchCountLabel }}
          </span>
        </div>
        <div
          class="max-h-72 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-sm whitespace-pre-wrap shadow-[var(--sh-inset)]"
        >
          <template v-for="segment in segments" :key="segment.key">
            <mark
              v-if="segment.match !== null"
              class="rounded-[3px] bg-primary/25 px-0.5 text-foreground ring-1 ring-primary/40"
              :title="`Match ${segment.match}`"
              >{{ segment.text }}</mark
            >
            <span v-else>{{ segment.text }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- match list -->
    <div
      v-if="matches.length > 0"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Matches
        </h2>
        <CopyButton :text="matchListText" label="Copy list" />
      </div>
      <ol class="flex flex-col gap-2">
        <li
          v-for="m in matches"
          :key="m.number"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="font-mono text-xs text-muted-foreground">{{ m.number }}.</span>
            <span class="font-mono text-sm break-all">{{
              m.value === "" ? "(empty match)" : m.value
            }}</span>
            <span class="font-mono text-xs text-muted-foreground">
              at {{ m.start }} to {{ m.end }}
            </span>
          </div>
          <div v-if="m.groups.length > 0" class="flex flex-wrap gap-1.5">
            <span
              v-for="g in m.groups"
              :key="g.number"
              class="rounded-[6px] border px-2 py-0.5 font-mono text-xs"
              :class="g.value === undefined ? 'text-muted-foreground' : ''"
            >
              {{ g.name ?? g.number }}:
              {{ g.value === undefined ? "no match" : g.value }}
            </span>
          </div>
        </li>
      </ol>
    </div>

    <!-- replacement -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-2">
        <label
          for="regex-replacement"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Replacement
        </label>
        <Input
          id="regex-replacement"
          :model-value="replacement"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="$1 or $<name>, left empty for no preview"
          class="h-auto rounded-[10px] border-0 bg-secondary px-3 py-3 font-mono text-sm shadow-[var(--sh-inset)] md:text-sm"
          @update:model-value="(v) => (replacement = String(v))"
        />
      </div>
      <div v-if="replaced !== null" class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Result
          </span>
          <CopyButton :text="replaced" label="Copy result" />
        </div>
        <pre
          class="max-h-72 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-sm whitespace-pre-wrap shadow-[var(--sh-inset)]"
          >{{ replaced }}</pre>
      </div>
      <p v-else class="text-sm text-muted-foreground">
        Type a replacement template to preview the rewritten text. Without the g flag only the first
        match is replaced, which is what String.replace does.
      </p>
    </div>

    <!-- explanation -->
    <div
      v-if="explanation.length > 0"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          What this pattern says
        </h2>
        <CopyButton :text="explanationText" label="Copy explanation" />
      </div>
      <ul class="flex flex-col gap-1">
        <li
          v-for="(token, i) in explanation"
          :key="`${i}-${token.source}`"
          class="flex flex-wrap items-baseline gap-2 text-sm"
          :style="{ paddingLeft: `${token.depth * 16}px` }"
        >
          <code class="rounded-[6px] bg-secondary px-1.5 py-0.5 font-mono text-xs">{{
            token.source
          }}</code>
          <span class="text-muted-foreground">{{ token.description }}</span>
        </li>
      </ul>
    </div>

    <!-- cheat sheet -->
    <details class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <summary
        class="cursor-pointer text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
      >
        Cheat sheet
      </summary>
      <div class="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <section v-for="section in CHEAT_SHEET" :key="section.title" class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold">{{ section.title }}</h3>
          <dl class="flex flex-col gap-1">
            <div
              v-for="entry in section.entries"
              :key="entry.token"
              class="flex flex-wrap items-baseline gap-2"
            >
              <dt class="rounded-[6px] bg-secondary px-1.5 py-0.5 font-mono text-xs">
                {{ entry.token }}
              </dt>
              <dd class="text-xs text-muted-foreground">{{ entry.meaning }}</dd>
            </div>
          </dl>
        </section>
      </div>
    </details>
  </div>
</template>
