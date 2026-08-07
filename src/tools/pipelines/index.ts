import { ToolError, type OptionSpec, type ToolLogic, type ToolMeta, type TypeSpec } from '../types';

/**
 * Composable Pipelines: the engine.
 *
 * A pipeline is a list of steps. Each step names a tool by slug and carries its
 * options as strings. Running a pipeline feeds one step's string output into the
 * next step's input, stopping the moment a step returns a Record (a terminal, by
 * the catalog's convention) or throws. The engine never imports the registry:
 * like sqlite-viewer, it takes an injected loader so the logic stays pure and
 * testable in Node, while the panel hands in the real registry loaders.
 *
 * Options arrive as strings (from the URL fragment or the builder) and are
 * coerced per each tool's OptionSpec exactly the way the curl worker does, so a
 * number option typed as "3" reaches run() as the number 3.
 */

/** One step: a tool slug and its options, kept as strings for the fragment. */
export interface PipelineStep {
  slug: string;
  opts: Record<string, string>;
}

/** A whole pipeline: the ordered steps and the optional starting text. */
export interface PipelineDef {
  steps: PipelineStep[];
  /** Initial input for step 0 when the first step is not a source. */
  input?: string;
}

/** What one executed step produced. */
export interface StepResult {
  slug: string;
  /** The step's output, when it ran. A string keeps the chain going; a Record ends it. */
  output?: string | Record<string, string>;
  /** Set when the step threw, mirroring ToolError's shape. */
  error?: { code: string; message: string; fix?: string };
  /** True when this step ended the chain (Record output, an error, or a missing tool). */
  ended?: boolean;
}

export interface PipelineRun {
  steps: StepResult[];
  /** The last step's output, string or Record. */
  finalOutput?: string | Record<string, string>;
}

/** A soft finding from static validation. Never blocks a run. */
export interface PipelineWarning {
  /** Index of the step the warning is about, or -1 for whole-pipeline notes. */
  step: number;
  code: string;
  message: string;
}

/** The narrow logic shape the engine needs from each tool. */
export interface LoadedLogic {
  run: (input: unknown, opts: unknown) => unknown;
}

export interface RunDeps {
  loadLogic: (slug: string) => Promise<LoadedLogic>;
  metaFor: (slug: string) => ToolMeta | undefined;
}

/** TypeSpecs that are, for chaining purposes, plain text one tool can hand another. */
const TEXT_FAMILY: ReadonlySet<TypeSpec> = new Set<TypeSpec>([
  'text/plain',
  'application/json',
  'text/csv',
  'text/html',
  'image/svg+xml',
]);

/**
 * Coerce a step's string options to the types its run() expects, using the
 * tool's OptionSpec. This mirrors readOptions in worker/index.ts: defaults
 * first, then declared options coerced by kind, then any extra keys pass
 * through as strings.
 */
export function coerceOpts(meta: ToolMeta | undefined, raw: Record<string, string>): Record<string, unknown> {
  const specs: OptionSpec[] = meta?.options ?? [];
  const opts: Record<string, unknown> = {};
  for (const spec of specs) opts[spec.id] = spec.default;

  for (const [key, value] of Object.entries(raw ?? {})) {
    const spec = specs.find((s) => s.id === key);
    if (!spec) {
      opts[key] = value;
      continue;
    }
    if (spec.kind === 'number' || spec.kind === 'slider') {
      const n = Number(value);
      opts[key] = Number.isFinite(n) ? n : spec.default;
    } else if (spec.kind === 'boolean') {
      const v = String(value).trim().toLowerCase();
      opts[key] = v === 'true' || v === '1' || v === 'yes' || v === '';
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

function toError(err: unknown): { code: string; message: string; fix?: string } {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message, fix: err.fix };
  }
  return {
    code: 'step-failed',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Run a pipeline step by step. Each step's string output becomes the next
 * step's input; a Record output or a thrown error ends the chain and later
 * steps are not run. Source steps (meta.input 'none') ignore the incoming
 * value. Returns one StepResult per step that actually ran.
 */
export async function runPipeline(def: PipelineDef, deps: RunDeps): Promise<PipelineRun> {
  const results: StepResult[] = [];
  let carried: string | undefined = def.input;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    const meta = deps.metaFor(step.slug);

    if (!meta) {
      results.push({
        slug: step.slug,
        ended: true,
        error: {
          code: 'unknown-tool',
          message: `No tool named "${step.slug}" is available.`,
          fix: 'Remove this step or pick a tool from the list.',
        },
      });
      break;
    }

    const opts = coerceOpts(meta, step.opts);
    const isSource = meta.input === 'none';
    const stepInput = isSource ? undefined : (carried ?? '');

    let logic: LoadedLogic;
    try {
      logic = await deps.loadLogic(step.slug);
    } catch (err) {
      results.push({ slug: step.slug, ended: true, error: toError(err) });
      break;
    }

    try {
      const raw = await logic.run(stepInput, opts);
      if (typeof raw === 'string') {
        results.push({ slug: step.slug, output: raw });
        carried = raw;
        continue;
      }
      // A Record (or any non-string) is a terminal: label it and stop.
      const record = raw as Record<string, string>;
      results.push({ slug: step.slug, output: record, ended: true });
      return { steps: results, finalOutput: record };
    } catch (err) {
      results.push({ slug: step.slug, ended: true, error: toError(err) });
      break;
    }
  }

  const last = results[results.length - 1];
  return { steps: results, finalOutput: last?.output };
}

/**
 * Static checks that guide rather than block. Warnings are surfaced next to the
 * offending step; none of them stops a run, because a text-to-text chain is
 * loose by design.
 *
 * The terminal-followed check leans on the catalog-scoped invariant that a
 * Record-returning tool declares output 'application/json'. That holds for every
 * curated node here (it does not hold site wide, which is exactly why the node
 * list is curated), so it is a safe heuristic for a soft warning.
 */
export function validatePipeline(
  def: PipelineDef,
  metaFor: (slug: string) => ToolMeta | undefined,
): PipelineWarning[] {
  const warnings: PipelineWarning[] = [];
  const producesRecord = (meta: ToolMeta): boolean => meta.output === 'application/json';

  def.steps.forEach((step, i) => {
    const meta = metaFor(step.slug);
    if (!meta) {
      warnings.push({
        step: i,
        code: 'unknown-tool',
        message: `Step ${i + 1} names "${step.slug}", which is not a known tool.`,
      });
      return;
    }

    if (meta.input === 'none' && i !== 0) {
      warnings.push({
        step: i,
        code: 'source-not-first',
        message: `${meta.name} takes no input, so it only makes sense as the first step.`,
      });
    }

    if (i < def.steps.length - 1 && producesRecord(meta)) {
      warnings.push({
        step: i,
        code: 'record-then-more',
        message: `${meta.name} produces labeled results, which end the chain, so the steps after it will not run.`,
      });
    }

    const next = def.steps[i + 1];
    if (next) {
      const nextMeta = metaFor(next.slug);
      if (
        nextMeta &&
        nextMeta.input !== 'none' &&
        !producesRecord(meta) &&
        meta.output !== nextMeta.input &&
        !(TEXT_FAMILY.has(meta.output) && TEXT_FAMILY.has(nextMeta.input))
      ) {
        warnings.push({
          step: i,
          code: 'type-mismatch',
          message: `${meta.name} outputs ${meta.output}, but ${nextMeta.name} expects ${nextMeta.input}. It may still work if the text lines up.`,
        });
      }
    }
  });

  return warnings;
}

/**
 * Which catalog nodes can sensibly follow a given step: any node whose input is
 * compatible with that step's string output. Sources are never suggested as a
 * next step, since they ignore input. This is the guidance that keeps a chain
 * building toward valid connections.
 */
export function suggestNext<T extends { slug: string; role: string }>(
  afterSlug: string,
  metaFor: (slug: string) => ToolMeta | undefined,
  nodes: T[],
): string[] {
  const afterMeta = metaFor(afterSlug);
  if (!afterMeta) return [];
  // A step that produces a Record cannot feed anything.
  if (afterMeta.output === 'application/json') return [];
  if (!TEXT_FAMILY.has(afterMeta.output)) return [];

  return nodes
    .filter((node) => node.role !== 'source')
    .filter((node) => {
      const meta = metaFor(node.slug);
      return !!meta && meta.input !== 'none' && TEXT_FAMILY.has(meta.input);
    })
    .map((node) => node.slug);
}

/* ------------------------------------------------------------------ */
/* Fragment serialization                                             */
/* ------------------------------------------------------------------ */

/**
 * Encode the steps to a compact, URL-safe string. Steps are joined by ";" and a
 * step's parts by "|": the slug first, then each option as "key=value".
 * encodeURIComponent escapes ";", "|" and "=" inside keys and values, so those
 * delimiters are unambiguous. The starting input is carried separately (under
 * the fragment's 2000-character cap), not encoded here.
 */
export function serializePipeline(def: PipelineDef): string {
  return def.steps
    .map((step) => {
      const parts = [encodeURIComponent(step.slug)];
      for (const [key, value] of Object.entries(step.opts ?? {})) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
      return parts.join('|');
    })
    .join(';');
}

/** Inverse of serializePipeline. Unknown or empty chunks are skipped. */
export function parsePipeline(encoded: string): PipelineStep[] {
  const source = String(encoded ?? '').trim();
  if (!source) return [];
  const steps: PipelineStep[] = [];
  for (const chunk of source.split(';')) {
    if (!chunk) continue;
    const [slugPart, ...optParts] = chunk.split('|');
    const slug = decodeURIComponent(slugPart ?? '');
    if (!slug) continue;
    const opts: Record<string, string> = {};
    for (const part of optParts) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = decodeURIComponent(part.slice(0, eq));
      const value = decodeURIComponent(part.slice(eq + 1));
      if (key) opts[key] = value;
    }
    steps.push({ slug, opts });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Generic-shell fallback                                             */
/* ------------------------------------------------------------------ */

export interface PipelineToolOpts {
  /** A serialized pipeline, when passed as an option instead of the input. */
  pipeline?: string;
  [key: string]: unknown;
}

/**
 * The pure fallback. A pipeline runs against the live registry, which only
 * exists in the browser, so this cannot execute one. Instead it parses a
 * serialized pipeline (from the "pipeline" option or the raw input, in either
 * the compact "slug|k=v;slug" form or a JSON array of steps) and returns a
 * readable preview of the steps, so the parser is exercised headlessly and the
 * curl caller learns where pipelines actually run.
 */
export function run(input: string, opts: PipelineToolOpts): Record<string, string> {
  const raw = (opts?.pipeline ? String(opts.pipeline) : String(input ?? '')).trim();

  if (!raw) {
    return {
      'Composable Pipelines':
        'Chain tools together so one tool\'s output becomes the next tool\'s input.',
      'Build one': 'Open the builder on this page to add steps, run them live, and share the chain.',
      'Share it': 'The whole pipeline, steps and input, is encoded in the page link, so a link is a runnable chain.',
      Privacy: 'Everything runs in your browser: your files and inputs never leave your device.',
    };
  }

  let steps: PipelineStep[];
  try {
    steps = raw.startsWith('[') || raw.startsWith('{') ? stepsFromJson(raw) : parsePipeline(raw);
  } catch (err) {
    throw new ToolError(
      'invalid-pipeline',
      err instanceof Error ? err.message : 'Could not read that pipeline.',
      'Pass a compact pipeline like "json-formatter;json-to-typescript" or a JSON array of {slug, opts} steps.',
    );
  }

  if (steps.length === 0) {
    throw new ToolError(
      'empty-pipeline',
      'That pipeline has no steps.',
      'Add at least one tool slug, for example "json-formatter".',
    );
  }

  const preview: Record<string, string> = {
    Pipeline: `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`,
  };
  steps.forEach((step, i) => {
    const optPairs = Object.entries(step.opts);
    const optText = optPairs.length
      ? ` (${optPairs.map(([k, v]) => `${k}=${v}`).join(', ')})`
      : '';
    preview[`Step ${i + 1}`] = `${step.slug}${optText}`;
  });
  preview['Run it'] =
    'Pipelines execute in the builder panel on this page, which wires each step to the live tool. This endpoint only previews the chain.';
  return preview;
}

/** Parse a JSON pipeline: an array of steps, or an object with a steps array. */
function stepsFromJson(raw: string): PipelineStep[] {
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { steps?: unknown }).steps ?? []);
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const obj = (item ?? {}) as { slug?: unknown; opts?: unknown };
    const slug = String(obj.slug ?? '');
    const opts: Record<string, string> = {};
    if (obj.opts && typeof obj.opts === 'object') {
      for (const [k, v] of Object.entries(obj.opts as Record<string, unknown>)) {
        opts[k] = String(v);
      }
    }
    return { slug, opts };
  });
}

export default { run } satisfies ToolLogic<string, Record<string, string>, PipelineToolOpts>;
