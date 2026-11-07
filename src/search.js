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
import { FUSION, fuse } from './fusion.js';
import { intentContext } from './intent-data.js';
import { lexicalSearch, rangeMembers } from './lexical.js';
import { RESULT_COLUMNS, d1Timed, readSession, rowToModule } from './modules.js';
import { canonicalQuery, parseIgnore, parseQuery } from './query-intent.js';
import { EMBED_CORRECTED } from './typo.js';
import { hasCode } from './vector-bundle.js';
import {
  AI_TIMEOUT_MS, D1_TIMEOUT_MS, TimeoutError, VECTORIZE_TIMEOUT_MS, denseCircuit, withTimeout,
} from './upstream.js';

/**
 * @typedef {import('./modules.js').ResultRow} ResultRow
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {{ sem?: number, level?: number, credits?: number, faculty?: string, ng?: boolean }} FilterEcho
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
 * @returns {Promise<DenseHit[]>}
 */
async function bundleHits(vectors, constraints, depth, trace) {
  // CPU only: the `vector` span reads ~0 because workerd's clock does not
  // advance without I/O. Kept for comparability with Vectorize, not as a measure.
  try {
    return await trace.time('vector', async () => mergeDense(vectors.map((v) => bundleSearch(v, constraints, depth)), depth));
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
 * @returns {Promise<DenseHit[]>}
 */
async function vectorSearch(env, vectors, constraints, filter, depth, trace) {
  if (denseBackend(env) === 'bundle') return bundleHits(vectors, constraints, depth, trace);
  try {
    // Only ids and scores are read, so no metadata or values are requested.
    const lists = await trace.time('vector', () => Promise.all(vectors.map((vector) => withTimeout('Vectorize', VECTORIZE_TIMEOUT_MS, () =>
      env.VECTORIZE.query(/** @type {number[]} */ (vector), { topK: depth, ...(Object.keys(filter).length ? { filter } : {}) })))));
    return mergeDense(lists.map((result) => (result?.matches ?? []).map((m) => ({ code: m.id, score: m.score }))), depth);
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

/**
 * @param {D1DatabaseSession} db
 * @param {string[]} codes
 * @param {Trace} trace
 * @returns {Promise<Map<string, ResultRow>>}
 */
async function fetchRows(db, codes, trace) {
  if (codes.length === 0) return new Map();
  const placeholders = codes.map(() => '?').join(',');
  const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'hydrate', () => db.prepare(
    `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${placeholders})`,
  ).bind(...codes).all()));
  trace.d1Result(res);
  return new Map(res.results.map((r) => [r.code, r]));
}

/** D1 binds at most 100 parameters per statement. */
const D1_PARAMS = 100;

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
  const depth = Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK);
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

  /** @type {Constraints} */
  const constraints = {
    ...echo,
    ...(parsed.level ? { levelWindow: parsed.level } : {}),
    ...(parsed.ranges ? { ranges: parsed.ranges } : {}),
  };

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
      const hits = await settle(denseRun(env, [text], trace, (vs) => vectorSearch(env, vs, echo, filter, RELATED_K, trace)));
      if (hits.ok) related = hits.value.slice(0, RELATED_K).map((h) => h.code);
      else degrade(/** @type {DenseFailure} */ (hits.error));
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
    if (tryDense && denseBackend(env) === 'bundle') {
      const r = await settle(denseRun(env, denseTexts(parsed), trace, (vs) => bundleHits(vs, maskConstraints, topK, trace)));
      if (r.ok) hits = r.value;
      else if (mode === 'vector') return { response: upstream(r.error.source, r.error), degraded: null };
      else degrade(r.error);
    }
    /** @type {string[]} */
    let order;
    try {
      order = hits ? hits.map((h) => h.code) : await withTimeout('D1', D1_TIMEOUT_MS, () => rangeMembers(db, maskConstraints, topK, trace));
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
    const results = order.flatMap((code) => {
      const row = rows.get(code);
      if (!row || (hits && !localMatchesFilters(row, maskConstraints))) return [];
      return [rowToModule(row, score.get(code))];
    });
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

  const dense = tryDense
    ? settle(denseRun(env, denseTexts(parsed), trace, async (vs) => ({
      main: await vectorSearch(env, vs, constraints, filter, depth, trace),
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

  /** @type {ReturnType<typeof rowToModule>[]} */
  const pinned = [];
  if (pin) {
    if (!pin.ok) return { response: upstream('d1', pin.error), degraded: null };
    const res = /** @type {D1Result<ResultRow>} */ (pin.value);
    trace.d1Result(res);
    const byCodeRow = new Map(res.results.map((r) => [r.code, r]));
    for (const code of parsed.pins) {
      const row = byCodeRow.get(code);
      if (row && localMatchesFilters(row, echo)) pinned.push(rowToModule(row, 1));
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

  if (codeCons && codeCodes === null) {
    const got = early ?? await settle(codeOrder());
    if (!got.ok) return { response: upstream('d1-fts', got.error), degraded: null };
    codeCodes = got.value;
  }
  const vectorCodes = denseHits.map((h) => h.code);

  /** @type {import('./fusion.js').RankedList} */
  const vectorList = { kind: 'vector', codes: vectorCodes };
  /** @type {import('./fusion.js').RankedList} */
  const lexicalList = { kind: 'lexical', codes: lexicalCodes };
  /** @type {import('./fusion.js').RankedList[]} */
  const lists = mode === 'vector' ? [vectorList]
    : mode === 'lexical' || degraded ? [lexicalList]
      : [vectorList, lexicalList];
  if (codeCodes) lists.push({ kind: 'code', codes: codeCodes });
  const pinnedCodes = new Set(pinned.map((p) => p.code));
  const fused = fuse(lists, FUSION).filter((f) => !pinnedCodes.has(f.code));

  // Hydrate only as many fused candidates as the response shows (B8). A
  // candidate missing from D1 means a stale index: drop it and hydrate the
  // next one, so the page is the same as hydrating every candidate would give.
  // A dense candidate (either dense list) whose fresh D1 row fails the filters
  // or 3B's constraints is dropped the same way (B-3): between a D1-only
  // ingest and the deploy that bundles its vectors, the live bundle's filter
  // table (or the standby's metadata, which has no 3B field) can be older than
  // D1. Lexical and code-order candidates were filtered by D1 itself.
  const results = [...pinned];
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
      results.push(rowToModule(row, score));
    }
  }
  if (stale.length) console.warn(`stale vectors not present in D1: ${stale.join(', ')}`);
  if (filteredOut.length) console.warn(`dense rows whose D1 row fails the filters: ${filteredOut.join(', ')}`);
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
