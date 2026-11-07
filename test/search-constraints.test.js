// @ts-check
// 3H in /search (docs/plans/phase3.md 3H): `exam=0`, `su=1`, `hoursBelow=N`
// and `prereq=none`, as explicit params or parsed from q, are hard filters in
// SQL, in the bundle's filter table and on every hydrated dense row, in every
// mode and route, on results, pins and 3F variants. Each param joins the
// cache key (plan §2 "Response cache key").
import { beforeAll, describe, expect, it } from 'vitest';
import { INTENT } from '../src/intents.js';
import { searchCacheKey } from '../src/search.js';
import { BASE, callJson, fixture, seed } from './helpers.js';

const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
const CSCU = 'Completed Satisfactory/Unsatisfactory';
/**
 * Whether a module satisfies a 3H constraint, as the plan states it.
 * @param {NormalisedModule} m @param {string} param @param {number} [sem]
 */
function satisfies(m, param, sem) {
  if (param === 'exam=0') return sem !== undefined ? !m.examSemesters.includes(sem) : m.examSemesters.length === 0;
  if (param === 'su=1') return m.su || m.gradingBasis === CSCU;
  if (param.startsWith('hoursBelow=')) return m.workloadHours !== null && m.workloadHours < Number(param.split('=')[1]);
  if (param === 'prereq=none') return INTENT.prereq === 'i' ? m.prereqNone : m.prereqNone || m.prereqCohortOnly;
  throw new Error(param);
}
/**
 * Every code the page shows: results and their variants.
 * @param {any} body
 * @returns {string[]}
 */
const shown = (body) => body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);
const PARAMS = ['exam=0', 'su=1', 'hoursBelow=10', 'prereq=none'];

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => { fakes = await seed(); });

describe('explicit params', () => {
  it('each is a hard filter in every mode and on the standby, and is echoed in `filters`', async () => {
    for (const param of PARAMS) {
      for (const [extra, env] of /** @type {const} */ ([['', {}], ['&mode=lexical', {}], ['&mode=vector', {}], ['', { DENSE_BACKEND: 'vectorize' }]])) {
        const path = `/search?q=introduction&topK=50&${param}${extra}`;
        const { status, body } = await callJson(path, { fakes, env });
        expect(status, path).toBe(200);
        expect(body.count, path).toBeGreaterThan(0);
        const [k, v] = param.split('=');
        expect(body.filters[k], path).toBe(k === 'prereq' ? v : Number(v));
        for (const c of shown(body)) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), param), `${path} ${c}`).toBe(true);
      }
    }
  });

  it('exam=0 with sem=N means no exam in semester N', async () => {
    const { body } = await callJson('/search?q=introduction&topK=50&exam=0&sem=1', { fakes });
    expect(body.count).toBeGreaterThan(0);
    for (const c of shown(body)) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), 'exam=0', 1), c).toBe(true);
    // Some result has an exam in another semester: the rule is per selected semester.
    expect(shown(body).some((c) => (moduleOf.get(c)?.examSemesters.length ?? 0) > 0)).toBe(true);
  });

  it('rejects a value outside its form', async () => {
    for (const bad of ['exam=1', 'su=0', 'hoursBelow=0', 'hoursBelow=100', 'hoursBelow=x', 'prereq=some']) {
      const { status, body } = await callJson(`/search?q=introduction&${bad}`, { fakes });
      expect(status, bad).toBe(400);
      expect(body.message, bad).toMatch(new RegExp(bad.split('=')[0]));
    }
  });
});

describe('parsed from q', () => {
  it('filters as the explicit param does, echoed in `interpreted`, not in `filters`', async () => {
    const cases = [['introduction without final exam', 'exam=0'], ['introduction s/u', 'su=1'], ['introduction light workload', 'hoursBelow=10'],
      ['introduction no prerequisites', 'prereq=none']];
    for (const [q, param] of cases) {
      const { body } = await callJson(`/search?q=${encodeURIComponent(q)}&topK=50`, { fakes });
      expect(body.filters, q).toEqual({});
      expect(body.count, q).toBeGreaterThan(0);
      for (const c of shown(body)) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), param), `${q} ${c}`).toBe(true);
    }
    const { body } = await callJson('/search?q=introduction%20no%20prerequisites', { fakes });
    expect(body.interpreted.prereq).toEqual({ value: 'none', semantics: INTENT.prereq });
  });

  it('applies to masks and pins: a pinned code that fails the constraint is not pinned', async () => {
    const mask = await callJson('/search?q=cs2%20no%20exam&topK=50', { fakes });
    expect(mask.body.interpreted.prefix).toBe('CS2');
    for (const c of shown(mask.body)) {
      expect(c.startsWith('CS2'), c).toBe(true);
      expect(moduleOf.get(c)?.examSemesters, c).toEqual([]);
    }
    expect(moduleOf.get('CS1010S')?.examSemesters.length).toBeGreaterThan(0);
    const pin = await callJson('/search?q=cs1010s%20no%20exam', { fakes });
    expect(pin.body.interpreted.pin).toEqual(['CS1010S']);
    expect(shown(pin.body)).not.toContain('CS1010S');
  });

  it('ignore=<intent> undoes it: the phrase is read as text and nothing is filtered', async () => {
    const { body } = await callJson('/search?q=introduction%20s%2Fu&topK=50&ignore=su', { fakes });
    expect(body.interpreted.su).toBeNull();
    expect(shown(body).some((c) => !satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), 'su=1'))).toBe(true);
  });

  it('a query that is only a 3H phrase still answers, from the dense half, filtered', async () => {
    const { status, body } = await callJson('/search?q=no%20exams', { fakes });
    expect(status).toBe(200);
    expect(body.count).toBeGreaterThan(0);
    for (const c of shown(body)) expect(moduleOf.get(c)?.examSemesters, c).toEqual([]);
  });
});

describe('the cache key (plan §2, beside the B7 key tests)', () => {
  it('each param changes the key; spelling and order do not', () => {
    const key = (/** @type {string} */ qs) => searchCacheKey(`${BASE}/search?q=x${qs}`)?.url;
    const plain = key('');
    for (const param of PARAMS) expect(key(`&${param}`), param).not.toBe(plain);
    expect(key('&hoursBelow=8')).not.toBe(key('&hoursBelow=9'));
    expect(key('&su=1&exam=0')).toBe(key('&exam=0&su=1'));
    expect(key('&ignore=su,exam')).toBe(key('&ignore=exam,su'));
  });
});
