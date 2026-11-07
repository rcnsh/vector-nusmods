// @ts-check
// Lexical half of the hybrid retriever: the BM25-ranked lookup with filters.
// Takes a D1 database or session so callers choose primary vs replica. Query
// tokenising and the MATCH expression live in fts-query.js (no Worker types,
// so Node tests can import it).
import { ftsMatch } from './fts-query.js';
import { INTENT } from './intents.js';

export { ftsMatch, queryTokens } from './fts-query.js';

/**
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {import('./vector-bundle.js').Constraints} FilterEcho The filters, and 3B's code ranges
 *   and level window (written as SQL predicates; never an index driver).
 */

// Lexical half of the hybrid retriever. Filters are applied in SQL so the two
// halves see the same candidate universe (R4 holds on both paths).
/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} query
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 * @param {import('./fts-query.js').FtsTerms} [terms] the prefix terms and corrections of the typo step (src/typo.js)
 */
export async function lexicalSearch(db, query, echo, limit, trace, terms) {
  const match = ftsMatch(query, terms);
  if (!match) return [];
  return runFts(db, match, echo, limit, trace);
}

// Filtered lexical search keeps at most this many FTS hits before joining
// `modules` for the filters (docs/plans/phase1.md r2): the join costs one row
// read per hit, so the cap bounds a filtered search at about 2 x FTS_CAP rows.
export const FTS_CAP = 2000;

/**
 * @typedef {'sem' | 'level' | 'credits' | 'faculty' | 'ng'} FilterKey
 * @typedef {{
 *   sem: Map<number, number>, level: Map<number, number>, credits: Map<number, number>,
 *   faculty: Map<string, number>, ng: number,
 * }} FilterCounts
 *   Rows per filter value, from the precomputed meta('facets') row.
 */

/**
 * Whether a filter has an index the filter-driven plan can walk: faculty
 * (0001), ng (0003), level, credits and partial sem3/sem4 (0006). sem1/sem2
 * have none.
 * @param {FilterKey} key
 * @param {FilterEcho} echo
 */
const indexed = (key, echo) => key !== 'sem' || echo.sem === 3 || echo.sem === 4;

/**
 * Driver order when the facets row has no counts: the indexed filters by their
 * largest per-value row count on the pinned corpus
 * (docs/evidence/phase1/lexical-cost.md). Also breaks ties between equal counts.
 * @type {FilterKey[]}
 */
export const FIXED_DRIVER_ORDER = ['sem', 'faculty', 'ng', 'level', 'credits'];

/**
 * The active filters that have an index, in FIXED_DRIVER_ORDER.
 * @param {FilterEcho} echo
 */
const indexedFilters = (echo) => FIXED_DRIVER_ORDER.filter((k) =>
  (k === 'ng' ? echo.ng === true : echo[k] !== undefined) && indexed(k, echo));

/**
 * The filter whose index drives the filter-driven plan: the indexed active
 * filter with the fewest rows, or, without counts, the first active one in
 * FIXED_DRIVER_ORDER. Undefined when no active filter is indexed. A value the
 * counts do not list matches no row, so it is the cheapest driver.
 * @param {FilterEcho} echo
 * @param {FilterCounts | null} counts
 * @returns {FilterKey | undefined}
 */
export function chooseDriver(echo, counts) {
  const active = indexedFilters(echo);
  if (!counts) return active[0];
  /** @param {FilterKey} k */
  const rows = (k) => {
    if (k === 'ng') return counts.ng;
    if (k === 'faculty') return counts.faculty.get(/** @type {string} */ (echo.faculty)) ?? 0;
    return counts[k].get(/** @type {number} */ (echo[k])) ?? 0;
  };
  let best;
  for (const k of active) if (best === undefined || rows(k) < rows(best)) best = k;
  return best;
}

/**
 * SQL predicates over `modules m` for the active filters. Semester and NG use
 * the generated columns from migrations/0006_fts_external.sql. 3B's code
 * ranges become `m.code >= ? AND m.code < ?` (OR-ed), the primary-key range
 * scan the plan names, and a level window `m.level BETWEEN`; neither drives
 * the filter-driven plan. With `driver`,
 * every other predicate is written `+m.col`: unary plus makes it unusable as
 * an index constraint, so the planner can only walk the driver's index.
 * (Without sqlite_stat1 it picks among equality indexes by creation order,
 * not by selectivity: credits=4 (5,081 rows) over faculty=Computing (315).)
 * @param {FilterEcho} echo
 * @param {FilterKey} [driver]
 * @returns {{ clauses: string[], binds: (string | number)[] }}
 */
export function filterSql(echo, driver) {
  /** @type {string[]} */
  const clauses = [];
  /** @type {(string | number)[]} */
  const binds = [];
  const col = (/** @type {FilterKey} */ key, /** @type {string} */ name) =>
    `${driver !== undefined && key !== driver ? '+' : ''}m.${name}`;
  if (echo.sem !== undefined) {
    // Interpolated into a column name, so it must be one of the four columns.
    if (![1, 2, 3, 4].includes(echo.sem)) throw new RangeError(`sem must be 1-4, got ${echo.sem}`);
    clauses.push(`${col('sem', `sem${echo.sem}`)} = 1`);
  }
  if (echo.level !== undefined) { clauses.push(`${col('level', 'level')} = ?`); binds.push(echo.level); }
  if (echo.credits !== undefined) { clauses.push(`${col('credits', 'credits')} = ?`); binds.push(echo.credits); }
  if (echo.faculty !== undefined) { clauses.push(`${col('faculty', 'faculty')} = ?`); binds.push(echo.faculty); }
  if (echo.ng === true) clauses.push(`${col('ng', 'ng')} = 1`);
  const plus = driver !== undefined ? '+' : '';
  // 3H (plan 3H "Query side"): never an index driver.
  if (echo.exam === 0) {
    if (echo.sem !== undefined) clauses.push(`${plus}m.exam_sem${echo.sem} = 0`);
    else clauses.push(`${plus}m.exam_semesters = '[]'`);
  }
  if (echo.su === 1) clauses.push(`(${plus}m.su = 1 OR ${plus}m.grading_basis = 'Completed Satisfactory/Unsatisfactory')`);
  if (echo.hoursBelow !== undefined) { clauses.push(`${plus}m.workload_hours < ?`); binds.push(echo.hoursBelow); }
  if (echo.prereq === 'none') {
    clauses.push(INTENT.prereq === 'i' ? `${plus}m.prereq_none = 1` : `(${plus}m.prereq_none = 1 OR ${plus}m.prereq_cohort_only = 1)`);
  }
  if (echo.levelWindow) {
    clauses.push(`${plus}m.level >= ?`);
    binds.push(echo.levelWindow.min);
    if (echo.levelWindow.max !== null) { clauses.push(`${plus}m.level <= ?`); binds.push(echo.levelWindow.max); }
  }
  if (echo.ranges) {
    if (echo.ranges.length === 0) clauses.push('0');
    else {
      clauses.push(`(${echo.ranges.map(() => `(${plus}m.code >= ? AND ${plus}m.code < ?)`).join(' OR ')})`);
      for (const [lo, hi] of echo.ranges) binds.push(lo, hi);
    }
  }
  return { clauses, binds };
}

/**
 * The facets row as FilterCounts, or null when it lacks any of the counts
 * (a row written before they were added).
 * @param {any} facets
 * @returns {FilterCounts | null}
 */
export function parseFilterCounts(facets) {
  const list = (/** @type {unknown} */ xs, /** @type {string} */ key) => Array.isArray(xs) ? new Map(xs.map((x) => [x[key], x.count])) : null;
  const sem = list(facets?.semesters, 'sem');
  const level = list(facets?.levels, 'level');
  const credits = list(facets?.credits, 'credits');
  const faculty = list(facets?.faculties, 'name');
  const ng = facets?.ng?.count;
  if (!sem || !level || !credits || !faculty || typeof ng !== 'number') return null;
  return { sem, level, credits, faculty, ng };
}

// Loaded once per isolate, on the first search that reaches the
// filter-driven plan; the common path never reads it. Stale counts (an ingest
// since) only cost a worse plan choice, never a wrong answer. Neither a failed
// read nor a row without counts (written before they existed) is cached, so
// the next fallback re-reads the row and picks up a facets rebuild.
/** @type {Promise<FilterCounts | null> | null} */
let filterCounts = null;

/** Forgets the cached counts (tests; the next fallback reloads them). */
export function resetFilterCounts() { filterCounts = null; }

/**
 * The per-filter row counts from the facets row, cached per isolate once found.
 * @param {D1Database | D1DatabaseSession} db
 * @param {Trace} trace
 * @returns {Promise<FilterCounts | null>}
 */
export function loadFilterCounts(db, trace) {
  filterCounts ??= trace.time('fts', () => db.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').all())
    .then((res) => {
      trace.d1Result(res);
      const value = /** @type {{ value?: string } | undefined} */ (res.results[0])?.value;
      const counts = value ? parseFilterCounts(JSON.parse(value)) : null;
      if (!counts) filterCounts = null;
      return counts;
    })
    .catch(() => {
      filterCounts = null;
      return null;
    });
  return filterCounts;
}

/**
 * The filter-driven statement (see runFts). Exported so tests can EXPLAIN the
 * exact text the Worker runs. Binds: (match, ...binds, limit).
 * @param {FilterEcho} echo
 * @param {FilterKey} [driver]
 */
export function exactStatement(echo, driver) {
  const { clauses, binds } = filterSql(echo, driver);
  const sql = `WITH capped AS (
       SELECT count(*) AS n FROM (SELECT 1 FROM modules_fts WHERE modules_fts MATCH ?1 LIMIT ${FTS_CAP + 1}))
     SELECT m.code AS code
       FROM capped CROSS JOIN modules AS m CROSS JOIN modules_fts ON modules_fts.rowid = m.rowid
      WHERE capped.n > ${FTS_CAP} AND modules_fts MATCH ?1 AND ${clauses.join(' AND ')}
      ORDER BY modules_fts.rank, m.rowid LIMIT ?`;
  return { sql, binds };
}

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} match
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 */
async function runFts(db, match, echo, limit, trace) {
  const { clauses, binds } = filterSql(echo);

  if (clauses.length === 0) {
    // ORDER BY rank, NOT ORDER BY bm25(...). They produce the same ordering — the
    // table's persistent rank config is bm25(0.0, 3.0, 1.0), set in
    // migrations/0005_rank.sql and again in 0006 — but calling bm25() as a
    // function forces FTS5 to materialise and score every matching row, while
    // `rank` uses its internal top-N path. Measured on "machine AND learning"
    // (224 matching documents): bm25() cost 389 D1 rows read, rank cost 7.
    //
    // Unchanged from before 0006 (LIMIT and slice included) so unfiltered
    // rankings stay identical.
    const res = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
      `SELECT modules_fts.code AS code FROM modules_fts
        WHERE modules_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).bind(match, limit * 4).all()));
    trace.d1Result(res);
    return res.results.slice(0, limit).map((r) => r.code);
  }

  // Filters run in SQL against the generated columns, after a bounded FTS
  // top-N (FINDINGS B1: they used to run in JS after the LIMIT, dropping
  // matches). FTS5 returns rank ties in rowid order, so (rank, rowid) is the
  // total order every path here agrees on. The outer LIMIT stops the scan as
  // soon as `limit` hits survive, which is the common case. CROSS JOIN keeps
  // `hits` the outer loop: given a plain JOIN and the filter indexes, SQLite
  // drives from modules and builds an index on hits instead, losing the early
  // stop (level=5 on "buildings and urban design": 7,455 rows read vs 211).
  const where = clauses.join(' AND ');
  const bounded = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `WITH hits AS (
       SELECT rowid, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank LIMIT ${FTS_CAP})
     SELECT m.code AS code FROM hits CROSS JOIN modules m ON m.rowid = hits.rowid
      WHERE ${where} ORDER BY hits.rank, hits.rowid LIMIT ?`,
  ).bind(match, ...binds, limit).all()));
  trace.d1Result(bounded);
  if (bounded.results.length >= limit) return bounded.results.map((r) => r.code);

  // Fewer than `limit` survived. That is the exact answer unless the query
  // matched more than FTS_CAP documents, in which case a filtered match ranked
  // below the cap was never looked at. Then run the filter-driven plan: walk
  // the (indexed) filtered rows and ask FTS5 about each by rowid, so the cost
  // follows the size of the filtered set, not of the match set; never an
  // unbounded match-driven scan.
  //
  // `capped` counts at most FTS_CAP + 1 matches (no ranking, so no scoring).
  // CROSS JOIN fixes the loop order with it outermost: when the query did not
  // overflow the cap its one row fails `n > FTS_CAP` and the join never runs.
  // (As a scalar subquery in WHERE the guard is not hoisted: SQLite still
  // walks every modules row, measured 6,831 rows read for nothing.)
  // The walk goes through the index of the most selective filter (chooseDriver):
  // the other filters are written `+m.col`, so they cannot drive it.
  // `?1` is the MATCH expression in both places; each later bare `?` takes
  // the next number, so the binds are (match, ...filter binds, limit).
  // Counts only matter when there is a choice: two or more indexed filters.
  const driver = chooseDriver(echo, indexedFilters(echo).length > 1 ? await loadFilterCounts(db, trace) : null);
  const stmt = exactStatement(echo, driver);
  const exact = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(stmt.sql)
    .bind(match, ...stmt.binds, limit).all()));
  trace.d1Result(exact);
  // An empty exact result means either the guard was false (the bounded
  // answer is complete) or nothing matches the filters at all (and then the
  // bounded answer is empty too).
  return (exact.results.length ? exact.results : bounded.results).map((r) => r.code);
}

/**
 * The members of 3B's code ranges that pass the filters, in code order, at
 * most `limit`: a primary-key range scan, reading about the rows it returns.
 * A whole-query mask's results, and the third RRF list, wherever the exact
 * dense order is unavailable (mode=lexical, the keyword-only fallback, the
 * Vectorize standby).
 * @param {D1Database | D1DatabaseSession} db
 * @param {FilterEcho & { ranges: import('./vector-bundle.js').CodeRange[] }} constraints
 * @param {number} limit
 * @param {Trace} trace
 * @returns {Promise<string[]>}
 */
export async function rangeMembers(db, constraints, limit, trace) {
  const { clauses, binds } = filterSql(constraints);
  const res = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `SELECT m.code AS code FROM modules m WHERE ${clauses.join(' AND ')} ORDER BY m.code LIMIT ?`,
  ).bind(...binds, limit).all()));
  trace.d1Result(res);
  return res.results.map((r) => r.code);
}
