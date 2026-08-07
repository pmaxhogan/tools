import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('url-parser', () => {
  it('parses a URL with multiple and repeated query params', () => {
    const out = run('https://example.com/search?q=a+b&tag=x&tag=y', {});
    expect(out['Scheme']).toBe('https:');
    expect(out['Host']).toBe('example.com');
    expect(out['Port']).toBe('443 (default)');
    expect(out['Path']).toBe('/search');
    expect(out['? q']).toBe('a b');
    expect(out['? tag']).toBe('x');
    expect(out['? tag [2]']).toBe('y');
    expect(out['Origin']).toBe('https://example.com');
  });

  it('decodes unicode in query params and fragment', () => {
    const out = run('https://example.com/?name=%C3%A9#caf%C3%A9', {});
    expect(out['? name']).toBe('é');
    expect(out['Fragment']).toBe('café');
    expect(out['Decoded URL']).toContain('é');
  });

  it('auto-prefixes scheme-less input and notes it', () => {
    const out = run('example.com/path?x=1', {});
    expect(out['Note']).toMatch(/https:\/\//);
    expect(out['Scheme']).toBe('https:');
    expect(out['Host']).toBe('example.com');
    expect(out['? x']).toBe('1');
  });

  it('flags suspicious userinfo as a phishing pattern', () => {
    const out = run('https://user:pass@example.com/login', {});
    expect(out['Warning']).toMatch(/phishing/);
    expect(out['Host']).toBe('example.com');
  });

  it('shows an explicit port without the "(default)" suffix', () => {
    const out = run('https://example.com:8443/', {});
    expect(out['Port']).toBe('8443');
  });

  it('rejects garbage input with an actionable error', () => {
    expect(() => run('not a url at all!!! ###', {})).toThrowError(ToolError);
    try {
      run('not a url at all!!! ###', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('unparseable-url');
      expect((e as ToolError).fix).toBeTruthy();
    }
  });

  it('rejects empty input', () => {
    expect(() => run('', {})).toThrowError(ToolError);
    try {
      run('', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });
});
