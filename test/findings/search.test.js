// @ts-check
// Search and exchange-mode findings (S3-S8, P1, P2) over the fixture corpus.
// Ranking quality itself (S2, S6) needs the real embedding model, so those are
// cited from the recorded live evidence in docs/FINDINGS.md instead.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, fixture, seed } from '../helpers.js';
import { codes, ftsCalls, recordingDb } from './support.js';

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
    expect(codes(body.results)).toEqual(members);
  });

  it('[S4 fixed] stopwords-v2 drops "modules", "teach" and "something"; "intro" stays (it goes to 3D)', async () => {
    expect(await matchExpression('intro to modules that teach something')).toBe('"intro" OR "that"');
  });

  it.each(['machne', 'progr'])('[S4 known-bug] no fuzzy or prefix matching: "%s" gets 0 lexical hits', async (q) => {
    const { body } = await callJson(`/search?q=${q}&mode=lexical`, { fakes });
    expect(body.retrieval.lexical).toBe(0);
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
    expect(codes(body.results)).toEqual(members);
  });
});

describe('S7', () => {
  it('[S7 known-bug] the schema has no exam, S/U, grading-basis or attributes columns', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('modules') ORDER BY cid").all();
    expect(results.map((r) => r.name)).toEqual([
      'code', 'title', 'description', 'credits', 'department', 'faculty', 'level', 'semesters', 'workload',
      // row_hash: 0006 (Phase 1C). The generated sem/ng_sem columns are hidden
      // from table_info.
      'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters', 'row_hash',
    ]);
  });

  it('[S7 known-bug] /search accepts no workload, exam, S/U or prerequisite filter: they are ignored', async () => {
    const plain = await callJson('/search?q=programming&mode=lexical', { fakes });
    const filtered = await callJson('/search?q=programming&mode=lexical&exam=none&su=1&workload=low&noPrereq=1', { fakes });
    expect(filtered.body.filters).toEqual({});
    expect(codes(filtered.body.results)).toEqual(codes(plain.body.results));
  });
});

describe('S8', () => {
  it('[S8 known-bug] gibberish returns a full page of results in hybrid mode', async () => {
    const { body } = await callJson('/search?q=xqzvbnm%20flurble', { fakes });
    expect(body.retrieval.lexical).toBe(0);
    expect(body.count).toBe(20);
  });

  it('[S8 known-bug] near-duplicate variants (TR3202*) crowd the top of the list', async () => {
    const { body } = await callJson('/search?q=start-up%20internship&mode=lexical&topK=10', { fakes });
    const top = codes(body.results).slice(0, 4);
    expect(top.filter((c) => c.startsWith('TR3202')).length).toBe(4);
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
