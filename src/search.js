// @ts-check
// GET /search: parameter validation, the canonical cache key, the rate
// limiter, the query parse (src/query-intent.js: pins, masks, the third list,
// the GE mask, noMatch), both retrievers (run concurrently), rank fusion,
// hydration, and the keyword-only fallback when the dense half fails. Every
// response carries Server-Timing and `interpreted`, and each request writes
// one structured log line. 3C: the lexical half searches the corrected text
// with its prefix terms; under 3C-2 the dense half also embeds the corrected
// text, in parallel, and keeps each module's better cosine (mergeDense).
import dataVersion from './data-version.json';
import { bundleSearch, denseBundle } from './dense.js';
import { DEFAULT_MODEL } from './embedding.js';
import { appVersion, bad, json, upstream, withHeaders } from './http.js';
import { groups } from './group-data.js';
import { groupKeyOf } from './groups.js';
import { intentContext } from './intent-data.js';
import { lexicalSearch, rangeMembers } from './lexical.js';
import { RESULT_COLUMNS, d1Timed, readSession, rowToModule } from './modules.js';
import { INTENT } from './intents.js';
import { NO_SIGNAL_TAU } from './no-signal.js';
import { canonicalQuery, parseIgnore, parseQuery } from './query-intent.js';
import { EMBED_CORRECTED } from './typo.js';
import { hasCode } from './vector-bundle.js';
import {
  AI_TIMEOUT_MS, D1_TIMEOUT_MS, TimeoutError, VECTORIZE_TIMEOUT_MS, denseCircuit, withTimeout,
} from './upstream.js';

/**
 * @typedef {import('./modules.js').ResultRow} ResultRow
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {import('./vector-bundle.js').FilterEcho} FilterEcho
 * @typedef {Record<string, string | number | boolean>} VectorFilter
 * @typedef {'hybrid' | 'vector' | 'lexical'} Mode
 * @typedef {{ q: string, echo: FilterEcho, filter: VectorFilter, mode: Mode, topK: number, ignore: string[] }} SearchQuery
 *   `ignore`: the intents to undo, sorted and de-duplicated (3B; plan §2 "Response cache key").
 * @typedef {import('./vector-bundle.js').Constraints} Constraints
 * @typedef {import('./vector-bundle.js').CodeRange} CodeRange
 * @typedef {import('./query-intent.js').ParsedQuery} ParsedQuery
 * @typedef {{ source: string, reason: 'error' | 'timeout' | 'circuit-open' }} Degraded
 * @typedef {{ code: string, score: number }} DenseHit A dense candidate with its cosine score. Kept
 *   inside the search (3B's masks and 3G read them); the response's `score` stays the fused one.
 * @typedef {'bundle' | 'vectorize'} DenseBackend
 */

const MAX_QUERY_CHARS = 200;
// Each retriever's depth is capped at 50. That was Vectorize's ceiling with
// metadata returned; the metadata is no longer requested (so the ceiling is
// 100), but a deeper list would change rankings, which Phase 1 must not.
const MAX_TOPK = 50;
const DEFAULT_TOPK = 20;      // R3: at most 20 results
// The structured log carries the query text cut to this length. Search text is
// public and contains no identifiers; headers and IPs are never logged.
const LOGGED_QUERY_CHARS = 100;

// Cache lifetimes. A degraded (keyword-only) answer is cached briefly so a
// recovered upstream is used again within a minute.
const CACHE_TTL_S = 3600;
const DEGRADED_CACHE_TTL_S = 60;

// Bumped by ingest (src/data-version.json), so a deploy after an ingest gets
// fresh cache keys without a D1 read on every request.
export const DATA_VERSION = String(dataVersion.version);

/**
 * The cache key's version part when the Worker has no version_metadata id
 * (tests, `wrangler dev` without one).
 */
export const NO_VERSION_ID = 'dev';

/**
 * The deployed version's id (version_metadata), which every deploy changes:
 * a new ranker, new vectors or a DENSE_BACKEND flip each get fresh cache keys
 * (B-7, B2-6), with no hand-bumped constant to forget.
 * @param {Env} env
 */
export function versionId(env) {
  const meta = /** @type {WorkerVersionMetadata | undefined} */ (env.CF_VERSION_METADATA);
  return meta?.id || NO_VERSION_ID;
}

/**
 * Which dense retriever /search uses (wrangler.jsonc `vars.DENSE_BACKEND`).
 * `bundle`, the default, is the exact search over the bundled vectors;
 * `vectorize` is the cold standby (B-1): it swaps only the retriever, so the
 * filters still apply the same way, and it is degraded service (B3-6).
 * @param {Env} env
 * @returns {DenseBackend}
 */
export function denseBackend(env) {
  return /** @type {string | undefined} */ (env.DENSE_BACKEND) === 'vectorize' ? 'vectorize' : 'bundle';
}

// Reciprocal-rank fusion constant. 60 is the value from the original Cormack et
// al. RRF paper and the usual default; it damps the top of each list so neither
// retriever can dominate on rank alone.
const RRF_K = 60;
// Each retriever contributes a deeper list than we return, so a document ranked
// mid-list by one engine and top by the other can still surface.
const CANDIDATE_MULTIPLIER = 3;

// Reads sem/level/credits/faculty off the query string. Returns the echoed
// filters plus the Vectorize metadata filter they translate to (R4).
/** @param {URLSearchParams} params */
function parseFilters(params) {
  /** @type {FilterEcho} */
  const echo = {};
  /** @type {VectorFilter} */
  const filter = {};
  /** @type {string[]} */
  const errors = [];

  const sem = params.get('sem');
  if (sem !== null && sem !== '') {
    const n = Number(sem);
    if (!Number.isInteger(n) || n < 1 || n > 4) errors.push('sem must be 1, 2, 3 or 4');
    else { echo.sem = n; filter[`sem${n}`] = true; }
  }

  const level = params.get('level');
  if (level !== null && level !== '') {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 1 || n > 8) errors.push('level must be an integer from 1 to 8');
    else { echo.level = n; filter.level = n; }
  }

  const credits = params.get('credits');
  if (credits !== null && credits !== '') {
    const n = Number(credits);
    if (!Number.isFinite(n) || n < 0) errors.push('credits must be a non-negative number');
    else { echo.credits = n; filter.credits = n; }
  }

  const faculty = params.get('faculty');
  if (faculty !== null && faculty.trim() !== '') {
    echo.faculty = faculty.trim();
    filter.faculty = faculty.trim();
  }

  // Exchange-student availability. Only `true` narrows: ng=false would mean
  // "show me courses I am NOT allowed to take", which nobody wants.
  const ng = params.get('ng');
  if (ng !== null && ng !== '' && ng !== 'false' && ng !== '0') {
    echo.ng = true;
    filter.ng = true;
  }

  // 3H's explicit params (plan 3H "Query side"). Vectorize metadata has no 3H
  // field, so they never reach `filter`: the standby applies them after hydrate.
  const exam = params.get('exam');
  if (exam !== null && exam !== '') {
    if (exam !== '0') errors.push('exam must be 0 (no final exam listed)');
    else echo.exam = 0;
  }
  const su = params.get('su');
  if (su !== null && su !== '') {
    if (su !== '1') errors.push('su must be 1 (S/U-able or graded CS/CU)');
    else echo.su = 1;
  }
  const hoursBelow = params.get('hoursBelow');
  if (hoursBelow !== null && hoursBelow !== '') {
    const n = Number(hoursBelow);
    if (!/^[1-9][0-9]?$/.test(hoursBelow)) errors.push('hoursBelow must be an integer from 1 to 99');
    else echo.hoursBelow = n;
  }
  const prereq = params.get('prereq');
  if (prereq !== null && prereq !== '') {
    if (prereq !== 'none') errors.push('prereq must be none');
    else echo.prereq = 'none';
  }

  return { echo, filter, errors };
}

/**
 * Validates every parameter /search reads. Unknown parameters are ignored.
 * @param {URLSearchParams} params
 * @returns {{ log: Record<string, unknown>, error: string, query?: undefined } | { log: Record<string, unknown>, query: SearchQuery, error?: undefined }}
 */
export function parseSearch(params) {
  const raw = params.get('q');
  const trimmed = raw?.trim() ?? null;
  const q = trimmed === null ? null : canonicalQuery(trimmed);
  /** @type {Record<string, unknown>} */
  const log = { q: q?.slice(0, LOGGED_QUERY_CHARS) ?? null, qLength: q?.length ?? null, degraded: null };

  // R6: missing, empty or over-long queries are 400s that name the problem.
  if (trimmed === null || q === null) return { log, error: 'Missing required query parameter "q".' };
  if (trimmed === '') return { log, error: 'Query parameter "q" was empty.' };
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { log, error: `Query parameter "q" was ${trimmed.length} characters; the maximum is ${MAX_QUERY_CHARS}.` };
  }

  const { echo, filter, errors } = parseFilters(params);
  // faculty is free text: log only whether it was set, never its value.
  log.filters = { ...echo, ...(echo.faculty !== undefined ? { faculty: true } : {}) };
  if (errors.length) return { log, error: errors.join('; ') };

  // Retrieval mode. Defaults to the hybrid that ships; `vector` and `lexical`
  // exist so the evaluation harness can measure each half on its own, which is
  // what the gate is actually about.
  const mode = params.get('mode') ?? 'hybrid';
  if (mode !== 'hybrid' && mode !== 'vector' && mode !== 'lexical') {
    log.mode = 'invalid';
    return { log, error: `Unknown mode "${mode}"; expected hybrid, vector or lexical.` };
  }
  log.mode = mode;

  // R6/L-limits: topK above the ceiling is clamped, not rejected. An empty
  // topK= is the default (B8), not Number('') = 0 clamped to 1.
  const rawTopK = params.get('topK')?.trim() ?? '';
  const requestedTopK = rawTopK === '' ? DEFAULT_TOPK : Number(rawTopK);
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.trunc(requestedTopK), 1), MAX_TOPK)
    : DEFAULT_TOPK;
  log.topK = topK;

  // 3B: intents to undo, in parsed form (sorted, de-duplicated).
  const ignored = parseIgnore(params.get('ignore'));
  if (ignored.error !== undefined) return { log, error: ignored.error };
  if (ignored.ignore.length) log.ignore = ignored.ignore;

  return { log, query: { q, echo, filter, mode, topK, ignore: ignored.ignore } };
}

/**
 * The cache key for a validated search (B7): only the parameters that change
 * the answer, in their parsed form, sorted, with defaults omitted, plus the
 * data version (`dv`) and the deployed version id (`v`, B3-1). Spelling,
 * order and junk parameters all map to one entry. Every parameter a later
 * workstream adds joins the key here, parsed, in the PR that adds it (3H's
 * `exam`, `su`, `hoursBelow`, `prereq`; `ignore` as a sorted, de-duplicated
 * list), with its own test beside the B7 key tests; intents parsed from `q`
 * need none, since `q` is in the key.
 * @param {string} origin
 * @param {SearchQuery} query
 * @param {string} [version] the deployed version id (versionId(env))
 */
export function canonicalCacheKey(origin, { q, echo, mode, topK, ignore }, version = NO_VERSION_ID) {
  /** @type {[string, string][]} */
  const pairs = [['q', q], ['dv', DATA_VERSION], ['v', version]];
  if (echo.sem !== undefined) pairs.push(['sem', String(echo.sem)]);
  if (echo.level !== undefined) pairs.push(['level', String(echo.level)]);
  if (echo.credits !== undefined) pairs.push(['credits', String(echo.credits)]);
  if (echo.faculty !== undefined) pairs.push(['faculty', echo.faculty]);
  if (echo.ng === true) pairs.push(['ng', '1']);
  if (echo.exam === 0) pairs.push(['exam', '0']);
  if (echo.su === 1) pairs.push(['su', '1']);
  if (echo.hoursBelow !== undefined) pairs.push(['hoursBelow', String(echo.hoursBelow)]);
  if (echo.prereq === 'none') pairs.push(['prereq', 'none']);
  if (mode !== 'hybrid') pairs.push(['mode', mode]);
  if (topK !== DEFAULT_TOPK) pairs.push(['topK', String(topK)]);
  if (ignore.length) pairs.push(['ignore', ignore.join(',')]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Request(`${origin}/search?${new URLSearchParams(pairs)}`, { method: 'GET' });
}

/**
 * The cache key a /search URL maps to, or null if its parameters are invalid
 * (invalid requests are never cached).
 * @param {string | URL} url
 * @param {string} [version] the deployed version id, as canonicalCacheKey
 */
export function searchCacheKey(url, version = NO_VERSION_ID) {
  const u = new URL(url);
  const { query } = parseSearch(u.searchParams);
  return query ? canonicalCacheKey(u.origin, query, version) : null;
}

/**
 * Whether a fresh D1 row passes the filters and 3B's constraints (code
 * ranges, a level window).
 * @param {ResultRow} row
 * @param {Constraints} echo
 */
function localMatchesFilters(row, echo) {
  if (echo.ng === true && row.ng !== 1) return false;
  if (echo.sem !== undefined && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.level !== undefined && row.level !== echo.level) return false;
  if (echo.credits !== undefined && row.credits !== echo.credits) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  if (echo.levelWindow) {
    const { min, max } = echo.levelWindow;
    if (row.level === null || row.level < min || (max !== null && row.level > max)) return false;
  }
  if (echo.ranges && !echo.ranges.some(([lo, hi]) => row.code >= lo && row.code < hi)) return false;
  // 3H, as lexical.js filterSql and the bundle mask state them.
  if (echo.exam === 0) {
    const exams = JSON.parse(row.exam_semesters ?? '[]');
    if (echo.sem !== undefined ? exams.includes(echo.sem) : exams.length > 0) return false;
  }
  if (echo.su === 1 && row.su !== 1 && row.grading_basis !== 'Completed Satisfactory/Unsatisfactory') return false;
  if (echo.hoursBelow !== undefined && !(row.workload_hours != null && row.workload_hours < echo.hoursBelow)) return false;
  if (echo.prereq === 'none' && !(row.prereq_none === 1 || (INTENT.prereq === 'ii' && row.prereq_cohort_only === 1))) return false;
  return true;
}

/**
 * The ranges both lists admit.
 * @param {CodeRange[]} a @param {CodeRange[]} b
 * @returns {CodeRange[]}
 */
function intersectRanges(a, b) {
  /** @type {CodeRange[]} */
  const out = [];
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      const lo = alo > blo ? alo : blo;
      const hi = ahi < bhi ? ahi : bhi;
      if (lo < hi) out.push([lo, hi]);
    }
  }
  return out;
}

// Reciprocal-rank fusion: each list contributes 1/(k + rank) to a document's
// score. Rank-based, so the vector engine's cosine scores and FTS5's bm25
// values never have to be made commensurable.
/** @param {string[][]} lists */
function fuse(lists) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const list of lists) {
    list.forEach((code, i) => {
      scores.set(code, (scores.get(code) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  // RRF produces exact ties constantly (any two documents at the same rank in
  // exactly one list each). Breaking them alphabetically systematically favours
  // early-alphabet codes, which correlates with whatever a fixture happens to
  // contain. A stable hash of the id is arbitrary but unbiased.
  const tiebreak = (/** @type {string} */ code) => {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
    return h;
  };
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || tiebreak(a[0]) - tiebreak(b[0]) || a[0].localeCompare(b[0]))
    .map(([code, score]) => ({ code, score }));
}

/**
 * Turns a promise into one that always fulfils, so Promise.all waits for
 * every branch and the caller decides which failure wins.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: any }>}
 */
const settle = (p) => p.then((value) => ({ ok: /** @type {const} */ (true), value }), (error) => ({ ok: /** @type {const} */ (false), error }));

/** A dense-half failure, attributed to the binding (or the bundle) that failed. */
class DenseFailure extends Error {
  /** @param {'workers-ai' | 'vectorize' | 'dense-index'} source @param {any} cause */
  constructor(source, cause) {
    super(cause?.message ?? String(cause), { cause });
    this.source = source;
    this.timedOut = cause instanceof TimeoutError;
  }
}

/**
 * Embeds one text, a single-text call: the query, 3C-2's corrected text, or a
 * catalogue-only module's text for noMatch `related`.
 * @param {Env} env
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedOne(env, text) {
  try {
    const embedded = /** @type {{ data?: number[][] }} */ (await withTimeout('Workers AI', AI_TIMEOUT_MS, (signal) =>
      env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: [text] }, { signal })));
    const values = embedded?.data?.[0];
    if (!Array.isArray(values)) throw new Error('Workers AI returned no embedding for the query.');
    return values;
  } catch (err) {
    throw new DenseFailure('workers-ai', err);
  }
}

/**
 * Embeds each text in its own call, all at once (B-11: neither depends on
 * batching), so the `embed` span is the slowest call, not the sum.
 * @param {Env} env @param {string[]} texts @param {Trace} trace
 * @returns {Promise<number[][]>}
 */
const embedAll = (env, texts, trace) => trace.time('embed', () => Promise.all(texts.map((t) => embedOne(env, t))));

/**
 * The texts the dense half embeds: the query as typed (the canonical q), and
 * under 3C-2 also its corrected text when 3C corrected anything.
 * @param {Pick<ParsedQuery, 'dense' | 'corrected'>} parsed
 * @param {boolean} [embedCorrected] the variant's choice (src/typo.js)
 */
export const denseTexts = (parsed, embedCorrected = EMBED_CORRECTED) =>
  (embedCorrected && parsed.corrected !== null ? [parsed.dense, parsed.corrected] : [parsed.dense]);

/**
 * Dense hit lists for one corpus, from different query vectors, as one list:
 * each code at its best cosine, best first (ties in the order first seen),
 * at most `depth`. Exact: a code in the true top `depth` by best score is in
 * the top `depth` of the vector that gives it that score. One list is
 * returned as it is.
 * @param {DenseHit[][]} lists @param {number} depth
 * @returns {DenseHit[]}
 */
export function mergeDense(lists, depth) {
  if (lists.length === 1) return lists[0].slice(0, depth);
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const list of lists) {
    for (const { code, score } of list) {
      const prev = best.get(code);
      if (prev === undefined || score > prev) best.set(code, score);
    }
  }
  return [...best].map(([code, score]) => ({ code, score })).sort((a, b) => b.score - a.score).slice(0, depth);
}

/**
 * The bundle's exact search for each query vector, merged; failures
 * attributed to the bundle.
 * @param {ArrayLike<number>[]} vectors
 * @param {Constraints} constraints
 * @param {number} depth
 * @param {Trace} trace
 * @param {(score: number) => void} [firstTop] told the first vector's top cosine (3G), unless it found none
 * @returns {Promise<DenseHit[]>}
 */
async function bundleHits(vectors, constraints, depth, trace, firstTop) {
  // CPU only: the `vector` span reads ~0 because workerd's clock does not
  // advance without I/O. Kept for comparability with Vectorize, not as a measure.
  try {
    return await trace.time('vector', async () => {
      const lists = vectors.map((v) => bundleSearch(v, constraints, depth));
      if (lists[0].length) firstTop?.(lists[0][0].score);
      return mergeDense(lists, depth);
    });
  } catch (err) {
    throw new DenseFailure('dense-index', err);
  }
}

/**
 * Searches the corpus vectors: the bundled exact search, or Vectorize under
 * `DENSE_BACKEND=vectorize`. Vectorize gets the filters only (its metadata has
 * no prefix or level-window field): 3B's code ranges and level window are
 * applied to its rows after hydrate (B3-6), as dense-only rows always are.
 * Embedding and vector search are attributed separately: guessing the source
 * from the message text mislabelled Workers AI failures as Vectorize.
 * @param {Env} env
 * @param {ArrayLike<number>[]} vectors one per embedded text, merged (mergeDense)
 * @param {Constraints} constraints the bundle's mask
 * @param {VectorFilter} filter the filters as a Vectorize metadata filter
 * @param {number} depth
 * @param {Trace} trace
 * @param {(score: number) => void} [firstTop] told the first vector's top cosine (3G), unless it found none
 * @returns {Promise<DenseHit[]>}
 */
async function vectorSearch(env, vectors, constraints, filter, depth, trace, firstTop) {
  if (denseBackend(env) === 'bundle') return bundleHits(vectors, constraints, depth, trace, firstTop);
  try {
    // Only ids and scores are read, so no metadata or values are requested.
    const lists = await trace.time('vector', () => Promise.all(vectors.map((vector) => withTimeout('Vectorize', VECTORIZE_TIMEOUT_MS, () =>
      env.VECTORIZE.query(/** @type {number[]} */ (vector), { topK: depth, ...(Object.keys(filter).length ? { filter } : {}) })))));
    const hits = lists.map((result) => (result?.matches ?? []).map((m) => ({ code: m.id, score: m.score })));
    if (hits[0].length) firstTop?.(hits[0][0].score);
    return mergeDense(hits, depth);
  } catch (err) {
    throw new DenseFailure('vectorize', err);
  }
}

/**
 * Embeds `texts` and runs `then` on their vectors, under the dense circuit
 * breaker: a dense half that keeps failing is skipped for a while (B6).
 * @template T
 * @param {Env} env @param {string[]} texts @param {Trace} trace
 * @param {(vectors: number[][]) => Promise<T>} then
 * @returns {Promise<T>}
 */
const denseRun = (env, texts, trace, then) => embedAll(env, texts, trace).then(then).then(
  (value) => { denseCircuit.success(); return value; },
  (err) => { denseCircuit.failure(err.source); throw err; },
);

/** D1 binds at most 100 parameters per statement. */
const D1_PARAMS = 100;

/**
 * @param {D1DatabaseSession} db
 * @param {string[]} codes
 * @param {Trace} trace
 * @returns {Promise<Map<string, ResultRow>>}
 */
async function fetchRows(db, codes, trace) {
  /** @type {Map<string, ResultRow>} */
  const rows = new Map();
  // D1 binds at most D1_PARAMS per statement; a collapsed mask page can need more members (3F).
  for (let i = 0; i < codes.length; i += D1_PARAMS) {
    const chunk = codes.slice(i, i + D1_PARAMS);
    const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'hydrate', () => db.prepare(
      `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all()));
    trace.d1Result(res);
    for (const r of res.results) rows.set(r.code, r);
  }
  return rows;
}


/** The columns a variant needs: its code and credits, and the fields localMatchesFilters reads. */
const VARIANT_COLUMNS = 'code, credits, level, faculty, semesters, ng, ng_semesters, '
  + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only';

/**
 * 3G's τ: NO_SIGNAL_TAU, or the NO_SIGNAL_TAU var (tests only; production
 * sets none): a number (or a numeric string), or "off" for none.
 * @param {Env} env
 * @returns {number | null}
 */
const noSignalTau = (env) => {
  const v = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (env)).NO_SIGNAL_TAU;
  if (v === 'off') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : NO_SIGNAL_TAU;
};

/**
 * Whether 3F's collapse runs: always, unless the COLLAPSE_GROUPS var is "off"
 * (an operator's switch, and how the tests fetch the uncollapsed list).
 * @param {Env} env
 */
const collapseOn = (env) => /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (env)).COLLAPSE_GROUPS !== 'off';

/**
 * 3F (plan 3F, C-8): each result in a duplicate group (groups-v1) carries its
 * group's other members that pass the filters as `variants: [{ code, credits }]`,
 * in code order, read from D1 (credits differ inside some groups). Results with
 * none are left as they are.
 * @param {D1DatabaseSession} db
 * @param {ReturnType<typeof rowToModule>[]} results already collapsed: one per group
 * @param {Constraints} echo the request's filters
 * @param {Trace} trace
 */
async function attachVariants(db, results, echo, trace) {
  const { groupOf, members } = groups();
  const shown = new Set(results.map((r) => r.code));
  /** @type {Map<string, string[]>} result code -> its candidate variants */
  const want = new Map();
  for (const r of results) {
    const key = groupOf.get(r.code);
    if (key === undefined) continue;
    const others = /** @type {string[]} */ (members.get(key)).filter((c) => !shown.has(c));
    if (others.length) want.set(r.code, others);
  }
  if (want.size === 0) return results;
  const codes = [...new Set([...want.values()].flat())];
  /** @type {Map<string, ResultRow>} */
  const rows = new Map();
  for (let i = 0; i < codes.length; i += D1_PARAMS) {
    const chunk = codes.slice(i, i + D1_PARAMS);
    // Only what a variant renders (code, credits) and what the filter check reads.
    const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'variants', () => db.prepare(
      `SELECT ${VARIANT_COLUMNS} FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all()));
    trace.d1Result(res);
    for (const row of res.results) rows.set(row.code, row);
  }
  return results.map((r) => {
    const variants = (want.get(r.code) ?? []).flatMap((code) => {
      const row = rows.get(code);
      return row && localMatchesFilters(row, echo) ? [{ code, credits: row.credits }] : [];
    });
    return variants.length ? { ...r, variants } : r;
  });
}

/**
 * The parse, with "offered" answered from this Worker's corpus: the bundle's
 * code list first, then D1 for any code-shaped string the bundle lacks (one
 * indexed `code IN (…)` read, only then). D1 is the corpus: between a D1-only
 * ingest and the deploy that bundles its vectors (runbook steps 4–6), a new
 * module, or one that moved from catalogue-only to offered, is in D1 and not
 * yet in the bundle, and it must still pin. When the bundle does not parse
 * (keyword-only, B6) every question goes to D1. The parse is re-run until it
 * asks about no code D1 has not answered (one read in practice; a join that
 * D1 confirms can ask one more).
 * @param {D1DatabaseSession} db @param {string} q @param {string[]} ignore @param {Trace} trace
 * @returns {Promise<ParsedQuery>}
 */
async function parseWithCorpus(db, q, ignore, trace) {
  /** @type {import('./vector-bundle.js').Bundle | null} */
  let bundle = null;
  try { bundle = denseBundle(); } catch { /* answered from D1 below */ }
  const b = bundle;
  /** @type {Map<string, boolean>} D1's answers */
  const known = new Map();
  for (;;) {
    /** @type {Set<string>} */
    const asked = new Set();
    const parsed = parseQuery(q, intentContext((code) => {
      if (b && hasCode(b, code)) return true;
      if (!known.has(code)) asked.add(code);
      return known.get(code) === true;
    }), ignore);
    if (asked.size === 0) return parsed;
    const codes = [...asked];
    for (let i = 0; i < codes.length; i += D1_PARAMS) {
      const chunk = codes.slice(i, i + D1_PARAMS);
      const res = /** @type {D1Result<{ code: string }>} */ (await d1Timed(trace, 'pin', () => db.prepare(
        `SELECT code FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()));
      trace.d1Result(res);
      const found = new Set(res.results.map((r) => r.code));
      for (const c of chunk) known.set(c, found.has(c));
    }
  }
}

/** noMatch `related` holds this many dense neighbours of the catalogue text. */
const RELATED_K = 5;
/** 3H's request params (C-12): hard filters the standby's metadata cannot apply. */
const INTENT_PARAMS = /** @type {const} */ (['exam', 'su', 'hoursBelow', 'prereq']);
/** How deep the standby reads `related` under a 3H constraint: the dense path's cap. */
const STANDBY_RELATED_DEPTH = 50;
/** The catalogue text embedded for `related` is cut here (bge-small reads ~512 tokens anyway). */
const RELATED_TEXT_CHARS = 2000;

/**
 * A catalogue-only module's text for `related`: title and description, each
 * ending in one sentence mark.
 * @param {{ title: string, description: string | null }} row
 */
const catalogueText = (row) => [row.title, row.description]
  .filter((s) => typeof s === 'string' && s.trim())
  .map((s) => { const t = /** @type {string} */ (s).replace(/\s+/g, ' ').trim(); return /[.!?]$/.test(t) ? t : `${t}.`; })
  .join(' ')
  .slice(0, RELATED_TEXT_CHARS);

/**
 * Runs a validated search. The parse (src/query-intent.js) picks the route:
 * - `no-match`: a whole-query unknown or catalogue-only code, `count: 0`;
 * - `mask`: a whole-query partial code, bare prefix, `XX N000` or GE phrase,
 *   whose members are the results, by exact dense score (in code order
 *   without the dense half: mode=lexical, the keyword-only fallback, the
 *   Vectorize standby);
 * - `search`: pin lookup, lexical retrieval and embed→dense start together
 *   (B4), with the GE pre-retrieval mask on both halves and a code token's
 *   prefix members as a third RRF list; hydration follows once all have settled.
 * @param {SearchQuery} query
 * @param {Env} env
 * @param {Trace} trace
 * @param {Record<string, unknown>} log Filled with what the request turned out to be.
 * @returns {Promise<{ response: Response, degraded: Degraded | null }>}
 */
async function runSearch({ q, echo, filter, mode, topK, ignore }, env, trace, log) {
  const db = readSession(env);
  // Spans in pipeline order, whichever branch finishes first.
  trace.reserve('pin', 'embed', 'vector', 'fts', 'hydrate');

  /** @type {ParsedQuery} */
  let parsed;
  try {
    parsed = await parseWithCorpus(db, q, ignore, trace);
  } catch (err) {
    return { response: upstream('d1', err), degraded: null };
  }
  log.route = parsed.kind;
  const collapsing = collapseOn(env);
  // Retrieval depth per list. 3F collapses the deepest uncollapsed ranking
  // (topK 50, so each list 50 deep) to fill its page. A single list (lexical,
  // or the bundle's exact dense order, with no code list) can go deeper,
  // since a deeper list only continues the same order. A fused one cannot,
  // since deeper lists change RRF's sums. 100 is Vectorize's topK cap.
  const singleList = !parsed.codeList && (mode === 'lexical' || (mode === 'vector' && denseBackend(env) === 'bundle'));
  const depth = !collapsing ? Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK) : singleList ? MAX_TOPK * 2 : MAX_TOPK;

  // Dense retrieval. In hybrid mode a failure degrades to keyword-only results
  // (B6); in vector mode it fails loudly, because the eval measures that half.
  // A dense half that keeps failing is skipped outright for a while, so it does
  // not add its timeout to every search.
  /** @type {Degraded | null} */
  let degraded = null;
  const tryDense = mode === 'vector' || (mode === 'hybrid' && !denseCircuit.open());
  if (mode === 'hybrid' && !tryDense) degraded = { source: denseCircuit.lastSource ?? 'workers-ai', reason: 'circuit-open' };
  /** @param {DenseFailure} err */
  const degrade = (err) => {
    degraded = { source: err.source, reason: err.timedOut ? 'timeout' : 'error' };
    log.degradedMessage = err.message;
  };

  /**
   * @param {ReturnType<typeof rowToModule>[]} results
   * @param {Record<string, number>} retrieval
   * @param {Record<string, unknown>} [extra]
   */
  const respond = (results, retrieval, extra = {}) => {
    if (degraded) {
      log.degraded = degraded;
      trace.describe('degraded', `${degraded.source}-${degraded.reason}`);
    }
    log.dense = mode === 'lexical' ? null : denseBackend(env);
    return {
      degraded,
      response: json({
        query: q,
        filters: echo,
        count: results.length,
        mode,
        interpreted: parsed.interpreted,
        ...extra,
        ...(degraded ? { degraded } : {}),
        retrieval,
        results,
      }),
    };
  };

  // 3H: the parsed intents join the explicit params (the tighter hour limit holds).
  /** @type {FilterEcho} */
  const intentFilter = { ...echo, ...parsed.constraints };
  if (echo.hoursBelow !== undefined && parsed.constraints.hoursBelow !== undefined) {
    intentFilter.hoursBelow = Math.min(echo.hoursBelow, parsed.constraints.hoursBelow);
  }
  /** @type {Constraints} */
  const constraints = {
    ...intentFilter,
    ...(parsed.level ? { levelWindow: parsed.level } : {}),
    ...(parsed.ranges ? { ranges: parsed.ranges } : {}),
  };
  // 3F: variants pass the request's filters, 3H's intents and the query's level
  // window, but not its code ranges (a GES result may list its GESS cross-listing).
  const variantFilter = parsed.level ? { ...intentFilter, levelWindow: parsed.level } : intentFilter;

  // ── no-match: `count: 0`; a not-offered code names its catalogue title and
  // the dense neighbours of its catalogue text, never in `results`.
  if (parsed.kind === 'no-match') {
    const nm = /** @type {import('./query-intent.js').NoMatch} */ (parsed.noMatch);
    if (nm.reason === 'unknown-code') {
      log.counts = { returned: 0 };
      return respond([], { vector: 0, lexical: 0, fused: 0 }, { noMatch: { reason: nm.reason, code: nm.code } });
    }
    /** @type {{ title: string, description: string | null } | null} */
    let row = null;
    try {
      row = await d1Timed(trace, 'pin', () => db.prepare('SELECT title, description FROM catalogue_only WHERE code = ?').bind(nm.code).first());
    } catch (err) {
      // No catalogue_only table yet (migration 0008 not applied): still a not-offered answer.
      console.warn(`catalogue_only lookup failed: ${/** @type {any} */ (err)?.message ?? err}`);
    }
    /** @type {string[]} */
    let related = [];
    if (row && tryDense) {
      const text = catalogueText(row);
      // The standby's metadata has no 3H fields: it reads deeper, and its
      // neighbours are checked after hydrate.
      const standby = denseBackend(env) !== 'bundle';
      const depth = standby && INTENT_PARAMS.some((k) => intentFilter[k] !== undefined) ? STANDBY_RELATED_DEPTH : RELATED_K;
      const hits = await settle(denseRun(env, [text], trace, (vs) => vectorSearch(env, vs, intentFilter, filter, depth, trace)));
      if (hits.ok) related = hits.value.map((h) => h.code);
      else degrade(/** @type {DenseFailure} */ (hits.error));
      if (related.length && standby) {
        const rows = await fetchRows(db, related, trace);
        related = related.filter((c) => {
          const r = rows.get(c);
          return r !== undefined && localMatchesFilters(r, intentFilter);
        });
      }
      related = related.slice(0, RELATED_K);
    }
    log.counts = { returned: 0, related: related.length };
    return respond([], { vector: related.length, lexical: 0, fused: 0 }, {
      noMatch: { reason: nm.reason, code: nm.code, title: row?.title ?? null, related },
    });
  }

  // ── mask: the members, by exact dense score, else in code order.
  if (parsed.kind === 'mask') {
    const maskConstraints = /** @type {Constraints & { ranges: CodeRange[] }} */ (constraints);
    /** @type {DenseHit[] | null} */
    let hits = null;
    // With 3F's collapse a page of topK groups can need more members than topK.
    const maskDepth = collapsing ? Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK * CANDIDATE_MULTIPLIER) : topK;
    if (tryDense && denseBackend(env) === 'bundle') {
      const r = await settle(denseRun(env, denseTexts(parsed), trace, (vs) => bundleHits(vs, maskConstraints, maskDepth, trace)));
      if (r.ok) hits = r.value;
      else if (mode === 'vector') return { response: upstream(r.error.source, r.error), degraded: null };
      else degrade(r.error);
    }
    /** @type {string[]} */
    let order;
    try {
      order = hits ? hits.map((h) => h.code) : await withTimeout('D1', D1_TIMEOUT_MS, () => rangeMembers(db, maskConstraints, maskDepth, trace));
    } catch (err) {
      return { response: upstream('d1-fts', err), degraded: null };
    }
    /** @type {Map<string, ResultRow>} */
    let rows;
    try {
      rows = await fetchRows(db, order, trace);
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
    const score = new Map((hits ?? []).map((h) => [h.code, h.score]));
    // Dense members re-checked against their fresh D1 row (B-3); code-order members came from D1.
    let results = order.flatMap((code) => {
      const row = rows.get(code);
      if (!row || (hits && !localMatchesFilters(row, maskConstraints))) return [];
      return [rowToModule(row, score.get(code))];
    });
    // 3F: after the filters, one result per duplicate group, the rest as its variants.
    if (collapsing) {
      const { groupOf } = groups();
      const seen = new Set();
      results = results.filter((r) => { const k = groupKeyOf(groupOf, r.code); return seen.has(k) ? false : (seen.add(k), true); }).slice(0, topK);
      try {
        results = await attachVariants(db, results, variantFilter, trace);
      } catch (err) {
        return { response: upstream('d1', err), degraded: null };
      }
    } else {
      results = results.slice(0, topK);
    }
    log.counts = { members: order.length, returned: results.length, order: hits ? 'dense' : 'code' };
    return respond(results, { vector: hits ? order.length : 0, lexical: hits ? 0 : order.length, fused: results.length });
  }

  // ── search: pins, then the fused lists.
  // R5: offered codes jump to the front, in query order, if the filters allow them.
  const pinning = parsed.pins.length
    ? settle(d1Timed(trace, 'pin', () => db.prepare(parsed.pins.length === 1
      ? `SELECT ${RESULT_COLUMNS} FROM modules WHERE code = ?`
      : `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${parsed.pins.map(() => '?').join(',')})`).bind(...parsed.pins).all()))
    : null;

  // The third list: a code token's prefix members, within any GE mask.
  /** @type {(Constraints & { ranges: CodeRange[] }) | null} */
  const codeConstraints = parsed.codeList
    ? { ...constraints, ranges: parsed.ranges ? intersectRanges(parsed.codeList, parsed.ranges) : parsed.codeList }
    : null;
  const codeByDense = codeConstraints !== null && denseBackend(env) === 'bundle';
  const codeCons = codeConstraints;
  /** @returns {Promise<string[]>} */
  const codeOrder = () => withTimeout('D1', D1_TIMEOUT_MS, () => rangeMembers(db, /** @type {Constraints & { ranges: CodeRange[] }} */ (codeCons), depth, trace));

  // 3G: the top cosine of the query as typed (the first dense text), read only when noSignal
  // holds. With no dense hit (filters no module passes) there is none, and 3G does not fire.
  let topCosine = Infinity;
  const tau = noSignalTau(env);
  const dense = tryDense
    ? settle(denseRun(env, denseTexts(parsed), trace, async (vs) => ({
      main: await vectorSearch(env, vs, constraints, filter, depth, trace, parsed.noSignal && tau !== null ? (s) => { topCosine = s; } : undefined),
      code: codeByDense && codeCons ? await bundleHits(vs, codeCons, depth, trace) : null,
    })))
    : null;

  // Lexical retrieval over the same corpus (corrected, GE phrases stripped,
  // 3C's prefix terms), fused by rank.
  const lexical = mode !== 'vector'
    ? settle(withTimeout('D1', D1_TIMEOUT_MS, () => lexicalSearch(db, parsed.lexical, constraints, depth, trace, parsed.fts)))
    : null;
  // The third list in code order, when the dense order is not coming.
  const codeEarly = codeCons && (!tryDense || !codeByDense) ? settle(codeOrder()) : null;

  const [pin, vec, lex, early] = await Promise.all([pinning, dense, lexical, codeEarly]);

  const { groupOf } = groups();
  /** @type {ReturnType<typeof rowToModule>[]} */
  const pinned = [];
  // 3F: each duplicate group's first member stands for it, pins included.
  /** @type {Set<string>} */
  const groupsShown = new Set();
  if (pin) {
    if (!pin.ok) return { response: upstream('d1', pin.error), degraded: null };
    const res = /** @type {D1Result<ResultRow>} */ (pin.value);
    trace.d1Result(res);
    const byCodeRow = new Map(res.results.map((r) => [r.code, r]));
    for (const code of parsed.pins) {
      const row = byCodeRow.get(code);
      // A pin passes the filters and 3H's intents (not 3B's ranges, which it routes around).
      if (!row || !localMatchesFilters(row, intentFilter)) continue;
      if (collapsing) {
        const k = groupKeyOf(groupOf, code);
        if (groupsShown.has(k)) continue;
        groupsShown.add(k);
      }
      pinned.push(rowToModule(row, 1));
    }
  }

  /** @type {DenseHit[]} */
  let denseHits = [];
  /** @type {string[] | null} */
  let codeCodes = null;
  if (vec && vec.ok) {
    denseHits = vec.value.main;
    if (vec.value.code) codeCodes = vec.value.code.map((h) => h.code);
  } else if (vec) {
    const err = /** @type {DenseFailure} */ (vec.error);
    if (mode === 'vector') return { response: upstream(err.source, err), degraded: null };
    degrade(err);
  }

  /** @type {string[]} */
  let lexicalCodes = [];
  if (lex && !lex.ok) return { response: upstream('d1-fts', lex.error), degraded: null };
  if (lex) lexicalCodes = lex.value;

  // 3G: no route, no vocabulary match before correction, and the dense half
  // finds nothing near: `count: 0`, before hydration. Needs the dense half.
  if (vec && vec.ok && tau !== null && parsed.noSignal && topCosine < tau) {
    log.counts = { returned: 0, vector: denseHits.length, lexical: lexicalCodes.length };
    log.topCosine = Math.round(topCosine * 1e4) / 1e4;
    return respond([], { vector: denseHits.length, lexical: lexicalCodes.length, fused: 0 }, { noMatch: { reason: 'no-signal' } });
  }

  if (codeCons && codeCodes === null) {
    const got = early ?? await settle(codeOrder());
    if (!got.ok) return { response: upstream('d1-fts', got.error), degraded: null };
    codeCodes = got.value;
  }
  const vectorCodes = denseHits.map((h) => h.code);

  /** @type {string[][]} */
  const lists = mode === 'vector' ? [vectorCodes]
    : mode === 'lexical' || degraded ? [lexicalCodes]
      : [vectorCodes, lexicalCodes];
  if (codeCodes) lists.push(codeCodes);
  const pinnedCodes = new Set(pinned.map((p) => p.code));
  const fused = fuse(lists).filter((f) => !pinnedCodes.has(f.code));

  // Hydrate only as many fused candidates as the response shows (B8). A
  // candidate missing from D1 means a stale index: drop it and hydrate the
  // next one, so the page is the same as hydrating every candidate would give.
  // A dense candidate (either dense list) whose fresh D1 row fails the filters
  // or 3B's constraints is dropped the same way (B-3): between a D1-only
  // ingest and the deploy that bundles its vectors, the live bundle's filter
  // table (or the standby's metadata, which has no 3B field) can be older than
  // D1. Lexical and code-order candidates were filtered by D1 itself.
  let results = [...pinned];
  // 3F: later members of a shown group are skipped after the filters, so one never stands in.
  const lexicalSet = new Set(lexicalCodes);
  const denseOnly = new Set([...vectorCodes, ...(codeByDense ? codeCodes ?? [] : [])].filter((c) => !lexicalSet.has(c)));
  /** @type {string[]} */
  const stale = [];
  /** @type {string[]} */
  const filteredOut = [];
  let next = 0;
  while (results.length < topK && next < fused.length) {
    const chunk = fused.slice(next, next + topK - results.length);
    next += chunk.length;
    /** @type {Map<string, ResultRow>} */
    let rows;
    try {
      rows = await fetchRows(db, chunk.map((f) => f.code), trace);
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
    for (const { code, score } of chunk) {
      const row = rows.get(code);
      if (!row) { stale.push(code); continue; }
      if (denseOnly.has(code) && !localMatchesFilters(row, constraints)) { filteredOut.push(code); continue; }
      if (collapsing) {
        const k = groupKeyOf(groupOf, code);
        if (groupsShown.has(k)) continue;
        groupsShown.add(k);
      }
      results.push(rowToModule(row, score));
    }
  }
  if (stale.length) console.warn(`stale vectors not present in D1: ${stale.join(', ')}`);
  if (filteredOut.length) console.warn(`dense rows whose D1 row fails the filters: ${filteredOut.join(', ')}`);
  if (collapsing) {
    try {
      results = await attachVariants(db, results, variantFilter, trace);
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
  }
  // Candidates after fusion that exist in D1 (and pass the filters), as far as hydration saw.
  const fusedCount = pinned.length + fused.length - stale.length - filteredOut.length;
  log.counts = {
    vector: vectorCodes.length, lexical: lexicalCodes.length, ...(codeCodes ? { code: codeCodes.length } : {}), fused: fusedCount,
    returned: results.length, stale: stale.length, filtered: filteredOut.length,
  };
  return respond(results, {
    vector: vectorCodes.length, lexical: lexicalCodes.length, ...(codeCodes ? { code: codeCodes.length } : {}), fused: fusedCount,
  });
}

/**
 * GET /search, from validation to the logged response.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Trace} trace Started at fetch entry, so `total` covers everything.
 * @returns {Promise<Response>}
 */
export async function searchRoute(request, env, ctx, trace) {
  const url = new URL(request.url);
  const parsed = parseSearch(url.searchParams);
  const { log } = parsed;

  /**
   * Sets Server-Timing and writes the log line. The spans are taken once, so
   * the header and the log agree.
   * @param {Response} response Must have mutable headers.
   * @param {'hit' | 'miss' | 'bypass'} cache `bypass`: invalid, never looked up.
   */
  const finish = (response, cache) => {
    const total = trace.total();
    response.headers.set('server-timing', trace.header(total));
    const cf = /** @type {{ colo?: string } | undefined} */ (request.cf);
    console.log(JSON.stringify({
      event: 'search', status: response.status, cache, ...log,
      spans: trace.durations(total), d1: trace.d1, colo: cf?.colo ?? null, version: appVersion(env),
    }));
    return response;
  };

  // Invalid requests are answered before the cache or any binding is touched.
  if (!parsed.query) return finish(bad(parsed.error), 'bypass');

  // Identical searches are common — a shared link, a reload, a load test,
  // the evaluation harness running the same fixture repeatedly. Serving
  // those from cache costs zero D1 rows, zero Vectorize queries and zero
  // Workers AI calls. The key is canonical (B7), and needs no D1 read.
  const cache = caches.default;
  const cacheKey = canonicalCacheKey(url.origin, parsed.query, versionId(env));
  const hit = await trace.time('cache', () => cache.match(cacheKey));
  trace.describe('cache', hit ? 'hit' : 'miss');
  // The stored copy has no Server-Timing; this request's spans are set fresh.
  if (hit) return finish(withHeaders(hit, {}), 'hit');

  // Guardrail: /search is the only route that spends metered upstream quota.
  // It fails open: a broken limiter must not take search down with it.
  if (env.SEARCH_LIMIT) {
    const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    /** @type {boolean} */
    let allowed = true;
    try {
      ({ success: allowed } = await trace.time('limit', () => env.SEARCH_LIMIT.limit({ key })));
    } catch (err) {
      log.limiter = 'error';
      console.error(JSON.stringify({ event: 'limiter_error', message: /** @type {any} */ (err)?.message ?? String(err) }));
    }
    if (!allowed) {
      return finish(new Response(
        JSON.stringify({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' }, null, 2),
        { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'access-control-allow-origin': '*' } },
      ), 'miss');
    }
  }

  const { response, degraded } = await runSearch(parsed.query, env, trace, log);
  // Only successful responses are cached; a 400 or a 502 must stay live.
  if (response.status === 200) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set('cache-control', `public, max-age=${degraded ? DEGRADED_CACHE_TTL_S : CACHE_TTL_S}`);
    // Cloned before Server-Timing is set, so the cache never stores spans.
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return finish(cacheable, 'miss');
  }
  return finish(response, 'miss');
}
