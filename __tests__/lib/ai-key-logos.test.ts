/**
 * Provider logos and the line under each provider (#553). Every logo a catalog entry names is a real, one-colour file in
 * `public/ai-providers/`, and the line under a More provider says something true from the models.dev numbers.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import snapshot from '@/lib/ai-key-snapshot.json';
import { AI_KEY_KINDS, moreBenefit } from '@/lib/ai-key-kinds';
import { isPlainSvg } from '@/scripts/plain-svg.mjs';

const FOLDER = join(process.cwd(), 'public', 'ai-providers');
const file = (logo: string) => join(FOLDER, `${logo}.svg`);

describe('provider logos', () => {
  it('gives every kind that names a logo a file, drawn in one colour so it can take the page ink', () => {
    const named = AI_KEY_KINDS.filter((entry) => entry.logo);
    expect(named.length).toBeGreaterThan(40);
    for (const entry of named) {
      expect(existsSync(file(entry.logo!))).toBe(true);
      expect(readFileSync(file(entry.logo!), 'utf8')).toContain('currentColor');
    }
  });

  it('gives every named provider a logo, except "any server", which gets a plug', () => {
    for (const entry of AI_KEY_KINDS.filter((item) => item.tier === 'named')) {
      if (entry.kind === 'custom') expect(entry).toMatchObject({ plainIcon: 'plug' });
      else expect(entry.logo).toBeTruthy();
    }
  });

  it('keeps only plain shapes in every logo file: no script, handlers or addresses', () => {
    const names = readdirSync(FOLDER);
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) expect([name, isPlainSvg(readFileSync(join(FOLDER, name), 'utf8'))]).toEqual([name, true]);
    expect(isPlainSvg('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(isPlainSvg('<svg onload="x()"><path d="M0 0"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><foreignObject/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><a href="javascript:x()"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><path fill="currentColor" d="M0 0h8v8z"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><path d="M0 0" onclick="x()"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><path d="M0 0" style="fill:url(https://x.test/a.svg#b)"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><!-- note --><path d="M0 0"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><![CDATA[x]]><path d="M0 0"/></svg>')).toBe(false);
    expect(isPlainSvg('<svg><path d="M0 0"></svg>')).toBe(false);
    expect(isPlainSvg('<svg viewBox="0 0 8 8"><path fill="currentColor" d="M0 0h8v8z"/></svg>')).toBe(true);
  });

  it('keeps no logo file nothing uses', () => {
    const used = new Set(AI_KEY_KINDS.map((entry) => entry.logo).filter(Boolean));
    const unused = readdirSync(FOLDER).filter((name) => !used.has(name.replace(/\.svg$/, '')));
    expect(unused).toEqual([]);
  });

  it('marks in the snapshot only the providers that have a file', () => {
    for (const provider of snapshot.providers) {
      expect(existsSync(file(provider.id))).toBe('logo' in provider);
    }
  });
});

describe('the line under a provider in More providers', () => {
  it.each([
    [{ models: 125, open: 32, free: 0 }, 'One key for 125 models from many makers, open and closed.'],
    [{ models: 132, open: 53, free: 47 }, 'One key for 132 models from many makers, open and closed. 47 free.'],
    [{ models: 26, open: 26, free: 0 }, '26 models, all open.'],
    [{ models: 7, open: 7, free: 7 }, '7 models, all open. 7 free.'],
    [{ models: 12, open: 12, free: 2 }, '12 models, all open. 2 free.'],
    [{ models: 5, open: 0, free: 0 }, 'Its own 5 models.'],
    [{ models: 1, open: 0, free: 0 }, 'Its own model.'],
    [{ models: 9, open: 7, free: 0 }, '9 models, mostly open.'],
    [{ models: 6, open: 2, free: 0 }, '6 models, open and closed.'],
    [{ models: 57, open: 56, free: 0 }, '57 models, mostly open.'],
    [{ models: 86, open: 80, free: 1 }, '86 models, mostly open. 1 free.'],
    [{ models: 630, open: 362, free: 2 }, 'One key for 630 models from many makers, open and closed. 2 free.'],
    [{ models: 105, open: 54, free: 2 }, 'One key for 105 models from many makers, open and closed. 2 free.'],
    [{ models: 0 }, 'Serves models over the OpenAI format.'],
  ])('%j reads "%s"', (facts, line) => {
    expect(moreBenefit(facts)).toBe(line);
  });

  it('has a real line for every More provider, never the old template', () => {
    const more = AI_KEY_KINDS.filter((entry) => entry.tier === 'more');
    expect(more.length).toBe(snapshot.providers.length);
    for (const entry of more) {
      expect(entry.benefit).not.toMatch(/models\.dev|tried/i);
      expect(entry.benefit).toMatch(/model/);
    }
  });
});
