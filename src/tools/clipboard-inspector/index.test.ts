import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';
import type { ClipboardSnapshot } from './index';

describe('clipboard-inspector', () => {
  it('reports text/plain and text/html entries plus the comparison row', () => {
    const snapshot: ClipboardSnapshot = {
      entries: [
        { type: 'text/plain', bytes: 11, text: 'hello world' },
        {
          type: 'text/html',
          bytes: 40,
          text: '<div><b>hello</b> world</div>',
        },
      ],
    };
    const out = run(JSON.stringify(snapshot), {});

    expect(out['text/plain']).toContain('11 bytes');
    expect(out['text/plain']).toContain('hello world');

    expect(out['text/html']).toContain('40 bytes');
    expect(out['text/html']).toContain('tags');
    expect(out['text/html']).toContain('<div>');

    expect(out.Formats).toContain('2 types');
    expect(out.Formats).toContain('text/plain');
    expect(out.Formats).toContain('text/html');

    expect(out['HTML vs plain text']).toBeDefined();
    expect(out['HTML vs plain text']).toMatch(/larger/);
  });

  it('describes an image/png entry using its data URL prefix and byte size', () => {
    const snapshot: ClipboardSnapshot = {
      entries: [{ type: 'image/png', bytes: 20480, dataUrlPrefix: 'data:image/png;base64' }],
    };
    const out = run(JSON.stringify(snapshot), {});

    expect(out['image/png']).toContain('KB');
    expect(out['image/png']).toContain('png');
    expect(out.Formats).toContain('1 type:');
  });

  it('returns a clear message when the clipboard has no entries', () => {
    const out = run(JSON.stringify({ entries: [] }), {});
    expect(out.Clipboard).toMatch(/empty/i);
  });

  it('collapses whitespace and truncates text previews at 200 characters', () => {
    const longText = 'word '.repeat(100); // 500 chars of repeated whitespace-separated text
    const snapshot: ClipboardSnapshot = {
      entries: [{ type: 'text/plain', bytes: longText.length, text: longText }],
    };
    const out = run(JSON.stringify(snapshot), {});
    expect(out['text/plain']).toContain('...');
  });

  it('throws invalid-snapshot on malformed JSON', () => {
    expect(() => run('{not valid json', {})).toThrowError(ToolError);
    try {
      run('{not valid json', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-snapshot');
      expect((e as ToolError).fix).toBeDefined();
    }
  });

  it('throws invalid-snapshot when entries is missing or malformed', () => {
    expect(() => run(JSON.stringify({}), {})).toThrowError(ToolError);
    expect(() => run(JSON.stringify({ entries: [{ bytes: 5 }] }), {})).toThrowError(ToolError);
    try {
      run(JSON.stringify({}), {});
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-snapshot');
    }
  });

  it('throws empty-input on an empty string', () => {
    expect(() => run('', {})).toThrowError(ToolError);
    try {
      run('', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
      expect((e as ToolError).fix).toMatch(/Read clipboard/);
    }
  });
});
