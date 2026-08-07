import { describe, expect, it } from 'vitest';
import { run, encodeSvgForDataUri } from './index';
import { ToolError } from '../types';

const DEFAULT_OPTS = {
  width: 600,
  height: 400,
  background: '#e2e8f0',
  foreground: '#64748b',
  label: '',
};

describe('placeholder-image', () => {
  it('shows dimensions as the default label', () => {
    const out = run(undefined, DEFAULT_OPTS);
    expect(out['SVG markup']).toContain('600×400');
    expect(out['SVG markup']).toContain('width="600"');
    expect(out['SVG markup']).toContain('height="400"');
  });

  it('uses a custom label when provided', () => {
    const out = run(undefined, { ...DEFAULT_OPTS, label: 'Hero image' });
    expect(out['SVG markup']).toContain('Hero image');
    expect(out['SVG markup']).not.toContain('600×400');
  });

  it('produces all four expected output rows', () => {
    const out = run(undefined, DEFAULT_OPTS);
    expect(Object.keys(out).sort()).toEqual(
      ['CSS background', 'Data URI', 'HTML img tag', 'SVG markup'].sort()
    );
    expect(out['Data URI']).toMatch(/^data:image\/svg\+xml,/);
    expect(out['HTML img tag']).toMatch(/^<img /);
    expect(out['CSS background']).toMatch(/^background-image: url\(/);
  });

  it('rejects an invalid background color, naming the bad value', () => {
    expect(() => run(undefined, { ...DEFAULT_OPTS, background: 'not-a-color' })).toThrowError(
      ToolError
    );
    try {
      run(undefined, { ...DEFAULT_OPTS, background: 'not-a-color' });
    } catch (e) {
      expect((e as ToolError).message).toContain('not-a-color');
      expect((e as ToolError).fix).toMatch(/hex color/);
    }
  });

  it('rejects an invalid foreground color, naming the bad value', () => {
    expect(() => run(undefined, { ...DEFAULT_OPTS, foreground: '#zzzzzz' })).toThrowError(
      /#zzzzzz/
    );
  });

  it('accepts 3-digit and 6-digit hex colors', () => {
    expect(() => run(undefined, { ...DEFAULT_OPTS, background: '#fff' })).not.toThrow();
    expect(() => run(undefined, { ...DEFAULT_OPTS, background: '#ffffff' })).not.toThrow();
  });

  it('round-trips the data URI back to SVG containing the label', () => {
    const out = run(undefined, { ...DEFAULT_OPTS, label: 'Round Trip' });
    const payload = out['Data URI'].replace(/^data:image\/svg\+xml,/, '');
    const decoded = decodeURIComponent(payload);
    expect(decoded).toContain('Round Trip');
    expect(decoded).toContain('<svg');
  });

  it('clamps/errors on sizes outside 1-4000', () => {
    expect(() => run(undefined, { ...DEFAULT_OPTS, width: 0 })).toThrowError(ToolError);
    expect(() => run(undefined, { ...DEFAULT_OPTS, width: 4001 })).toThrowError(
      /between 1 and 4000/
    );
    expect(() => run(undefined, { ...DEFAULT_OPTS, height: -5 })).toThrowError(ToolError);
    expect(() => run(undefined, { ...DEFAULT_OPTS, height: 5000 })).toThrowError(
      /between 1 and 4000/
    );
  });

  it('accepts the boundary sizes 1 and 4000', () => {
    expect(() => run(undefined, { ...DEFAULT_OPTS, width: 1, height: 1 })).not.toThrow();
    expect(() => run(undefined, { ...DEFAULT_OPTS, width: 4000, height: 4000 })).not.toThrow();
  });

  it('escapes XML-sensitive characters in a custom label', () => {
    const out = run(undefined, { ...DEFAULT_OPTS, label: '<script>&"test"</script>' });
    expect(out['SVG markup']).not.toContain('<script>');
    expect(out['SVG markup']).toContain('&lt;script&gt;');
  });

  it('encodeSvgForDataUri only percent-encodes the necessary characters', () => {
    const encoded = encodeSvgForDataUri('<svg width="10">  a   b</svg>');
    expect(encoded).toBe('%3Csvg%20width=%2210%22%3E%20a%20b%3C/svg%3E');
    expect(decodeURIComponent(encoded)).toBe('<svg width="10"> a b</svg>');
  });
});
