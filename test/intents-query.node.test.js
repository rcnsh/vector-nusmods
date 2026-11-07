// @ts-check
// 3H's query side, parse step 4 (docs/plans/phase3.md 3H, prereg §3 step 4
// and §7 "3H"): pass A matches the no-exam, S/U, workload and prerequisite
// phrases leftmost-longest, strips them from the lexical query before any
// code join (C-4, C3-1), and echoes them in `interpreted`. The dense query is
// raw or stripped by the variant in force.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTENT_VARIANT, INTENT_VARIANTS, compileConstraintPhrases, passA } from '../src/intents.js';
import { buildIntentContext, parseQuery } from '../src/query-intent.js';
import { buildVocabulary, parseVocabulary } from '../src/vocabulary.js';

const phrases = compileConstraintPhrases(JSON.parse(readFileSync(new URL('../data/constraint-phrases.json', import.meta.url), 'utf8')));
const MODULES = [
  { title: 'Introduction to Sociology', description: 'Society and culture.' },
  { title: 'Creative Writing', description: 'Fiction and poetry writing.' },
  { title: 'Discrete Structures', description: 'Logic, sets and proofs.' },
  { title: 'Final Year Project', description: 'An independent project.' },
];
const vocabulary = parseVocabulary(buildVocabulary(MODULES, { corpus: 'fixture', dataVersion: 'x' }));
/** @param {Partial<{ prereq: 'i' | 'ii', dense: 'raw' | 'stripped' }>} [variant] */
const ctxOf = (variant = {}) => buildIntentContext({
  prefixes: ['CS', 'SC'], catalogueCodes: [], collision: [],
  ge: { prefixes: [], genericPhrases: [], pillars: [] }, stopwords: [],
  isOffered: (/** @type {string} */ c) => ['CS1231', 'CS1231S'].includes(c), vocabulary,
  constraintPhrases: phrases, intentVariant: { prereq: 'i', dense: 'stripped', ...variant },
});
const parse = (/** @type {string} */ q, /** @type {string[]} */ ignore = [], variant = {}) => parseQuery(q, ctxOf(variant), ignore);

describe('passA', () => {
  it('reads each family and strips its phrase', () => {
    expect(passA('sociology without final exam', phrases, new Set())).toMatchObject({ text: 'sociology', exam: true });
    expect(passA('s/u-able math', phrases, new Set())).toMatchObject({ text: 'math', su: true });
    expect(passA('light workload electives', phrases, new Set())).toMatchObject({ text: 'electives', hoursBelow: 10 });
    expect(passA('history under 6 hours', phrases, new Set())).toMatchObject({ text: 'history', hoursBelow: 6 });
    expect(passA('law < 12 hours', phrases, new Set())).toMatchObject({ text: 'law', hoursBelow: 12 });
    expect(passA('no prerequisites calculus', phrases, new Set())).toMatchObject({ text: 'calculus', prereq: true });
    expect(passA('no background in coding', phrases, new Set())).toMatchObject({ text: 'in coding', prereq: true });
  });

  it('is leftmost-longest: `without final exam` strips `exam` too (C2-6); a phrase needs word boundaries', () => {
    expect(passA('without final exams please', phrases, new Set()).text).toBe('please');
    expect(passA('no-exam modules', phrases, new Set())).toMatchObject({ text: 'modules', exam: true });
    expect(passA('noexam modules', phrases, new Set())).toMatchObject({ text: 'noexam modules', exam: false });
  });

  it('N is an integer 1-99 (C26); the smallest of several hour limits holds', () => {
    expect(passA('under 0 hours', phrases, new Set()).hoursBelow).toBeNull();
    expect(passA('under 100 hours', phrases, new Set()).hoursBelow).toBeNull();
    expect(passA('light workload under 6 hours', phrases, new Set()).hoursBelow).toBe(6);
  });

  it('an ignored intent\'s phrases are not read and stay in the text', () => {
    expect(passA('s/u math', phrases, new Set(['su']))).toMatchObject({ text: 's/u math', su: false });
    expect(passA('no exam math', phrases, new Set(['exam']))).toMatchObject({ text: 'no exam math', exam: false });
  });
});

describe('parseQuery step 4', () => {
  it('echoes the intents in `interpreted`, with the prereq semantics in force', () => {
    const p = parse('sociology s/u no prereq without final exam under 8 hours');
    expect(p.interpreted).toMatchObject({
      exam: 0, su: { value: 1, basis: ['CS/CU', 'su'] }, hoursBelow: 8, prereq: { value: 'none', semantics: 'i' },
    });
    expect(parse('linguistics no prerequisite', [], { prereq: 'ii' }).interpreted.prereq).toEqual({ value: 'none', semantics: 'ii' });
    expect(p.constraints).toEqual({ exam: 0, su: 1, hoursBelow: 8, prereq: 'none' });
    expect(parse('sociology').constraints).toEqual({});
  });

  it('strips the phrases from the lexical query (C-4): `final` no longer reaches FTS', () => {
    expect(parse('no finals creative writing').lexical).toBe('creative writing');
  });

  it('strips before the code joins: `cs1231 s/u` pins CS1231, never CS1231S', () => {
    const p = parse('cs1231 s/u');
    expect(p.pins).toEqual(['CS1231']);
    expect(p.interpreted.su).not.toBeNull();
  });

  it('the dense query is stripped or raw by the variant; never empty', () => {
    expect(parse('no finals creative writing', [], { dense: 'stripped' }).dense).toBe('creative writing');
    expect(parse('no finals creative writing', [], { dense: 'raw' }).dense).toBe('no finals creative writing');
    expect(parse('no exams', [], { dense: 'stripped' }).dense).toBe('no exams');
  });

  it('a 3H intent is a signal: 3G never fires on it', () => {
    expect(parse('xqzv no exam').noSignal).toBe(false);
  });
});

describe('the variants (prereg §7, grids.json [3H])', () => {
  it('are the four pooled points, and the variant in force is one of them', () => {
    const grid = JSON.parse(readFileSync(new URL('../eval/prereg/grids.json', import.meta.url), 'utf8'))['3H'];
    expect(Object.values(INTENT_VARIANTS).map((v) => [v.prereq, v.dense])).toEqual(grid.pooled);
    expect(Object.keys(INTENT_VARIANTS)).toContain(INTENT_VARIANT);
  });
});
