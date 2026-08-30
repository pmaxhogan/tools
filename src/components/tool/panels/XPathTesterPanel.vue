<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  checkHtmlSize,
  engineError,
  explainSelector,
  preview,
  validateSelector,
  type RawMatch,
  type SelectorMode,
} from "@/tools/xpath-css-selector-tester/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the XPath and CSS selector tester.
 *
 * The logic layer is deliberately engine free (rule 27: no DOM in src/tools),
 * so the browser half lives here: DOMParser turns the pasted markup into a
 * document, querySelectorAll runs CSS, and Document.evaluate runs XPath. This
 * file implements the `SelectorEngine` contract the pure layer declares, and
 * everything that is not the engine (validating the selector, explaining it,
 * mapping an engine failure onto a ToolError) comes from that pure layer, so
 * the page and `queryWith`, which any non panel surface can call with this same
 * adapter, can never disagree about a selector.
 *
 * Highlighting works by marking the matched nodes with HTML comments before
 * the document is serialized, then escaping the whole string and swapping the
 * escaped markers for <mark> tags. That is why the v-html below is safe: every
 * character that came from the user is already entity escaped by then.
 *
 * Every browser read happens in onMounted or a handler, so the server rendered
 * shell never touches window, history, or a parser.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* defaults                                                          */
/* ---------------------------------------------------------------- */

const DEFAULT_HTML = `<ul class="menu">
  <li class="item">Buy milk</li>
  <li class="item done">Ship it</li>
  <li class="item">Write tests</li>
</ul>`;
const DEFAULT_SELECTOR = "ul.menu > li.item.done";

const MODES = [
  { value: "css", label: "CSS selector" },
  { value: "xpath", label: "XPath" },
];

/** Comment text used to fence a match before the document is serialized. */
const MARK_START = "xcst-match-start";
const MARK_END = "xcst-match-end";

/* ---------------------------------------------------------------- */
/* state                                                            */
/* ---------------------------------------------------------------- */

const html = ref(DEFAULT_HTML);
const selector = ref(DEFAULT_SELECTOR);
const mode = ref<SelectorMode>("css");
const showMarkup = ref(false);

const matches = ref<RawMatch[]>([]);
const highlighted = ref("");
const error = ref<{ message: string; hint?: string } | null>(null);

/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

/* ---------------------------------------------------------------- */
/* the browser engine                                                */
/* ---------------------------------------------------------------- */

/** A stable CSS path back to one element, e.g. "html > body > ul > li:nth-of-type(2)". */
function cssPath(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const twins = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (twins.length > 1) part += `:nth-of-type(${twins.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

/** Attributes of an element, in source order. */
function attributesOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) out[attr.name] = attr.value;
  return out;
}

/** Reduce one DOM node to the plain record the pure layer works with. */
function toMatch(node: Node): RawMatch {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    return {
      kind: "element",
      name: element.tagName.toLowerCase(),
      markup: element.outerHTML,
      text: element.textContent ?? "",
      path: cssPath(element),
      attributes: attributesOf(element),
    };
  }
  if (node.nodeType === Node.ATTRIBUTE_NODE) {
    const attr = node as Attr;
    return {
      kind: "attribute",
      name: attr.name,
      markup: attr.value,
      path: attr.ownerElement ? cssPath(attr.ownerElement) : undefined,
    };
  }
  return {
    kind: "text",
    markup: node.nodeValue ?? "",
    path: node.parentElement ? cssPath(node.parentElement) : undefined,
  };
}

/**
 * Run an XPath expression once and sort out what it returned. An expression
 * like count(//li) or normalize-space(//h1) yields a value rather than a node
 * set, and the result object can only be read in one of those two ways, so the
 * type is checked before anything is pulled out of it.
 */
function evaluateXPath(
  doc: Document,
  expression: string,
): { value: RawMatch | null; nodes: Node[] } {
  const result = doc.evaluate(expression, doc, null, XPathResult.ANY_TYPE, null);
  if (result.resultType === XPathResult.NUMBER_TYPE)
    return { value: { kind: "value", markup: String(result.numberValue) }, nodes: [] };
  if (result.resultType === XPathResult.STRING_TYPE)
    return { value: { kind: "value", markup: result.stringValue }, nodes: [] };
  if (result.resultType === XPathResult.BOOLEAN_TYPE)
    return { value: { kind: "value", markup: String(result.booleanValue) }, nodes: [] };
  const nodes: Node[] = [];
  let next = result.iterateNext();
  while (next) {
    nodes.push(next);
    next = result.iterateNext();
  }
  return { value: null, nodes };
}

/**
 * Fence every matched node with a pair of comments, so the serialized document
 * carries the match boundaries as text that survives escaping.
 */
function fence(doc: Document, nodes: Node[]): void {
  for (const node of nodes) {
    const target: Node | null =
      node.nodeType === Node.ATTRIBUTE_NODE ? (node as Attr).ownerElement : node;
    if (!target || !target.parentNode || target === doc.documentElement) continue;
    const parent = target.parentNode;
    parent.insertBefore(doc.createComment(MARK_START), target);
    parent.insertBefore(doc.createComment(MARK_END), target.nextSibling);
  }
}

/** Entity escape, then turn the fence comments into <mark> tags. */
function toHighlightedHtml(serialized: string): string {
  const escaped = serialized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped
    .split(`&lt;!--${MARK_START}--&gt;`)
    .join('<mark class="rounded-[3px] bg-primary/25 text-foreground ring-1 ring-primary/40">')
    .split(`&lt;!--${MARK_END}--&gt;`)
    .join("</mark>");
}

/** True when the pasted markup is a fragment rather than a whole document. */
function isFragment(source: string): boolean {
  const head = source.trimStart().slice(0, 20).toLowerCase();
  return !head.startsWith("<!doctype") && !head.startsWith("<html");
}

/**
 * The browser half of the tool: parse, query, and produce both the flattened
 * matches the list renders and the escaped, marked up copy of the document.
 */
function queryDocument(
  source: string,
  expression: string,
  which: SelectorMode,
): { matches: RawMatch[]; highlighted: string } {
  const doc = new DOMParser().parseFromString(source, "text/html");

  let nodes: Node[];
  let value: RawMatch | null = null;
  if (which === "css") {
    nodes = Array.from(doc.querySelectorAll(expression));
  } else {
    const evaluated = evaluateXPath(doc, expression);
    value = evaluated.value;
    nodes = evaluated.nodes;
  }

  const found = value ? [value] : nodes.map(toMatch);
  fence(doc, nodes);
  const serialized = isFragment(source)
    ? (doc.body?.innerHTML ?? "")
    : doc.documentElement.outerHTML;

  return { matches: found, highlighted: toHighlightedHtml(serialized) };
}

/* ---------------------------------------------------------------- */
/* derived                                                          */
/* ---------------------------------------------------------------- */

const explanation = computed(() => explainSelector(selector.value, mode.value));

const matchCountLabel = computed(() => {
  if (error.value) return "";
  const n = matches.value.length;
  if (n === 0) return "No matches";
  return `${n} ${n === 1 ? "match" : "matches"}`;
});

const matchListText = computed(() =>
  matches.value
    .map((m, i) => {
      const head =
        m.kind === "element"
          ? `<${m.name}>`
          : m.kind === "attribute"
            ? `@${m.name}`
            : m.kind === "text"
              ? "text()"
              : "value";
      const body = m.kind === "element" ? (m.text ?? "") : m.markup;
      return [`${i + 1}. ${head}`, m.path, preview(body)].filter(Boolean).join("  ");
    })
    .join("\n"),
);

const showEmptyState = computed(() => !error.value && html.value.trim() === "");

/* ---------------------------------------------------------------- */
/* evaluation                                                       */
/* ---------------------------------------------------------------- */

function evaluate() {
  matches.value = [];
  highlighted.value = "";

  if (selector.value.trim() === "" || html.value.trim() === "") {
    error.value = null;
    return;
  }

  try {
    validateSelector(selector.value, mode.value);
    checkHtmlSize(html.value);
  } catch (e) {
    error.value =
      e instanceof ToolError
        ? { message: e.message, hint: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
    return;
  }

  try {
    const result = queryDocument(html.value, selector.value, mode.value);
    matches.value = result.matches;
    highlighted.value = result.highlighted;
    error.value = null;
  } catch (e) {
    const mapped = engineError(e, mode.value, selector.value);
    error.value = { message: mapped.message, hint: mapped.fix };
  }
}

/**
 * A half typed selector throws on almost every keystroke, so evaluation and
 * the URL write both wait for a short pause instead of flashing an error per
 * key.
 */
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: html.value || undefined,
      opts: {
        selector: selector.value,
        mode: mode.value,
        showMarkup: String(showMarkup.value),
      },
    });
  }, 120);
}

watch([html, selector, mode, showMarkup], schedule);

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) html.value = frag.input;
  if (frag.opts.selector !== undefined) selector.value = frag.opts.selector;
  if (frag.opts.mode === "css" || frag.opts.mode === "xpath") mode.value = frag.opts.mode;
  if (frag.opts.showMarkup !== undefined) showMarkup.value = frag.opts.showMarkup === "true";
  mounted.value = true;
  evaluate();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5">
    <!-- mode and selector -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Mode
        </span>
        <Segmented
          :model-value="mode"
          :options="MODES"
          label="Selector language"
          @update:model-value="(v) => (mode = v === 'xpath' ? 'xpath' : 'css')"
        />
      </div>

      <div class="flex flex-col gap-2">
        <label
          for="selector-input"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          {{ mode === "css" ? "CSS selector" : "XPath expression" }}
        </label>
        <Input
          id="selector-input"
          :model-value="selector"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          :placeholder="mode === 'css' ? 'ul.menu > li.item' : `//ul[@class='menu']/li`"
          class="h-auto rounded-[10px] border-0 bg-secondary px-3 py-3 font-mono text-base shadow-[var(--sh-inset)] md:text-base"
          @update:model-value="(v) => (selector = String(v))"
        />
      </div>
    </div>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.hint" mono />

    <!-- html and highlighting -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-2">
        <label
          for="selector-html"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          HTML
        </label>
        <Textarea
          id="selector-html"
          :model-value="html"
          rows="8"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="Paste the markup you want to query."
          class="rounded-[10px] border-0 bg-secondary font-mono text-sm shadow-[var(--sh-inset)]"
          @update:model-value="(v) => (html = String(v))"
        />
      </div>

      <EmptyState
        v-if="showEmptyState"
        title="Nothing to query yet"
        hint="Paste some HTML above. Matches are highlighted here and listed below with a path to each one."
        icon="ScanSearch"
      />

      <div v-else-if="highlighted" class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Highlighted
          </span>
          <span class="text-sm text-muted-foreground" aria-live="polite">
            {{ matchCountLabel }}
          </span>
        </div>
        <!-- eslint-disable vue/no-v-html -- toHighlightedHtml entity escapes the document before it inserts the mark tags, so nothing user supplied is parsed as markup -->
        <pre
          class="max-h-72 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-sm whitespace-pre-wrap shadow-[var(--sh-inset)]"
          v-html="highlighted"
        ></pre>
        <!-- eslint-enable vue/no-v-html -->
      </div>
    </div>

    <!-- match list -->
    <div
      v-if="matches.length > 0"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Matches
        </h2>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-[8px] border px-3 py-1.5 text-sm transition-colors"
            :class="showMarkup ? 'border-ring bg-accent' : 'bg-secondary hover:bg-accent'"
            :aria-pressed="showMarkup"
            @click="showMarkup = !showMarkup"
          >
            Show markup
          </button>
          <CopyButton :text="matchListText" label="Copy list" />
        </div>
      </div>
      <ol class="flex flex-col gap-2">
        <li
          v-for="(m, i) in matches"
          :key="`${i}-${m.path ?? m.markup}`"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="font-mono text-xs text-muted-foreground">{{ i + 1 }}.</span>
            <span class="font-mono text-sm">
              {{
                m.kind === "element"
                  ? `<${m.name}>`
                  : m.kind === "attribute"
                    ? `@${m.name}`
                    : m.kind === "text"
                      ? "text()"
                      : "value"
              }}
            </span>
            <span v-if="m.path" class="font-mono text-xs break-all text-muted-foreground">
              {{ m.path }}
            </span>
          </div>
          <p class="text-sm break-words">
            {{ preview(m.kind === "element" ? (m.text ?? "") : m.markup, 200) }}
          </p>
          <pre
            v-if="showMarkup && m.kind === 'element'"
            class="max-h-40 overflow-auto rounded-[8px] bg-card px-2 py-1.5 font-mono text-xs whitespace-pre-wrap"
            >{{ m.markup }}</pre>
        </li>
      </ol>
    </div>

    <!-- explanation -->
    <div
      v-if="explanation.length > 0"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <h2 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        What this selector says
      </h2>
      <ul class="flex flex-col gap-1">
        <li
          v-for="(part, i) in explanation"
          :key="`${i}-${part.source}`"
          class="flex flex-wrap items-baseline gap-2 text-sm"
        >
          <code class="rounded-[6px] bg-secondary px-1.5 py-0.5 font-mono text-xs">{{
            part.source
          }}</code>
          <span class="text-muted-foreground">{{ part.description }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
