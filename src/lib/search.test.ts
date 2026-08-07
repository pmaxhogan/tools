import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  highlightHtml,
  searchTools,
  tokenize,
  type SearchTool,
} from './search';

const tool = (over: Partial<SearchTool>): SearchTool => ({
  slug: 'x',
  name: 'X',
  description: '',
  category: 'Misc',
  keywords: [],
  ...over,
});

describe('tokenize', () => {
  it('splits, lowercases, dedupes, drops empties', () => {
    expect(tokenize('  Foo   BAR foo ')).toEqual(['foo', 'bar']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('escapeHtml', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &#39; f'
    );
  });
});

describe('highlightHtml', () => {
  it('wraps a case-insensitive match and escapes the rest', () => {
    expect(highlightHtml('JSON Formatter', 'json')).toBe('<mark>JSON</mark> Formatter');
  });

  it('escapes markup in both matched and unmatched segments (no offset drift)', () => {
    // The ampersand sits before the match; escaping must not shift offsets.
    expect(highlightHtml('a & bcd', 'bcd')).toBe('a &amp; <mark>bcd</mark>');
    expect(highlightHtml('<b>', 'b')).toBe('&lt;<mark>b</mark>&gt;');
  });

  it('treats regex metacharacters in the query as literal text', () => {
    expect(highlightHtml('use c++ here', 'c++')).toBe('use <mark>c++</mark> here');
    expect(highlightHtml('(x) group', '(x)')).toBe('<mark>(x)</mark> group');
  });

  it('merges overlapping and touching ranges into a single mark', () => {
    expect(highlightHtml('aaa', 'aa a')).toBe('<mark>aaa</mark>');
  });

  it('highlights every token of a multi-token query', () => {
    expect(highlightHtml('red green blue', 'blue red')).toBe(
      '<mark>red</mark> green <mark>blue</mark>'
    );
  });

  it('returns escaped text unchanged when the query is empty or has no match', () => {
    expect(highlightHtml('a & b', '')).toBe('a &amp; b');
    expect(highlightHtml('a & b', 'zzz')).toBe('a &amp; b');
  });
});

describe('searchTools', () => {
  const tools: SearchTool[] = [
    tool({ slug: 'json-formatter', name: 'JSON Formatter', category: 'Data' }),
    tool({
      slug: 'color-picker',
      name: 'Color Picker',
      description: 'Pick colors from a wheel',
      searchTerms: ['colour'],
    }),
    tool({
      slug: 'regex-tester',
      name: 'Pattern Tester',
      keywords: ['regex', 'regular expression'],
    }),
    tool({
      slug: 'notes',
      name: 'Notes',
      description: 'a note about json somewhere in the body',
    }),
  ];

  it('returns every tool in input order for an empty query', () => {
    const r = searchTools(tools, '   ');
    expect(r.map((x) => x.tool.slug)).toEqual(tools.map((t) => t.slug));
    expect(r.every((x) => x.score === 0)).toBe(true);
  });

  it('ranks a name hit above an incidental description hit', () => {
    const r = searchTools(tools, 'json');
    expect(r.map((x) => x.tool.slug)).toEqual(['json-formatter', 'notes']);
  });

  it('finds a tool via a hidden searchTerms synonym', () => {
    const r = searchTools(tools, 'colour');
    expect(r[0]?.tool.slug).toBe('color-picker');
  });

  it('finds a tool via a keyword the name never contains', () => {
    const r = searchTools(tools, 'regex');
    expect(r[0]?.tool.slug).toBe('regex-tester');
  });

  it('ranks an exact name above a synonym-only match', () => {
    const t = [
      tool({ slug: 'a', name: 'colour', category: 'Misc' }),
      tool({ slug: 'b', name: 'Picker', searchTerms: ['colour'] }),
    ];
    const r = searchTools(t, 'colour');
    expect(r.map((x) => x.tool.slug)).toEqual(['a', 'b']);
  });

  it('applies AND across tokens', () => {
    const r = searchTools(tools, 'json wheel');
    expect(r).toHaveLength(0);
    const r2 = searchTools(tools, 'color wheel');
    expect(r2.map((x) => x.tool.slug)).toEqual(['color-picker']);
  });

  it('is graceful when searchTerms is absent', () => {
    expect(() => searchTools([tool({ name: 'Plain' })], 'plain')).not.toThrow();
  });
});
