import { describe, expect, it } from 'vitest';
import { run, type SvgoOpts } from './index';
import { ToolError } from '../types';

const DEFAULTS: SvgoOpts = {
  multipass: true,
  precision: 3,
  keepViewBox: true,
  pretty: false,
  removeIds: false,
};

describe('svg-optimizer', () => {
  it('strips comments and editor cruft, and shrinks the file', () => {
    const svg = `<?xml version="1.0"?>
<!-- Created with Inkscape -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="100" height="50" viewBox="0 0 100 50" inkscape:version="1.0">
  <path inkscape:connector-curvature="0" d="M0.123456789,0.987654321 L10.111111,20.222222"/>
</svg>`;
    const out = run(svg, DEFAULTS);
    expect(out['Optimized SVG']).not.toMatch(/Inkscape/i);
    expect(out['Optimized SVG']).not.toMatch(/inkscape:/);
    expect(out['Optimized SVG']).not.toMatch(/<!--/);
    const before = Number(out.Before.match(/^([\d,]+)/)?.[1].replace(/,/g, ''));
    const after = Number(out.After.match(/^([\d,]+)/)?.[1].replace(/,/g, ''));
    expect(after).toBeLessThan(before);
    expect(out.Saved).toMatch(/%\)$/);
    expect(out.Passes).toBe('Multipass (on)');
  });

  it('keepViewBox true preserves viewBox, false removes it', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="10" height="10"/></svg>';
    const kept = run(svg, { ...DEFAULTS, keepViewBox: true });
    expect(kept['Optimized SVG']).toContain('viewBox');

    const dropped = run(svg, { ...DEFAULTS, keepViewBox: false });
    expect(dropped['Optimized SVG']).not.toContain('viewBox');
  });

  it('precision 1 rounds path decimals to one place', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0.123456,0.987654 L5.555555,5.111111"/></svg>';
    const out = run(svg, { ...DEFAULTS, precision: 1 });
    expect(out['Optimized SVG']).not.toMatch(/\d\.\d{2,}/);
  });

  it('pretty true adds newlines and reports growth honestly when the output is bigger', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>';
    const out = run(svg, { ...DEFAULTS, pretty: true });
    expect(out['Optimized SVG']).toMatch(/\n/);
    expect(out.Saved).toMatch(/^Grew by \d/);
  });

  it('removeIds false keeps ids, true strips unused ones', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect id="unused-rect-id" width="1" height="1"/></svg>';
    const kept = run(svg, { ...DEFAULTS, removeIds: false });
    expect(kept['Optimized SVG']).toContain('id="unused-rect-id"');

    const stripped = run(svg, { ...DEFAULTS, removeIds: true });
    expect(stripped['Optimized SVG']).not.toContain('id=');
  });

  it('throws invalid-svg on malformed XML', () => {
    try {
      run('<svg><path d="M0,0"></svg2>', DEFAULTS);
      throw new Error('expected run() to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('invalid-svg');
      expect((e as ToolError).fix).toMatch(/unclosed tags/);
    }
  });

  it('throws not-svg on plain text input', () => {
    try {
      run('just some plain text, not markup at all', DEFAULTS);
      throw new Error('expected run() to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('not-svg');
    }
  });

  it('throws empty-input on empty string', () => {
    expect(() => run('', DEFAULTS)).toThrowError(ToolError);
    try {
      run('   ', DEFAULTS);
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });
});
