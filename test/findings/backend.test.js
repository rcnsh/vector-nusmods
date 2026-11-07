// @ts-check
// Backend findings B3-B8, O3 and O4 over the fixture corpus: characterisation
// tests for what is still open, correctness tests for what Phase 1 fixed.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index.js';
import { lexicalSearch } from '../../src/lexical.js';
import { RESULT_COLUMNS } from '../../src/modules.js';
import { DATA_VERSION, NO_VERSION_ID, searchCacheKey } from '../../src/search.js';
import { Trace } from '../../src/timing.js';
import { denseCircuit } from '../../src/upstream.js';
import { createFakes, hashEmbed } from '../fakes.js';
import { BASE, NG_LIST, adminCall, call, callJson, fixture, seed } from '../helpers.js';
import { codes, ftsCalls, recordingDb, settlesWithin, shownCodes } from './support.js';

/**
 * The Vectorize standby (DENSE_BACKEND=vectorize, Phase 3 3-0): the tests of
 * how /search treats the Vectorize binding run under it; test/dense.test.js
 * covers the bundled default.
 */
const STANDBY = { DENSE_BACKEND: 'vectorize' };

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('B3', () => {
  // Was `[B3 known-bug] the FTS update/delete triggers delete by the UNINDEXED
  // code column, a full scan`. Fixed by migrations/0006_fts_external.sql.
  it('[B3 fixed] the FTS triggers address the index by rowid: no full FTS scan, constant cost per row', async () => {
    const { results: triggers } = /** @type {D1Result<{ name: string, sql: string }>} */ (await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'modules' ORDER BY name").all());
    // modules_rowid_immutable (0006) only compares rowids and touches no table.
    expect(triggers.map((t) => t.name)).toEqual(['modules_fts_delete', 'modules_fts_insert', 'modules_fts_update', 'modules_rowid_immutable']);

    // EXPLAIN QUERY PLAN does not descend into trigger programs, so plan each
    // statement of each trigger body on its own, old.x/new.x bound as values.
    let planned = 0;
    for (const { name, sql } of triggers.filter((t) => t.name.startsWith('modules_fts_'))) {
      const body = sql.slice(sql.search(/\bBEGIN\b/i) + 5, sql.lastIndexOf('END')).split(';').map((x) => x.trim()).filter(Boolean);
      for (const stmt of body) {
        expect(stmt, name).not.toMatch(/\bDELETE\s+FROM\s+modules_fts\b|\bWHERE\s+code\b/i);
        const refs = stmt.match(/\b(?:old|new)\.\w+/g) ?? [];
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.replace(/\b(?:old|new)\.\w+/g, '?')}`)
          .bind(...refs.map((r, i) => (r.endsWith('rowid') ? 1 : `v${i}`))).all();
        expect(plan.results.map((r) => r.detail).filter((d) => /SCAN/.test(String(d))), `${name}: ${stmt}`).toEqual([]);
        planned++;
      }
    }
    expect(planned).toBe(4); // insert 1, delete 1, update 2 ('delete' command, then insert)
    // The statements that fire them find the row by primary key.
    for (const stmt of ['UPDATE modules SET title = ? WHERE code = ?', 'DELETE FROM modules WHERE code = ?']) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt}`).bind(...(stmt.startsWith('UPDATE') ? ['t', 'CS1010S'] : ['CS1010S'])).all();
      expect(plan.results.map((r) => r.detail)).toEqual(['SEARCH modules USING INDEX sqlite_autoindex_modules_1 (code=?)']);
    }

    // Cost: changing one title used to read the whole FTS table (401 rows here).
    const res = await env.DB.prepare("UPDATE modules SET title = title || ' revised' WHERE code = 'CS1010S'").run();
    expect(res.meta.rows_written).toBeGreaterThan(0);
    expect(res.meta.rows_read).toBeLessThan(10);
    expect(fixture.modules.length).toBeGreaterThan(300);
  });
});

describe('B4', () => {
  it('[B4 fixed] with Workers AI hanging, the pin and lexical queries still start before the embedding resolves', async () => {
    const hanging = createFakes();
    hanging.vectorize.vectors = fakes.vectorize.vectors;
    hanging.ai.hangs();
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const pending = callJson('/search?q=cs1010s', { fakes: hanging, env: { DB: recordingDb(log) } });
    expect(await settlesWithin(pending, 100)).toBe('pending');
    expect(hanging.ai.calls).toHaveLength(1);
    expect(ftsCalls(log)).toHaveLength(1);
    expect(log.filter((c) => c.sql.includes('WHERE code = ?'))).toHaveLength(1);
    // The embedding never arrives; the search answers from the keyword half at the AI timeout.
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body.degraded).toEqual({ source: 'workers-ai', reason: 'timeout' });
    expect(body.results[0]).toMatchObject({ code: 'CS1010S', score: 1 });
  });

  it('[B4 fixed] pin, lexical and embed -> Vectorize run concurrently, then one hydrate query, all on a read session', async () => {
    /** @type {string[]} */
    const order = [];
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((r) => { release = () => r(undefined); });
    const run = f.ai.run.bind(f.ai), query = f.vectorize.query.bind(f.vectorize);
    f.ai.run = async (...a) => { order.push('ai:start'); await gate; const r = await run(...a); order.push('ai:end'); return r; };
    f.vectorize.query = async (...a) => { order.push('vec:start'); const r = await query(...a); order.push('vec:end'); return r; };
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const db = recordingDb(log);
    // No code in the text: since 3B an offered code inside a longer query pins too (prereg §3 step 1).
    // The uncollapsed pipeline (3F's collapse adds hydrate and variants reads: test/search-groups.test.js).
    const pending = callJson('/search?q=programming%20methodology', { fakes: f, env: { DB: db, ...STANDBY, COLLAPSE_GROUPS: 'off' } });
    // While the embedding is held back, pin and FTS have both been issued and nothing has been hydrated.
    expect(await settlesWithin(pending, 50)).toBe('pending');
    const kinds = () => log.map((c) => (c.sql.includes('MATCH') ? 'fts' : c.sql.includes('IN (') ? 'hydrate' : 'pin'));
    expect(order).toEqual(['ai:start']);
    expect(kinds().sort()).toEqual(['fts']);
    release();
    const { status } = await pending;
    expect(status).toBe(200);
    expect(order).toEqual(['ai:start', 'ai:end', 'vec:start', 'vec:end']);
    expect(kinds()).toEqual(['fts', 'hydrate']);
    expect(log.every((c) => c.session === 'first-unconstrained')).toBe(true);

    // With a code-shaped query the pin lookup is a third concurrent branch.
    log.length = 0;
    const held = createFakes();
    held.vectorize.vectors = fakes.vectorize.vectors;
    held.ai.hangs();
    const pinned = callJson('/search?q=cs1010s', { fakes: held, env: { DB: db, COLLAPSE_GROUPS: 'off' } });
    expect(await settlesWithin(pinned, 50)).toBe('pending');
    expect(kinds().sort()).toEqual(['fts', 'pin']);
    expect((await pinned).body.results[0]).toMatchObject({ code: 'CS1010S', score: 1 });
    // The pinned row comes from the pin query; hydration runs at most once, for the rest.
    expect(kinds().filter((k) => k === 'hydrate').length).toBeLessThanOrEqual(1);
  });

  // Was `[B4 known-bug] responses carry no Server-Timing header`; Phase 1 step 0
  // added the spans so SC7 can be measured. Concurrent spans keep pipeline order.
  it('[B4 instrumented] /search responses carry Server-Timing spans for each stage', async () => {
    const res = await call('/search?q=databases%20timing', { fakes });
    expect(res.status).toBe(200);
    const names = (res.headers.get('server-timing') ?? '').split(', ').map((p) => p.split(';')[0]);
    expect(names).toEqual(['cache', 'limit', 'embed', 'vector', 'fts', 'hydrate', 'total']);
  });
});

// Timeouts are behavioural: the search must still be pending just before the
// budget and settled just after it, however the timer is armed.
describe('B5', () => {
  it('[B5 fixed] /module/%E0%A4%A is a 400 naming the bad encoding, not an exception out of fetch', async () => {
    const { status, body } = await callJson('/module/%E0%A4%A');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request', message: 'The module code in the path is not valid percent-encoding.' });
  });

  it.each([
    ['ai', 'workers-ai'],
    ['vectorize', 'vectorize'],
  ])('[B5 fixed] a hanging %s call times out at 1.5 s and the search answers keyword-only', async (which, source) => {
    const hanging = createFakes();
    hanging.vectorize.vectors = fakes.vectorize.vectors;
    (which === 'ai' ? hanging.ai : hanging.vectorize).hangs();
    const pending = callJson('/search?q=programming%20methodology%20hang', { fakes: hanging, env: STANDBY });
    expect(await settlesWithin(pending, 1350)).toBe('pending');
    expect(await settlesWithin(pending, 350)).toBe('settled'); // by ~1.7 s
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body.degraded).toEqual({ source, reason: 'timeout' });
    expect(shownCodes(body.results)).toContain('CS1010S');
  });

  it('[B5 fixed] a hanging D1 query times out at 3 s with a 502 naming D1', async () => {
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const db = recordingDb(log, { hang: (sql) => sql.includes('MATCH') });
    const pending = callJson('/search?q=programming%20d1%20hang&mode=lexical', { fakes, env: { DB: db } });
    expect(await settlesWithin(pending, 2800)).toBe('pending');
    expect(await settlesWithin(pending, 400)).toBe('settled');
    const { status, body } = await pending;
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'upstream_failure', source: 'd1-fts', message: 'D1 did not answer within 3000 ms' });
  }, 10_000);

  it('[B5 fixed] a throwing rate limiter fails open, and the failure is logged', async () => {
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    f.limit.throws('limiter down');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await callJson('/search?q=limiter%20down%20programming', { fakes: f });
      expect(status).toBe(200);
      expect(body.results.length).toBeGreaterThan(0);
      expect(errors.mock.calls.map((a) => JSON.parse(String(a[0])))).toContainEqual({ event: 'limiter_error', message: 'limiter down' });
    } finally { errors.mockRestore(); }
  });

  it('[B5 fixed] an exception no route handles is a JSON 500 carrying the request id, and is logged', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // No DB binding at all: the route throws before any of its own try blocks.
      const withRay = await callJson('/module/CS1010S', { env: { DB: undefined }, init: { headers: { 'cf-ray': '8f1e2d3c4b5a6978-SIN' } } });
      expect(withRay.status).toBe(500);
      expect(withRay.body).toEqual({ error: 'internal', requestId: '8f1e2d3c4b5a6978-SIN' });
      expect(withRay.headers.get('x-app-version')).toBe('dev');
      const logged = errors.mock.calls.map((a) => JSON.parse(String(a[0])));
      expect(logged[0]).toMatchObject({ event: 'unhandled', requestId: '8f1e2d3c4b5a6978-SIN', path: '/module/CS1010S', name: 'TypeError' });

      const noRay = await callJson('/module/CS1010S', { env: { DB: undefined } });
      expect(noRay.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    } finally { errors.mockRestore(); }
  });
});

describe('B6', () => {
  it.each([
    ['ai', 'workers-ai'],
    ['vectorize', 'vectorize'],
  ])('[B6 fixed] %s throwing in hybrid mode returns the keyword results, flagged degraded and cached for 60 s', async (which, source) => {
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    (which === 'ai' ? f.ai : f.vectorize).throws('down');
    const logs = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await call('/search?q=programming%20methodology', { fakes: f, env: STANDBY });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('hybrid');
      expect(body.degraded).toEqual({ source, reason: 'error' });
      expect(body.retrieval.vector).toBe(0);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      expect(res.headers.get('server-timing')).toContain(`degraded;desc=${source}-error`);
      const line = logs.mock.calls.map((a) => { try { return JSON.parse(String(a[0])); } catch { return null; } }).find((l) => l?.event === 'search');
      expect(line).toMatchObject({ status: 200, degraded: { source, reason: 'error' }, degradedMessage: 'down' });

      // Exactly what keyword-only search returns.
      const lexical = await callJson('/search?q=programming%20methodology&mode=lexical', { fakes: f });
      expect(codes(body.results)).toEqual(codes(lexical.body.results));
      expect(shownCodes(body.results)).toContain('CS1010S');
    } finally { logs.mockRestore(); warn.mockRestore(); }
  });

  it('[B6 fixed] mode=vector still fails loudly with a 502 from the failing binding', async () => {
    for (const [which, source] of [['ai', 'workers-ai'], ['vectorize', 'vectorize']]) {
      const f = createFakes();
      f.vectorize.vectors = fakes.vectorize.vectors;
      (which === 'ai' ? f.ai : f.vectorize).throws('down');
      const { status, body } = await callJson('/search?q=programming%20methodology&mode=vector', { fakes: f, env: STANDBY });
      expect(status).toBe(502);
      expect(body).toEqual({ error: 'upstream_failure', source, message: 'down' });
    }
  });

  it('[B6 fixed] after 3 consecutive dense failures the dense half is skipped for 30 s, then retried', async () => {
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    f.ai.throws('down');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 1_000_000;
    const realNow = denseCircuit.now;
    denseCircuit.reset();
    denseCircuit.now = () => clock;
    try {
      for (let i = 0; i < 3; i++) {
        const { body } = await callJson(`/search?q=circuit%20${i}`, { fakes: f, keepCircuit: true });
        expect(body.degraded).toEqual({ source: 'workers-ai', reason: 'error' });
      }
      expect(f.ai.calls).toHaveLength(3);
      const skipped = await callJson('/search?q=circuit%20open', { fakes: f, keepCircuit: true });
      expect(f.ai.calls).toHaveLength(3);
      expect(skipped.status).toBe(200);
      expect(skipped.body.degraded).toEqual({ source: 'workers-ai', reason: 'circuit-open' });
      // mode=vector is never short-circuited.
      expect((await callJson('/search?q=circuit%20vector&mode=vector', { fakes: f, keepCircuit: true })).status).toBe(502);
      expect(f.ai.calls).toHaveLength(4);

      clock += 30_001;
      f.ai.ok();
      const retried = await callJson('/search?q=circuit%20closed', { fakes: f, keepCircuit: true });
      expect(f.ai.calls).toHaveLength(5);
      expect(retried.body.degraded).toBeUndefined();
      expect(denseCircuit.open()).toBe(false);
    } finally {
      denseCircuit.now = realNow;
      denseCircuit.reset();
      warn.mockRestore();
    }
  });
});

describe('B7', () => {
  it('[B7 fixed] the cache key is canonical: order, case, whitespace, defaults and junk params share one entry', async () => {
    const urls = [
      '/search?q=data%20visualisation&sem=2&topK=7',
      '/search?topK=7&sem=2&q=data%20visualisation',
      '/search?q=Data%20Visualisation&sem=2&topK=7',
      '/search?q=%20data%20%20%20visualisation%20&sem=2&topK=7.9',
      '/search?q=data%20visualisation&sem=2&topK=7&_r=x1&mode=hybrid&ng=0&faculty=%20',
    ];
    const key = /** @type {Request} */ (searchCacheKey(new URL(urls[0], BASE)));
    for (const u of urls) expect(searchCacheKey(new URL(u, BASE))?.url).toBe(key.url);
    expect(key.url).toBe(`${BASE}/search?dv=${DATA_VERSION}&q=data+visualisation&sem=2&topK=7&v=${NO_VERSION_ID}`);
    await caches.default.delete(key);

    const before = fakes.ai.calls.length;
    /** @type {any[]} */
    const bodies = [];
    for (const u of urls) {
      /** @type {import('./support.js').DbCall[]} */
      const log = [];
      const res = await call(u, { fakes, keepCache: true, env: { DB: recordingDb(log) } });
      bodies.push(await res.json());
      // A hit costs no D1 read at all: nothing is read before the lookup.
      if (bodies.length > 1) expect(log).toEqual([]);
    }
    // One miss, one embedding, for one logical query.
    expect(fakes.ai.calls.length - before).toBe(1);
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0].query).toBe('data visualisation');

    // Parameters that change the answer still get their own entry.
    for (const other of ['/search?q=data%20visualisation&sem=2&topK=8', '/search?q=data%20visualisation&sem=1&topK=7',
      '/search?q=data%20visualisation&sem=2&topK=7&mode=lexical']) {
      expect(searchCacheKey(new URL(other, BASE))?.url).not.toBe(key.url);
    }
    // Invalid requests have no key and are never cached.
    expect(searchCacheKey(new URL('/search?q=x&sem=9', BASE))).toBeNull();
  });

  // Phase 3 3-0 (B3-1): every parameter that changes the answer, in parsed
  // form, and the deployed version id. 3H's exam/su/hoursBelow/prereq and the
  // sorted `ignore` list add their own cases here, in the PR that adds them.
  it.each([
    ['sem', 'sem=2'], ['level', 'level=3'], ['credits', 'credits=4'], ['faculty', 'faculty=Computing'], ['ng', 'ng=1'],
    ['mode', 'mode=vector'], ['topK', 'topK=7'], ['ignore', 'ignore=ge'],
  ])('[B3-1] a request with %s has a different key from one without', (_name, param) => {
    const without = searchCacheKey(new URL('/search?q=data%20visualisation', BASE));
    const withIt = searchCacheKey(new URL(`/search?q=data%20visualisation&${param}`, BASE));
    expect(withIt?.url).not.toBe(without?.url);
    // In parsed form: another spelling of the same value shares the key.
    const spelled = param.replace(/^(\w+)=(.*)$/, (_m, k, v) => `${k}=${k === 'faculty' ? ` ${v} ` : k === 'ng' ? 'true' : k === 'topK' ? `${v}.4` : v}`);
    expect(searchCacheKey(new URL(`/search?_x=1&${spelled}&q=Data%20%20Visualisation`, BASE))?.url).toBe(withIt?.url);
  });

  it('[B3-1, 3B] ignore joins the key as a sorted, de-duplicated list: ignore=su,level and ignore=level,su share one key', () => {
    const key = (/** @type {string} */ q) => searchCacheKey(new URL(`/search?q=data%20visualisation&${q}`, BASE))?.url;
    expect(key('ignore=su,level')).toBe(key('ignore=level,su'));
    expect(key('ignore=level,su,level')).toBe(key('ignore=level,su'));
    expect(key('ignore=level')).not.toBe(key('ignore=level,su'));
    expect(key('ignore=ge')).not.toBe(key('ignore=level'));
    // An empty list is no list.
    expect(key('ignore=')).toBe(searchCacheKey(new URL('/search?q=data%20visualisation', BASE))?.url);
    // An unknown intent is a 400, never cached.
    expect(searchCacheKey(new URL('/search?q=x&ignore=banana', BASE))).toBeNull();
  });

  it('[B-7, B2-6] the key carries the deployed version id, so every deploy (ranker, vectors, DENSE_BACKEND) starts a fresh cache', async () => {
    const url = new URL('/search?q=data%20visualisation', BASE);
    const a = searchCacheKey(url, 'version-a')?.url;
    expect(a).toContain('v=version-a');
    expect(searchCacheKey(url, 'version-b')?.url).not.toBe(a);
    expect(searchCacheKey(url, 'version-a')?.url).toBe(a);
    // The Worker keys by its own version_metadata id.
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    const meta = (/** @type {string} */ id) => ({ CF_VERSION_METADATA: { id, tag: 'test', timestamp: '' } });
    await caches.default.delete(/** @type {Request} */ (searchCacheKey(url, 'version-a')));
    await caches.default.delete(/** @type {Request} */ (searchCacheKey(url, 'version-b')));
    const first = await call('/search?q=data%20visualisation', { fakes: f, keepCache: true, env: meta('version-a') });
    expect(first.headers.get('server-timing')).toContain('cache;desc=miss');
    const again = await call('/search?q=data%20visualisation', { fakes: f, keepCache: true, env: meta('version-a') });
    expect(again.headers.get('server-timing')).toContain('cache;desc=hit');
    const next = await call('/search?q=data%20visualisation', { fakes: f, keepCache: true, env: meta('version-b') });
    expect(next.headers.get('server-timing')).toContain('cache;desc=miss');
  });

  it('[B7 evidence] every stage is case- and whitespace-insensitive, so the key may lower-case q', async () => {
    // The fake embedder (and bge-small-en-v1.5, an uncased model) ignores case and spacing.
    expect(hashEmbed('Machine  LEARNING')).toEqual(hashEmbed('machine learning'));
    // So does the FTS query lexical.js builds.
    for (const [a, b] of [['Machine  LEARNING', 'machine learning'], ['Intro To DATA', 'intro to data'], ['CS1010S', 'cs1010s']]) {
      const trace = new Trace();
      expect(await lexicalSearch(env.DB, a, {}, 50, trace)).toEqual(await lexicalSearch(env.DB, b, {}, 50, trace));
    }
  });
});

describe('B8', () => {
  it('[B8 fixed] an empty topK= returns the default 20 results', async () => {
    const { body } = await callJson('/search?q=machine%20learning&topK=', { fakes });
    expect(body.count).toBe(20);
    expect(body.results).toHaveLength(20);
  });

  it('[B8 fixed] hydration reads only the rows and columns the response renders', async () => {
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    // The uncollapsed pipeline; 3F's reads are checked in test/search-groups.test.js.
    const { body } = await callJson('/search?q=machine%20learning%20hydrate&topK=20', { fakes, env: { DB: recordingDb(log), COLLAPSE_GROUPS: 'off' } });
    const hydrate = log.filter((c) => c.sql.includes('WHERE code IN'));
    expect(hydrate).toHaveLength(1);
    expect(body.results).toHaveLength(20);
    expect(body.retrieval.fused).toBeGreaterThan(20);
    expect(hydrate[0].binds).toEqual(codes(body.results));
    expect(hydrate[0].sql).toContain(`SELECT ${RESULT_COLUMNS} FROM`);
    // Whole column names: 3H's filter columns (workload_hours, prereq_none, …) are small and read on purpose.
    const cols = /** @type {RegExpMatchArray} */ (hydrate[0].sql.match(/^SELECT (.*) FROM/))[1].split(', ');
    for (const col of ['description', 'workload', 'prerequisite', 'preclusion', 'acad_year', 'text_hash']) {
      expect(cols).not.toContain(col);
    }
  });

  it('[B8 fixed] a candidate missing from D1 (stale vector) is skipped and the next one hydrated', async () => {
    const f = createFakes();
    f.vectorize.vectors = new Map(fakes.vectorize.vectors);
    const top = (await callJson('/search?q=machine%20learning%20stale&mode=vector&topK=5', { fakes: f, env: STANDBY })).body.results;
    // A vector identical to the best match, for a module D1 does not have.
    const ghost = /** @type {import('../fakes.js').StoredVector} */ (f.vectorize.vectors.get(top[0].code));
    f.vectorize.vectors.set('ZZ9999', { ...ghost, id: 'ZZ9999' });
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { body } = await callJson('/search?q=machine%20learning%20stale&mode=vector&topK=5', { fakes: f, env: { DB: recordingDb(log), ...STANDBY } });
      expect(codes(body.results)).toEqual(codes(top));
      expect(log.filter((c) => c.sql.includes('WHERE code IN')).map((c) => c.binds.length)).toEqual([5, 1]);
    } finally { warn.mockRestore(); }
  });

  it('[B8 fixed] Vectorize is asked for ids only; the candidate depth stays 50', async () => {
    const before = fakes.vectorize.calls.length;
    const { body } = await callJson('/search?q=machine%20learning%20ceiling&topK=100', { fakes, env: STANDBY });
    const opts = /** @type {any} */ (fakes.vectorize.calls[before].args[1]);
    expect(opts).toEqual({ topK: 50 });
    expect(body.count).toBe(50);
  });

  it('[B8 fixed] "naïve" stays one token, and D1\'s FTS5 folds it to the same term as "naive"', async () => {
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    await callJson('/search?q=na%C3%AFve%20bayes&mode=lexical', { fakes, env: { DB: recordingDb(log) } });
    // 3C: `bayes` has df 0 in the fixture, so it is a prefix term; `naïve` is not letter-only ASCII and stays as typed.
    expect(ftsCalls(log)[0].binds[0]).toBe('"naïve" OR "bayes"*');
    // The table's own tokenizer (porter unicode61) strips the diaeresis, so the
    // quoted token matches what "naive" matches in the fixture.
    const count = (/** @type {string} */ m) => env.DB.prepare('SELECT count(*) AS n FROM modules_fts WHERE modules_fts MATCH ?').bind(m).first('n');
    expect(await count('"naïve"')).toBe(await count('"naive"'));
    expect(await count('"Model"')).toBe(await count('"modél"'));
    expect(Number(await count('"modél"'))).toBeGreaterThan(0);
  });
});

describe('O3', () => {
  it('[O3 fixed] /facets reports the NG list date ingest recorded from data/ng-courses-*.json', async () => {
    await seed({ fakes, facets: true });
    const stored = await env.DB.prepare("SELECT value FROM meta WHERE key = 'ng_list'").first('value');
    expect(JSON.parse(String(stored))).toEqual(NG_LIST);
    expect(NG_LIST).toMatchObject({ updatedAsAt: '01 Sep 2026', source: expect.stringContaining('Non-Graduating') });
    expect((await callJson('/facets')).body.ng.updatedAsAt).toBe(NG_LIST.updatedAsAt);

    // A new extract with a new date reaches /facets through the same route, with no code change.
    const res = await adminCall('/admin/facets', fakes, { ngList: { ...NG_LIST, updatedAsAt: '15 Jan 2027' } });
    expect(res.status).toBe(200);
    expect((await callJson('/facets')).body.ng.updatedAsAt).toBe('15 Jan 2027');
    expect((await adminCall('/admin/facets', fakes, { ngList: { updatedAsAt: 7 } })).status).toBe(400);
    // An ingest without the NG list (facetsPayload sends an explicit empty list) clears the old date.
    expect((await adminCall('/admin/facets', fakes, { ngList: { updatedAsAt: null, source: null, count: 0 } })).status).toBe(200);
    expect((await callJson('/facets')).body.ng.updatedAsAt).toBeNull();
    // Re-seed so later tests in this file see the fixture as beforeAll left it.
    fakes = await seed();
  });
});

describe('O4', () => {
  it('[O4 known-bug] the Worker has no scheduled handler, so nothing refreshes the data', () => {
    expect(Object.keys(worker)).toEqual(['fetch']);
  });
});
