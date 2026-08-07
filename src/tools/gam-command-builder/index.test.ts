import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import { expand, fillExample, placeholders, run, search } from './index';
import { CATEGORIES, RECIPES, type Recipe } from './data';

const BASE = { category: 'all', gamadv: false };

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

function byId(id: string): Recipe {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`test fixture missing: no recipe with id "${id}"`);
  return r;
}

describe('search', () => {
  it('finds the suspend recipe from plain English', () => {
    const out = run('suspend user', BASE);
    expect(out.Task).toContain('user-suspend');
    expect(out.Command).toBe(byId('user-suspend').template);
  });

  it('does not confuse suspending with unsuspending', () => {
    const suspend = run('suspend user', BASE);
    const unsuspend = run('unsuspend user', BASE);
    expect(unsuspend.Task).toContain('user-unsuspend');
    expect(suspend.Command).toBe('gam update user <user> suspended on');
    expect(unsuspend.Command).toBe('gam update user <user> suspended off');
  });

  it('AND-s the query words, so more words means fewer hits', () => {
    const wide = search('user', 'all', false).length;
    const narrow = search('user suspend', 'all', false).length;
    expect(wide).toBeGreaterThan(1);
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBeGreaterThan(0);
  });

  it('matches on the template and the notes, not only the task label', () => {
    const hits = search('drivefileacl', 'all', false);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.recipe.category).toBe('drive');
  });

  it('lists several matches when nothing wins outright', () => {
    const out = run('user', BASE);
    expect(out.Matches).toMatch(/recipes match/);
    expect(Object.keys(out).length).toBeGreaterThan(3);
  });
});

describe('id lookup', () => {
  it('expands a recipe and assembles the example from the parameter examples', () => {
    const recipe = byId('user-suspend');
    const out = run('user-suspend', BASE);

    expect(out.Command).toBe(recipe.template);
    expect(out['Example command']).toBe(fillExample(recipe));
    expect(out['Example command']).toBe('gam update user jdoe@example.com suspended on');
    for (const p of recipe.params) {
      expect(out[`<${p.name}>`]).toContain(p.example);
      expect(out['Example command']).toContain(p.example);
    }
  });

  it('assembles a multi command recipe line by line', () => {
    const out = run('user-offboard', BASE);
    const lines = out['Example command'].split('\n');
    expect(lines.length).toBeGreaterThan(4);
    expect(lines[0]).toBe('gam user jdoe@example.com deprovision popimap signout turnoff2sv');
    expect(out['Example command']).not.toContain('<');
  });

  it('is case insensitive and ignores the category filter', () => {
    const out = run('  USER-SUSPEND  ', { category: 'gmail', gamadv: false });
    expect(out.Command).toBe(byId('user-suspend').template);
  });

  it('gives every recipe a complete, placeholder free example', () => {
    for (const r of RECIPES) {
      const out = expand(r, false);
      expect(out['Example command'], r.id).not.toContain('<');
      expect(out.Command, r.id).toBe(r.template);
      expect(out.Notes, r.id).not.toBe('');
    }
  });
});

describe('category option', () => {
  it('restricts the pool to one category', () => {
    for (const c of CATEGORIES) {
      const hits = search('a', c.id, false);
      for (const h of hits) expect(h.recipe.category, c.id).toBe(c.id);
    }
  });

  it('hides recipes outside the chosen category', () => {
    const out = run('suspend', { category: 'drive', gamadv: false });
    expect(Object.keys(out)).toEqual(['No matches']);
  });

  it('still finds the recipe in its own category', () => {
    const out = run('suspend', { category: 'users', gamadv: false });
    expect(Object.keys(out)).not.toEqual(['No matches']);
  });

  it('rejects an unknown category', () => {
    expect(() => run('suspend user', { category: 'printers', gamadv: false })).toThrow(ToolError);
    try {
      run('suspend user', { category: 'printers', gamadv: false });
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('unknown-category');
      expect(err.fix).toContain('users');
    }
  });

  it('has at least four recipes in every category', () => {
    for (const c of CATEGORIES) {
      const n = RECIPES.filter((r) => r.category === c.id).length;
      expect(n, c.id).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('gamadv option', () => {
  const gamadvOnly = RECIPES.find((r) => r.variant === 'gamadv');
  const gam7Only = RECIPES.find((r) => r.variant === 'gam7');

  it('has recipes for both forks', () => {
    expect(gamadvOnly).toBeDefined();
    expect(gam7Only).toBeDefined();
  });

  it('marks a GAMADV-XTD3 recipe as unavailable when the reader runs GAM7', () => {
    const out = run(gamadvOnly!.id, BASE);
    expect(out['GAM version']).toContain('GAMADV-XTD3 only');
  });

  it('stops marking it once the GAMADV-XTD3 switch is on', () => {
    const out = run(gamadvOnly!.id, { category: 'all', gamadv: true });
    expect(out['GAM version']).not.toContain('only');
    expect(out['GAM version']).toContain('GAMADV-XTD3 syntax');
  });

  it('marks GAM7 only recipes when the GAMADV-XTD3 switch is on', () => {
    const off = run(gam7Only!.id, BASE);
    const on = run(gam7Only!.id, { category: 'all', gamadv: true });
    expect(on['GAM version']).toContain('GAMADV-XTD3 spells this one differently');
    expect(on['GAM version']).toContain('before you run it');
    expect(off['GAM version']).toContain('GAM7 syntax');
  });

  it('accepts the string "true" the curl endpoint sends', () => {
    const out = run(gamadvOnly!.id, { category: 'all', gamadv: 'true' as unknown as boolean });
    expect(out['GAM version']).toContain('GAMADV-XTD3 syntax');
    expect(out['GAM version']).not.toContain('only');
  });

  it('says nothing about forks for a recipe both accept', () => {
    const out = run('user-suspend', BASE);
    expect(out['GAM version']).toContain('both GAM7 and GAMADV-XTD3');
  });

  it('switches which fork is preferred in the ranking', () => {
    const at = (hits: ReturnType<typeof search>, id: string) =>
      hits.findIndex((h) => h.recipe.id === id);

    const forGam7 = search('', 'all', false);
    const forXtd3 = search('', 'all', true);

    expect(at(forXtd3, gamadvOnly!.id)).toBeLessThan(at(forGam7, gamadvOnly!.id));
    expect(at(forGam7, gam7Only!.id)).toBeLessThan(at(forXtd3, gam7Only!.id));
  });

  it('never puts a mismatched fork above a matching one at the same score', () => {
    for (const gamadv of [false, true]) {
      const hits = search('user', 'all', gamadv);
      const rank = (r: Recipe) => {
        const v = r.variant ?? 'both';
        if (v === 'both') return 0;
        return (gamadv ? v === 'gamadv' : v === 'gam7') ? 0 : 1;
      };
      for (let i = 1; i < hits.length; i++) {
        if (hits[i].score !== hits[i - 1].score) continue;
        expect(rank(hits[i - 1].recipe)).toBeLessThanOrEqual(rank(hits[i].recipe));
      }
    }
  });

  it('tags a mismatched fork in the list rows too', () => {
    const rows = Object.values(run('org unit', { category: 'org-units', gamadv: false }));
    expect(rows.join(' ')).toContain('[GAMADV-XTD3 only]');
  });
});

describe('destructive recipes', () => {
  it('warns before a mobile wipe, right under the command', () => {
    const out = run('mobile-wipe', BASE);
    expect(out['Read this first']).toMatch(/test account or a small test org unit/);
    expect(out['Read this first']).toMatch(/without the doit argument/);
    const keys = Object.keys(out);
    expect(keys.indexOf('Read this first')).toBe(keys.indexOf('Command') + 1);
  });

  it('warns before a ChromeOS deprovision', () => {
    const out = run('cros-deprovision', BASE);
    expect(out['Read this first']).toBeDefined();
  });

  it('never warns on a read only recipe', () => {
    const out = run('user-print-all', BASE);
    expect(out['Read this first']).toBeUndefined();
  });

  it('calls destructive out in list rows as well', () => {
    const rows = Object.entries(run('messages', BASE));
    const destructive = rows.filter(([, v]) => v.includes('Destructive.'));
    expect(destructive.length).toBeGreaterThan(0);
  });

  it('flags every recipe whose template deletes, wipes, trashes or deprovisions', () => {
    for (const r of RECIPES) {
      const writes = /\b(delete|wipe|trash|deprovision)\b/.test(r.template);
      const readsOnly = /\b(print|show)\b/.test(r.template);
      if (writes && !readsOnly)
        expect(r.destructive, `${r.id} looks destructive but is not flagged`).toBe(true);
    }
  });

  it('gives every destructive recipe at least one note', () => {
    for (const r of RECIPES) {
      if (r.destructive) expect(r.notes.length, r.id).toBeGreaterThan(0);
    }
  });
});

describe('bad and empty input', () => {
  it('throws on empty input', () => {
    expect(() => run('', BASE)).toThrow(ToolError);
    expect(() => run('   ', BASE)).toThrow(ToolError);
    try {
      run('', BASE);
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('empty-input');
      expect(err.fix).toContain('suspend a user');
    }
  });

  it('returns an honest no-match with the category list', () => {
    const out = run('provision a kubernetes cluster', BASE);
    expect(Object.keys(out)).toEqual(['No matches']);
    for (const id of CATEGORY_IDS) expect(out['No matches']).toContain(id);
    expect(out['No matches']).toContain('not the whole of GAM');
  });
});

describe('data integrity', () => {
  it('has enough recipes to be useful', () => {
    expect(RECIPES.length).toBeGreaterThanOrEqual(60);
  });

  it('has unique ids and unique task labels', () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    expect(new Set(RECIPES.map((r) => r.task)).size).toBe(RECIPES.length);
  });

  it('uses lowercase hyphenated ids', () => {
    for (const r of RECIPES) expect(r.id, r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('uses only the declared categories and variants', () => {
    for (const r of RECIPES) {
      expect(CATEGORY_IDS, r.id).toContain(r.category);
      if (r.variant !== undefined) expect(['gam7', 'gamadv', 'both'], r.id).toContain(r.variant);
    }
  });

  it('declares every placeholder as a parameter and uses every parameter', () => {
    for (const r of RECIPES) {
      const inTemplate = placeholders(r.template);
      const declared = r.params.map((p) => p.name);
      for (const name of inTemplate)
        expect(declared, `${r.id}: <${name}> is not in params`).toContain(name);
      for (const name of declared)
        expect(inTemplate, `${r.id}: param ${name} is never used`).toContain(name);
      expect(new Set(declared).size, `${r.id}: duplicate param`).toBe(declared.length);
    }
  });

  it('gives every parameter a description and a bracket free example', () => {
    for (const r of RECIPES) {
      for (const p of r.params) {
        expect(p.description.length, `${r.id}/${p.name}`).toBeGreaterThan(5);
        expect(p.description.trim().endsWith('.'), `${r.id}/${p.name}`).toBe(true);
        expect(p.example.length, `${r.id}/${p.name}`).toBeGreaterThan(0);
        expect(p.example, `${r.id}/${p.name}`).not.toMatch(/[<>]/);
        expect(typeof p.required, `${r.id}/${p.name}`).toBe('boolean');
      }
    }
  });

  it('has a non-empty template that starts with gam', () => {
    for (const r of RECIPES) {
      expect(r.template.trim().length, r.id).toBeGreaterThan(0);
      expect(r.template, r.id).toMatch(/^(MSYS_NO_PATHCONV=1 )?gam /);
      expect(r.task.trim().length, r.id).toBeGreaterThan(0);
      for (const line of r.template.split('\n'))
        expect(line, r.id).toMatch(/^(MSYS_NO_PATHCONV=1 )?gam /);
    }
  });

  it('ends every note as a sentence', () => {
    for (const r of RECIPES) {
      for (const n of r.notes) {
        expect(n.trim().length, r.id).toBeGreaterThan(10);
        expect(n.trim().endsWith('.'), `${r.id}: "${n}"`).toBe(true);
      }
    }
  });

  it('has no em dashes or en dashes anywhere in the data', () => {
    const strings: string[] = [];
    for (const c of CATEGORIES) strings.push(c.id, c.label);
    for (const r of RECIPES) {
      strings.push(r.id, r.task, r.category, r.template, ...r.notes);
      for (const p of r.params) strings.push(p.name, p.description, p.example);
    }
    for (const s of strings) expect(s, s).not.toMatch(/[–—]/);
  });

  it('has no em dashes or en dashes in the tool output', () => {
    for (const r of RECIPES) {
      for (const gamadv of [false, true]) {
        const out = expand(r, gamadv);
        for (const [k, v] of Object.entries(out)) {
          expect(k, r.id).not.toMatch(/[–—]/);
          expect(v, r.id).not.toMatch(/[–—]/);
        }
      }
    }
  });
});
