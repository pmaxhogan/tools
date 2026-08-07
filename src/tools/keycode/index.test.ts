import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('keycode', () => {
  it('parses a full event', () => {
    const out = run(
      JSON.stringify({
        key: 'k',
        code: 'KeyK',
        keyCode: 75,
        which: 75,
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        repeat: false,
        location: 0,
      }),
      {}
    );
    expect(out['Key']).toBe('k');
    expect(out['Code']).toBe('KeyK');
    expect(out['keyCode (deprecated)']).toBe('75');
    expect(out['which (deprecated)']).toBe('75');
    expect(out['Modifiers']).toBe('Ctrl + Shift');
    expect(out['Location']).toBe('standard');
    expect(out['Repeat']).toBe('no');
    expect(out['Event summary']).toBe('Ctrl+Shift+K');
  });

  it('tolerates a minimal event with only key', () => {
    const out = run(JSON.stringify({ key: 'Enter' }), {});
    expect(out['Key']).toBe('Enter');
    expect(out['Code']).toBe('(none)');
    expect(out['keyCode (deprecated)']).toBe('(none)');
    expect(out['which (deprecated)']).toBe('(none)');
    expect(out['Modifiers']).toBe('none');
    expect(out['Location']).toBe('standard');
    expect(out['Repeat']).toBe('no');
    expect(out['Event summary']).toBe('Enter');
  });

  it('rejects malformed JSON with an actionable error', () => {
    expect(() => run('{not valid json', {})).toThrowError(ToolError);
    try {
      run('{not valid json', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-json');
      expect((e as ToolError).fix).toMatch(/"key":"k"/);
    }
  });

  it('formats modifier combinations, including multiple and none', () => {
    const all = run(
      JSON.stringify({
        key: 'a',
        shiftKey: true,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      }),
      {}
    );
    expect(all['Modifiers']).toBe('Ctrl + Alt + Shift + Meta');
    expect(all['Event summary']).toBe('Ctrl+Alt+Shift+Meta+A');

    const none = run(JSON.stringify({ key: 'a' }), {});
    expect(none['Modifiers']).toBe('none');
  });

  it('renders the space key specially', () => {
    const out = run(JSON.stringify({ key: ' ', code: 'Space' }), {});
    expect(out['Key']).toBe("Space (' ')");
    expect(out['Event summary']).toBe('Space');
  });

  it('maps location numbers to names', () => {
    expect(run(JSON.stringify({ key: 'a', location: 0 }), {})['Location']).toBe('standard');
    expect(run(JSON.stringify({ key: 'a', location: 1 }), {})['Location']).toBe('left');
    expect(run(JSON.stringify({ key: 'a', location: 2 }), {})['Location']).toBe('right');
    expect(run(JSON.stringify({ key: 'a', location: 3 }), {})['Location']).toBe('numpad');
  });
});
