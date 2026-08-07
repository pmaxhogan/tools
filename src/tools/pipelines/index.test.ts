import { describe, expect, it } from 'vitest';
import { ToolError, type ToolMeta } from '../types';
import {
  coerceOpts,
  parsePipeline,
  run,
  runPipeline,
  serializePipeline,
  suggestNext,
  validatePipeline,
  type LoadedLogic,
  type PipelineDef,
} from './index';
import { NODES } from './data';
import { tools, loaders } from '../registry';

/* ------------------------------------------------------------------ */
/* Stub tools: a small world the engine can run without the registry.  */
/* ------------------------------------------------------------------ */

const STUB_META: Record<string, ToolMeta> = {
  upper: metaOf('upper', 'Upper', 'text/plain', 'text/plain'),
  exclaim: {
    ...metaOf('exclaim', 'Exclaim', 'text/plain', 'text/plain'),
    options: [{ kind: 'number', id: 'times', label: 'Times', default: 1, min: 1, max: 9 }],
  },
  report: metaOf('report', 'Report', 'text/plain', 'application/json'),
  gen: metaOf('gen', 'Generator', 'none', 'text/plain'),
  boom: metaOf('boom', 'Boom', 'text/plain', 'text/plain'),
  csvish: metaOf('csvish', 'CSVish', 'text/csv', 'text/plain'),
};

const STUB_LOGIC: Record<string, LoadedLogic> = {
  upper: { run: (input) => String(input ?? '').toUpperCase() },
  exclaim: {
    run: (input, opts) => {
      const times = (opts as { times: number }).times;
      // Fails loudly if coercion did not turn "3" into a number.
      if (typeof times !== 'number') throw new Error('times was not coerced to a number');
      return String(input ?? '') + '!'.repeat(times);
    },
  },
  report: { run: (input) => ({ length: String(String(input ?? '').length) }) },
  gen: { run: () => 'generated' },
  boom: {
    run: () => {
      throw new ToolError('kaboom', 'This step always fails.', 'Do not use boom.');
    },
  },
  csvish: { run: (input) => `csv:${String(input ?? '')}` },
};

function metaOf(slug: string, name: string, input: ToolMeta['input'], output: ToolMeta['output']): ToolMeta {
  return {
    slug,
    name,
    description: `${name} stub`,
    category: 'Test',
    keywords: [],
    input,
    output,
    copy: { what: '', how: '', why: '', faq: [] },
  };
}

const metaFor = (slug: string): ToolMeta | undefined => STUB_META[slug];
const loadLogic = async (slug: string): Promise<LoadedLogic> => {
  const logic = STUB_LOGIC[slug];
  if (!logic) throw new Error(`no stub for ${slug}`);
  return logic;
};
const deps = { loadLogic, metaFor };

/* ------------------------------------------------------------------ */
/* runPipeline                                                         */
/* ------------------------------------------------------------------ */

describe('runPipeline', () => {
  it('passes a string output along a two-step transform chain', async () => {
    const def: PipelineDef = {
      input: 'hi',
      steps: [
        { slug: 'upper', opts: {} },
        { slug: 'exclaim', opts: {} },
      ],
    };
    const result = await runPipeline(def, deps);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.output).toBe('HI');
    expect(result.steps[1]!.output).toBe('HI!');
    expect(result.finalOutput).toBe('HI!');
  });

  it('stops at a terminal (Record) step and does not run later steps', async () => {
    const def: PipelineDef = {
      input: 'hello',
      steps: [
        { slug: 'report', opts: {} },
        { slug: 'upper', opts: {} },
      ],
    };
    const result = await runPipeline(def, deps);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.ended).toBe(true);
    expect(result.steps[0]!.output).toEqual({ length: '5' });
    expect(result.finalOutput).toEqual({ length: '5' });
  });

  it('captures a ToolError with its fix and stops the run', async () => {
    const def: PipelineDef = {
      input: 'x',
      steps: [
        { slug: 'boom', opts: {} },
        { slug: 'upper', opts: {} },
      ],
    };
    const result = await runPipeline(def, deps);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.error).toEqual({
      code: 'kaboom',
      message: 'This step always fails.',
      fix: 'Do not use boom.',
    });
    expect(result.steps[0]!.ended).toBe(true);
  });

  it('coerces a number option that arrives as a string', async () => {
    const def: PipelineDef = {
      input: 'a',
      steps: [{ slug: 'exclaim', opts: { times: '3' } }],
    };
    const result = await runPipeline(def, deps);
    expect(result.steps[0]!.output).toBe('a!!!');
  });

  it('lets a source at step 0 ignore the incoming input', async () => {
    const def: PipelineDef = {
      input: 'ignored',
      steps: [
        { slug: 'gen', opts: {} },
        { slug: 'upper', opts: {} },
      ],
    };
    const result = await runPipeline(def, deps);
    expect(result.steps[0]!.output).toBe('generated');
    expect(result.steps[1]!.output).toBe('GENERATED');
  });

  it('ends the chain on an unknown slug', async () => {
    const def: PipelineDef = { input: 'x', steps: [{ slug: 'nope', opts: {} }] };
    const result = await runPipeline(def, deps);
    expect(result.steps[0]!.error?.code).toBe('unknown-tool');
    expect(result.steps[0]!.ended).toBe(true);
  });

  it('returns an empty run for an empty pipeline', async () => {
    const result = await runPipeline({ steps: [] }, deps);
    expect(result.steps).toHaveLength(0);
    expect(result.finalOutput).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* validatePipeline                                                    */
/* ------------------------------------------------------------------ */

describe('validatePipeline', () => {
  it('flags a source that is not the first step', () => {
    const def: PipelineDef = {
      steps: [
        { slug: 'upper', opts: {} },
        { slug: 'gen', opts: {} },
      ],
    };
    const warnings = validatePipeline(def, metaFor);
    expect(warnings.some((w) => w.code === 'source-not-first' && w.step === 1)).toBe(true);
  });

  it('warns that steps after a Record step are unreachable', () => {
    const def: PipelineDef = {
      steps: [
        { slug: 'report', opts: {} },
        { slug: 'upper', opts: {} },
      ],
    };
    const warnings = validatePipeline(def, metaFor);
    expect(warnings.some((w) => w.code === 'record-then-more')).toBe(true);
  });

  it('warns on a type mismatch between adjacent non-text steps', () => {
    // upper outputs text/plain into csvish, which expects text/csv: both are in
    // the text family, so this must NOT warn (loose text chains are allowed).
    const loose: PipelineDef = {
      steps: [
        { slug: 'upper', opts: {} },
        { slug: 'csvish', opts: {} },
      ],
    };
    expect(validatePipeline(loose, metaFor).some((w) => w.code === 'type-mismatch')).toBe(false);

    // A step whose output leaves the text family would mismatch. Build one.
    const imgMeta = metaOf('img', 'Img', 'text/plain', 'image/png');
    const localMeta = (slug: string) => (slug === 'img' ? imgMeta : STUB_META[slug]);
    const strict: PipelineDef = {
      steps: [
        { slug: 'img', opts: {} },
        { slug: 'upper', opts: {} },
      ],
    };
    expect(validatePipeline(strict, localMeta).some((w) => w.code === 'type-mismatch')).toBe(true);
  });

  it('flags an unknown slug', () => {
    const warnings = validatePipeline({ steps: [{ slug: 'ghost', opts: {} }] }, metaFor);
    expect(warnings.some((w) => w.code === 'unknown-tool')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* suggestNext                                                         */
/* ------------------------------------------------------------------ */

describe('suggestNext', () => {
  const stubNodes = [
    { slug: 'upper', role: 'transform' },
    { slug: 'exclaim', role: 'transform' },
    { slug: 'report', role: 'terminal' },
    { slug: 'gen', role: 'source' },
  ];

  it('returns text-compatible nodes and never a source', () => {
    const next = suggestNext('upper', metaFor, stubNodes);
    expect(next).toContain('exclaim');
    expect(next).toContain('report');
    expect(next).not.toContain('gen');
  });

  it('returns nothing after a Record-producing step', () => {
    expect(suggestNext('report', metaFor, stubNodes)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* serialize / parse                                                   */
/* ------------------------------------------------------------------ */

describe('serialize and parse', () => {
  it('round-trips steps including options', () => {
    const def: PipelineDef = {
      steps: [
        { slug: 'json-formatter', opts: { mode: 'format', indent: '2' } },
        { slug: 'json-to-typescript', opts: {} },
      ],
    };
    const encoded = serializePipeline(def);
    const decoded = parsePipeline(encoded);
    expect(decoded).toEqual(def.steps);
  });

  it('round-trips option values that contain delimiter characters', () => {
    const def: PipelineDef = {
      steps: [{ slug: 'x', opts: { sep: 'a;b|c=d', ' key ': 'v' } }],
    };
    const decoded = parsePipeline(serializePipeline(def));
    expect(decoded).toEqual(def.steps);
  });

  it('parses an empty string to no steps', () => {
    expect(parsePipeline('')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* coerceOpts                                                          */
/* ------------------------------------------------------------------ */

describe('coerceOpts', () => {
  it('applies defaults and coerces by kind', () => {
    const out = coerceOpts(STUB_META.exclaim, { times: '4' });
    expect(out.times).toBe(4);
  });

  it('falls back to the default for a non-numeric number option', () => {
    const out = coerceOpts(STUB_META.exclaim, { times: 'not-a-number' });
    expect(out.times).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* run (generic fallback)                                              */
/* ------------------------------------------------------------------ */

describe('run', () => {
  it('previews a compact pipeline string', () => {
    const out = run('json-formatter|mode=format;json-to-typescript', {});
    expect(out.Pipeline).toBe('2 steps');
    expect(out['Step 1']).toContain('json-formatter');
    expect(out['Step 2']).toContain('json-to-typescript');
  });

  it('previews a JSON pipeline', () => {
    const out = run('[{"slug":"upper","opts":{}}]', {});
    expect(out.Pipeline).toBe('1 step');
  });

  it('returns an intro record for empty input', () => {
    const out = run('', {});
    expect(out.Privacy).toContain('your files and inputs never leave your device');
  });

  it('reads the pipeline from the option when given', () => {
    const out = run('', { pipeline: 'upper;exclaim' });
    expect(out.Pipeline).toBe('2 steps');
  });
});

/* ------------------------------------------------------------------ */
/* data integrity                                                      */
/* ------------------------------------------------------------------ */

describe('node catalog', () => {
  const registrySlugs = new Set(tools.map((t) => t.slug));

  it('every node slug exists in the registry tools array', () => {
    for (const node of NODES) {
      expect(registrySlugs.has(node.slug), `${node.slug} missing from tools`).toBe(true);
    }
  });

  it('every node slug exists in the loaders map', () => {
    for (const node of NODES) {
      expect(
        Object.prototype.hasOwnProperty.call(loaders, node.slug),
        `${node.slug} missing from loaders`,
      ).toBe(true);
    }
  });

  it('has no duplicate slugs', () => {
    const seen = new Set<string>();
    for (const node of NODES) {
      expect(seen.has(node.slug), `duplicate ${node.slug}`).toBe(false);
      seen.add(node.slug);
    }
  });
});
