import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

const ZWSP = '​';
const ZWJ = '‍';
const NBSP = ' ';
const BOM = '﻿';
const LRM = '‎';
const RLO = '‮';
const ALM = '؜'; // Arabic Letter Mark: Cf codepoint with no dedicated table entry.

describe('invisible-character-detector', () => {
  it('annotates mixed invisible characters inline with correct tags', () => {
    const input = `a${ZWSP}b${NBSP}c${ZWJ}d`;
    const out = run(input, { mode: 'annotate', keepNewlines: true });
    expect(out).toBe('a⟦ZWSP⟧b⟦NBSP⟧c⟦ZWJ⟧d');
  });

  it('annotates bidi controls, BOM, and tab with their tags', () => {
    const input = `${BOM}${LRM}hello\tworld${RLO}`;
    const out = run(input, { mode: 'annotate', keepNewlines: true });
    expect(out).toBe('⟦BOM⟧⟦LRM⟧hello⟦TAB⟧world⟦RLO⟧');
  });

  it('reports exact line and column for each finding, with a count summary', () => {
    const input = `a${ZWSP}bc`;
    const out = run(input, { mode: 'report', keepNewlines: true });
    expect(out).toBe(
      [
        'Line 1, Col 2: ZWSP (Zero-width space) U+200B',
        '',
        'Summary: 1 invisible character(s) in 4 characters. ZWSP x1.',
      ].join('\n'),
    );
  });

  it('flags mixed line endings (CRLF, lone CR, LF) in report mode', () => {
    const input = 'line1\r\nline2\nline3\rline4';
    const out = run(input, { mode: 'report', keepNewlines: true });
    expect(out).toMatch(/CR \(Carriage return\) U\+000D/);
    expect(out).toMatch(/Summary: 2 invisible character\(s\)/);
    expect(out).toMatch(/Line endings are mixed: CRLF, lone CR, LF\./);
  });

  it('strips invisibles and normalizes NBSP to a space', () => {
    const input = `a${ZWSP}b${NBSP}c${ZWJ}d`;
    const out = run(input, { mode: 'strip', keepNewlines: true });
    expect(out).toBe('ab cd');
  });

  it('round-trips already-clean text unchanged through strip', () => {
    const clean = 'plain text with no surprises';
    expect(run(clean, { mode: 'strip', keepNewlines: true })).toBe(clean);
  });

  it('folds CRLF and lone CR to LF when stripping with keepNewlines true', () => {
    const input = 'a\r\nb\rc';
    const out = run(input, { mode: 'strip', keepNewlines: true });
    expect(out).toBe('a\nb\nc');
  });

  it('drops line breaks entirely when stripping with keepNewlines false', () => {
    const input = 'a\r\nb\nc';
    const out = run(input, { mode: 'strip', keepNewlines: false });
    expect(out).toBe('abc');
  });

  it('throws a typed empty-input error with a fix suggestion', () => {
    expect(() => run('', { mode: 'annotate', keepNewlines: true })).toThrowError(ToolError);
    try {
      run('', { mode: 'annotate', keepNewlines: true });
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
      expect((e as ToolError).fix).toMatch(/Paste text/);
    }
  });

  it('returns a clear message when no invisible characters are found', () => {
    const clean = 'hello world';
    expect(run(clean, { mode: 'annotate', keepNewlines: true })).toBe(
      'No invisible characters found in 11 characters.',
    );
    expect(run(clean, { mode: 'report', keepNewlines: true })).toBe(
      'No invisible characters found in 11 characters.',
    );
  });

  it('catches other Cf-category codepoints via the generic fallback', () => {
    const input = `a${ALM}b`;
    const out = run(input, { mode: 'report', keepNewlines: true });
    expect(out).toMatch(/CF \(Format character U\+061C\) U\+061C/);
  });
});
