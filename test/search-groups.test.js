// @ts-check
// 3F in /search (docs/plans/phase3.md 3F): after filters and fusion only a
// duplicate group's first member stays, the others ride along as
// `variants: [{ code, credits }]`, and the page fills with the next distinct
// results. The gate's identity half on the fixture: the collapsed list equals
// the group-first projection of the uncollapsed one (COLLAPSE_GROUPS=off).
import { beforeAll, describe, expect, it } from 'vitest';
import groupsFile from './fixtures/groups.json';
import { parseGroupsFile } from '../src/groups.js';
import { createFakes } from './fakes.js';
import { callJson, fixture, seed } from './helpers.js';
import { recordingDb } from './findings/support.js';

const OFF = { COLLAPSE_GROUPS: 'off' };
const STANDBY = { DENSE_BACKEND: 'vectorize' };
const groupOf = parseGroupsFile(/** @type {any} */ (groupsFile));
const key = (/** @type {string} */ c) => groupOf.get(c) ?? c;
/** @returns {string[]} */
const codes = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);
const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
/** The group-first projection of a ranked list. @param {string[]} list */
const project = (list) => {
  const seen = new Set();
  return list.filter((c) => (seen.has(key(c)) ? false : (seen.add(key(c)), true)));
};

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => { fakes = await seed(); });

describe('the collapse', () => {
  it('S8: one TR3202 result for "start-up internship", the others as variants with their credits', async () => {
    const { body } = await callJson('/search?q=start-up%20internship&mode=lexical&topK=10', { fakes });
    const tr = body.results.filter((/** @type {any} */ r) => r.code.startsWith('TR3202'));
    expect(tr).toHaveLength(1);
    const members = fixture.modules.filter((m) => key(m.code) === key(tr[0].code) && m.code !== tr[0].code);
    expect(members.length).toBeGreaterThan(0);
    expect(tr[0].variants).toEqual(members.map((m) => ({ code: m.code, credits: m.credits })).sort((a, b) => (a.code < b.code ? -1 : 1)));
  });

  it('identity: every page equals the group-first projection of the uncollapsed list, in every mode and under the flip', async () => {
    const queries = ['start-up internship', 'programming methodology', 'machine learning', 'law seminar', 'accounting', 'data structures and algorithms', 'cs 1010s', 'cs1', 'ge'];
    let collapsedSomething = 0;
    for (const q of queries) {
      for (const [mode, extra] of /** @type {const} */ ([['hybrid', {}], ['lexical', {}], ['vector', {}], ['hybrid', STANDBY]])) {
        const path = `/search?q=${encodeURIComponent(q)}&mode=${mode}`;
        const on = await callJson(`${path}&topK=20`, { fakes, env: extra });
        const off = await callJson(`${path}&topK=50`, { fakes, env: { ...extra, ...OFF } });
        expect(on.status, path).toBe(200);
        const want = project(codes(off.body));
        // The uncollapsed list at 50 is deep enough when it has 20 distinct groups, or is the whole answer.
        if (want.length < 20 && off.body.count === 50) continue;
        expect(codes(on.body), `${path} ${JSON.stringify(extra)}`).toEqual(want.slice(0, 20));
        if (codes(off.body).slice(0, 20).join() !== codes(on.body).join()) collapsedSomething++;
      }
    }
    expect(collapsedSomething).toBeGreaterThan(3);
  });

  it('never shows two members of one group, and a page still fills to topK', async () => {
    const { body } = await callJson('/search?q=programming&topK=20', { fakes });
    expect(new Set(codes(body).map(key)).size).toBe(codes(body).length);
    expect(body.count).toBe(20);
  });

  it('variants respect the filters: a member the filters exclude is not listed', async () => {
    const { body } = await callJson('/search?q=programming%20methodology&topK=20&sem=1', { fakes });
    for (const r of body.results) {
      for (const v of r.variants ?? []) expect(moduleOf.get(v.code)?.semesters, v.code).toContain(1);
    }
  });

  it('a pinned code keeps its group mates as variants, never as later results', async () => {
    const { body } = await callJson('/search?q=cs%201010s', { fakes });
    expect(codes(body)[0]).toBe('CS1010S');
    expect(codes(body).filter((c) => key(c) === key('CS1010S'))).toEqual(['CS1010S']);
    expect(body.results[0].variants.map((/** @type {any} */ v) => v.code)).toEqual(expect.arrayContaining(['CS1010', 'CS1010E']));
  });

  it('two pinned codes from one group: the first stands, the second is its variant, and the page is the projection', async () => {
    for (const q of ['cs2030 or cs2030s', 'cs1010 cs1010s']) {
      const on = await callJson(`/search?q=${encodeURIComponent(q)}&topK=20`, { fakes });
      const off = await callJson(`/search?q=${encodeURIComponent(q)}&topK=50`, { fakes, env: OFF });
      expect(codes(on.body), q).toEqual(project(codes(off.body)).slice(0, 20));
      const listed = on.body.results.flatMap((/** @type {any} */ r) => (r.variants ?? []).map((/** @type {any} */ v) => v.code));
      expect(new Set(listed).size, q).toBe(listed.length);
      for (const c of listed) expect(codes(on.body), c).not.toContain(c);
    }
    const { body } = await callJson('/search?q=cs2030%20or%20cs2030s', { fakes });
    expect(body.results[0].variants.map((/** @type {any} */ v) => v.code)).toContain('CS2030S');
  });

  it('a single list fills a page of 50 from deeper in the same order; still the projection', async () => {
    for (const mode of ['lexical', 'vector']) {
      const path = `/search?q=programming&mode=${mode}`;
      const on = await callJson(`${path}&topK=50`, { fakes });
      const off = await callJson(`${path}&topK=50`, { fakes, env: OFF });
      expect(on.body.count, mode).toBe(50);
      const want = project(codes(off.body));
      expect(codes(on.body).slice(0, want.length), mode).toEqual(want);
    }
  });

  it('variants keep to the query\'s level window, as results do', async () => {
    const { body } = await callJson('/search?q=llj%205000&topK=50', { fakes });
    expect(body.interpreted.level).toMatchObject({ min: 5, max: 5 });
    const listed = body.results.flatMap((/** @type {any} */ r) => r.variants ?? []);
    expect(listed.length).toBeGreaterThan(0);
    for (const v of listed) expect(moduleOf.get(v.code)?.level, v.code).toBe(5);
  });

  it('a whole-query mask collapses too: every member is a result or a variant, one result per group', async () => {
    const { body } = await callJson('/search?q=cs1&topK=50', { fakes });
    const members = fixture.modules.map((m) => m.code).filter((c) => c >= 'CS1' && c < 'CS1:');
    const shown = new Set([...codes(body), ...body.results.flatMap((/** @type {any} */ r) => (r.variants ?? []).map((/** @type {any} */ v) => v.code))]);
    for (const c of members) expect(shown.has(c), c).toBe(true);
    expect(body.count).toBe(new Set(members.map(key)).size);
  });

  it('a singleton has no variants field; COLLAPSE_GROUPS=off returns the uncollapsed list with none', async () => {
    const { body } = await callJson('/search?q=machine%20learning&topK=20', { fakes });
    for (const r of body.results) if (!groupOf.has(r.code)) expect(r.variants, r.code).toBeUndefined();
    const off = await callJson('/search?q=start-up%20internship&mode=lexical&topK=10', { fakes, env: OFF });
    expect(codes(off.body).filter((c) => c.startsWith('TR3202')).length).toBeGreaterThan(1);
    for (const r of off.body.results) expect(r.variants).toBeUndefined();
  });

  it('degrades with the rest: the keyword-only fallback collapses as well', async () => {
    const failing = createFakes();
    failing.ai.throws('down');
    const { body } = await callJson('/search?q=start-up%20internship&topK=10', { fakes: failing });
    expect(body.degraded).toMatchObject({ source: 'workers-ai' });
    expect(codes(body).filter((c) => c.startsWith('TR3202'))).toHaveLength(1);
  });

  it('costs one variants read with only the columns a variant needs; hydration reads the page and the duplicates it skipped', async () => {
    /** @type {import('./findings/support.js').DbCall[]} */
    const log = [];
    const { body } = await callJson('/search?q=programming%20methodology%20cost&topK=20', { fakes, env: { DB: recordingDb(log) } });
    const variants = log.filter((c) => c.sql.includes('WHERE code IN') && !c.sql.includes('title'));
    const hydrate = log.filter((c) => c.sql.includes('WHERE code IN') && c.sql.includes('title'));
    expect(variants).toHaveLength(1);
    // A variant's code and credits, and the fields localMatchesFilters reads, 3H's included.
    expect(variants[0].sql).toContain('SELECT code, credits, level, faculty, semesters, ng, ng_semesters, '
      + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only FROM');
    const listed = body.results.flatMap((/** @type {any} */ r) => (r.variants ?? []).map((/** @type {any} */ v) => v.code));
    for (const c of listed) expect(/** @type {string[]} */ (variants[0].binds), c).toContain(c);
    const hydrated = hydrate.flatMap((c) => /** @type {string[]} */ (c.binds));
    for (const c of codes(body)) expect(hydrated, c).toContain(c);
    // Every extra row hydrated is a duplicate of a result the page shows.
    for (const c of hydrated.filter((x) => !codes(body).includes(x))) expect(codes(body).map(key), c).toContain(key(c));
  });
});
