// @ts-check
// Search and exchange-mode findings (S3-S8, P1, P2) over the fixture corpus.
// Ranking quality itself (S2, S6) needs the real embedding model, so those are
// cited from the recorded live evidence in docs/FINDINGS.md instead.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, fixture, seed } from '../helpers.js';
import { codes, ftsCalls, recordingDb, shownCodes } from './support.js';

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

/** The FTS MATCH expression the Worker builds for `q`. */
async function matchExpression(/** @type {string} */ q) {
  /** @type {import('./support.js').DbCall[]} */
  const log = [];
  await callJson(`/search?q=${encodeURIComponent(q)}&mode=lexical`, { fakes, env: { DB: recordingDb(log) } });
  return ftsCalls(log)[0]?.binds[0];
}

describe('S3', () => {
  it('[S3 known-bug] the query is embedded verbatim, with no bge query instruction prefix', async () => {
    const before = fakes.ai.calls.length;
    await callJson('/search?q=machine%20learning%20prefix', { fakes });
    const [model, input] = /** @type {[string, { text: string[] }]} */ (fakes.ai.calls[before].args);
    expect(model).toBe('@cf/baai/bge-small-en-v1.5');
    expect(input).toEqual({ text: ['machine learning prefix'] });
  });
});

describe('S4', () => {
  // `code` stays UNINDEXED (0006 rationale); 3B's partial-code route replaces it.
  it.each(['CS32', 'GEA'])('[S4 fixed] "%s" routes to the modules with that prefix, though the code column stays UNINDEXED', async (q) => {
    const { body } = await callJson(`/search?q=${q}&mode=lexical&topK=50`, { fakes });
    const members = fixture.modules.map((m) => m.code).filter((c) => c >= (/\d$/.test(q) ? q : `${q}0`) && c < `${q}:`).sort();
    expect(members.length).toBeGreaterThan(0);
    expect(body.interpreted.prefix).toBe(q);
    // 3F: one result per duplicate group; the other members ride along as its variants.
    expect(shownCodes(body.results).sort()).toEqual(members);
  });

  it('[S4 known-bug] "modules", "intro", "teach" and "something" are not stopwords', async () => {
    // 3C writes a df-0 token as a prefix term (`"modules"*` in the fixture); the stopword list is unchanged.
    expect(String(await matchExpression('intro to modules that teach something')).replace(/\*/g, '')).toBe(
      '"intro" OR "modules" OR "that" OR "teach" OR "something"');
  });

  it.each([
    ['machne', '"machine" OR "machne"*'],
    ['progr', '"progr"*'],
  ])('[S4 fixed] 3C: "%s" gets lexical hits, as a correction or a prefix term', async (q, expr) => {
    expect(await matchExpression(q)).toBe(expr);
    const { body } = await callJson(`/search?q=${q}&mode=lexical`, { fakes });
    expect(body.retrieval.lexical).toBeGreaterThan(0);
  });
});

describe('S5', () => {
  it('[S5 fixed] "cs 1010s" is joined into the code CS1010S and pinned at rank 1', async () => {
    for (const mode of ['hybrid', 'lexical']) {
      const { body } = await callJson(`/search?q=cs%201010s&mode=${mode}`, { fakes });
      expect(body.interpreted.pin, mode).toEqual(['CS1010S']);
      expect(body.results[0], mode).toMatchObject({ code: 'CS1010S', score: 1 });
    }
  });

  it('[S5 fixed] the partial code "CS101" routes to its members, and only them', async () => {
    const { body } = await callJson('/search?q=CS101&mode=lexical', { fakes });
    const members = fixture.modules.map((m) => m.code).filter((c) => c.startsWith('CS101')).sort();
    expect(members.length).toBeGreaterThan(1);
    expect(body.interpreted.prefix).toBe('CS101');
    expect(shownCodes(body.results).sort()).toEqual(members);
  });
});

describe('S7', () => {
  it('[S7 fixed] 3H-0: the schema has exam, S/U, grading-basis, workload-hours and prerequisite columns', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('modules') ORDER BY cid").all();
    expect(results.map((r) => r.name)).toEqual([
      'code', 'title', 'description', 'credits', 'department', 'faculty', 'level', 'semesters', 'workload',
      // row_hash: 0006 (Phase 1C). The generated sem/ng_sem/exam_sem columns
      // are hidden from table_info.
      'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters', 'row_hash',
      // 0007 (3H-0).
      'exam_semesters', 'su', 'grading_basis', 'workload_hours', 'prereq_none', 'prereq_cohort_only',
    ]);
  });

  it('[S7 fixed] 3H: /search filters on no exam, S/U, workload and prerequisite, as params or phrases', async () => {
    const plain = await callJson('/search?q=introduction&mode=lexical&topK=50', { fakes });
    const filtered = await callJson('/search?q=introduction&mode=lexical&topK=50&exam=0&su=1&hoursBelow=10&prereq=none', { fakes });
    expect(filtered.body.filters).toEqual({ exam: 0, su: 1, hoursBelow: 10, prereq: 'none' });
    expect(filtered.body.count).toBeLessThan(plain.body.count);
    // `light workload`, not `under N hours`: the fixture's vocabulary has no `hours`, so 3C would
    // correct it before pass A (test/full/vocabulary.node.test.js: no phrase is corrected on the real corpora).
    const phrased = await callJson('/search?q=introduction%20s%2Fu%20no%20exam%20light%20workload%20no%20prereq&mode=lexical&topK=50', { fakes });
    expect(phrased.body.interpreted).toMatchObject({ exam: 0, su: { value: 1 }, hoursBelow: 10, prereq: { value: 'none' } });
    expect(new Set(codes(phrased.body.results))).toEqual(new Set(codes(filtered.body.results)));
  });
});

describe('S8', () => {
  it('[S8 fixed] 3G: gibberish answers count 0 with noMatch no-signal', async () => {
    const { body } = await callJson('/search?q=xqzvbnm%20flurble', { fakes });
    expect(body.retrieval.lexical).toBe(0);
    expect(body).toMatchObject({ count: 0, results: [], noMatch: { reason: 'no-signal' } });
  });

  it('[S8 fixed] 3F: near-duplicate variants (TR3202*) collapse to one result, the others listed as its variants', async () => {
    const { body } = await callJson('/search?q=start-up%20internship&mode=lexical&topK=10', { fakes });
    const tr = body.results.filter((/** @type {any} */ r) => r.code.startsWith('TR3202'));
    expect(tr).toHaveLength(1);
    expect(tr[0].variants.every((/** @type {any} */ v) => v.code.startsWith('TR3202'))).toBe(true);
    expect(tr[0].variants.length).toBeGreaterThanOrEqual(3);
  });
});

describe('P1', () => {
  it('[P1 known-bug] ng=1&sem=1 returns modules that are open to exchange students only in Sem 2', async () => {
    const { body } = await callJson('/search?q=machine%20learning&ng=1&sem=1&mode=lexical', { fakes });
    const wrong = body.results.filter((/** @type {any} */ r) => !r.ngSemesters.includes(1));
    expect(codes(wrong)).toEqual(expect.arrayContaining(['CS3244', 'CG3201']));
    for (const r of wrong.filter((/** @type {any} */ r) => ['CS3244', 'CG3201'].includes(r.code))) {
      expect(r).toMatchObject({ ng: true, ngSemesters: [2], semesters: [1, 2] });
    }
  });

  it('[P1 known-bug] the Vectorize filter is the yearly ng boolean, not per semester', async () => {
    const before = fakes.vectorize.calls.length;
    await callJson('/search?q=machine%20learning%20vecfilter&ng=1&sem=1', { fakes, env: { DENSE_BACKEND: 'vectorize' } });
    expect(/** @type {any} */ (fakes.vectorize.calls[before].args[1]).filter).toEqual({ sem1: true, ng: true });
  });

  it('[P1 known-bug] the bundle\'s filter mask is the same yearly ng boolean (3-0 keeps the semantics)', async () => {
    const { body } = await callJson('/search?q=machine%20learning&ng=1&sem=1&mode=vector&topK=50', { fakes });
    const wrong = body.results.filter((/** @type {any} */ r) => !r.ngSemesters.includes(1));
    expect(codes(wrong)).toEqual(expect.arrayContaining(['CS3244', 'CG3201']));
  });
});

describe('P2', () => {
  it('[P2 known-bug] ng=1 returns a level-5 module (LI5202) to an undergraduate exchange student', async () => {
    const { body } = await callJson('/search?q=supply%20chain%20management&ng=1&mode=lexical', { fakes });
    const grad = body.results.filter((/** @type {any} */ r) => r.level >= 5);
    expect(codes(grad)).toContain('LI5202');
    expect(grad.every((/** @type {any} */ r) => r.ng)).toBe(true);
  });
});
