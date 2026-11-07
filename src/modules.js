// @ts-check
// Module rows: GET /module/:code, GET /facets, and the row shapes the search
// and admin routes share.
import { bad, json, upstream } from './http.js';
import { D1_TIMEOUT_MS, withTimeout } from './upstream.js';

/**
 * A full `modules` row as /module/:code returns it (see migrations/).
 * @typedef {{
 *   code: string, title: string, description: string | null, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: string | null, workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acad_year: string, text_hash: string,
 *   ng: number, ng_semesters: string | null,
 *   exam_semesters?: string | null, su?: number, grading_basis?: string | null, workload_hours?: number | null,
 *   prereq_none?: number, prereq_cohort_only?: number,
 * }} ModuleRow
 * @typedef {Pick<ModuleRow, 'code' | 'title' | 'department' | 'faculty' | 'credits' | 'level' | 'semesters' | 'ng' | 'ng_semesters'
 *   | 'exam_semesters' | 'su' | 'grading_basis' | 'workload_hours' | 'prereq_none' | 'prereq_cohort_only'>} ResultRow
 *   The columns a search result renders (rowToModule) and filters on (pin, dense rows, 3H).
 * @typedef {{ updatedAsAt: string | null, source: string | null, count: number }} NgList
 *   Provenance of data/ng-courses-*.json, written to meta('ng_list') by ingest.
 * @typedef {import('./timing.js').Trace} Trace
 */

export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

// /module/:code: every column of the row as of migrations 0001–0005, in table
// order, named so a later column (generated filter columns, row_hash) does not
// change the response shape.
const MODULE_COLUMNS =
  'code, title, description, credits, department, faculty, level, semesters, workload, prerequisite, preclusion, acad_year, text_hash, ng, ng_semesters';

// /search: only what rowToModule renders and the pin's filter check reads.
export const RESULT_COLUMNS = 'code, title, department, faculty, credits, level, semesters, ng, ng_semesters, '
  + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only';

/**
 * A read on the nearest replica, or the primary when replication is off.
 * @param {Env} env
 * @returns {D1DatabaseSession}
 */
export const readSession = (env) => env.DB.withSession('first-unconstrained');

/**
 * Runs one D1 call under the D1 timeout and the span `name`.
 * @template T
 * @param {Trace} trace
 * @param {string} name
 * @param {() => Promise<T>} fn
 */
export const d1Timed = (trace, name, fn) => trace.time(name, () => withTimeout('D1', D1_TIMEOUT_MS, fn));

/**
 * @param {ResultRow} row
 * @param {number} [score]
 */
export function rowToModule(row, score) {
  return {
    code: row.code,
    title: row.title,
    department: row.department,
    faculty: row.faculty,
    credits: row.credits,
    level: row.level,
    semesters: JSON.parse(row.semesters ?? '[]'),
    ng: row.ng === 1,
    ngSemesters: JSON.parse(row.ng_semesters ?? '[]'),
    ...(score === undefined ? {} : { score }),
  };
}

// The faculty filter is only usable if the caller knows the exact strings D1
// stores, so the page fetches them from here rather than hardcoding 26 names.
/**
 * @param {Env} env
 * @param {Trace} trace
 */
export async function handleFacets(env, trace) {
  const db = readSession(env);
  try {
    // One row, not full-table aggregates. The live computation below cost
    // 9,842 D1 rows read on EVERY page load (1,364 + 7,303 + 1,175) to produce
    // about 35 rows of output — the single largest source of row reads in the
    // app. It is now rebuilt at ingest time via POST /admin/facets. (With 0006
    // and the per-credits/semester counts the live computation reads 21,488:
    // 6,771 + 6,771 + 1,175 + 6,771 on the full corpus.)
    const cached = /** @type {{ value: string } | null} */ (await d1Timed(trace, 'd1', () =>
      db.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').first()));
    if (cached?.value) {
      return new Response(cached.value, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
      });
    }
    // No precomputed row (fresh database, or ingest never finished). Fall back
    // so the page still works, but say so rather than silently being expensive.
    console.warn('facets: no precomputed row; falling back to live aggregates (~21.5k rows read)');
    return json(await d1Timed(trace, 'd1', () => computeFacets(db)), 200);
  } catch (err) {
    return upstream('d1', err);
  }
}

/**
 * The NG list provenance ingest stored, or null before the first ingest.
 * @param {D1Database | D1DatabaseSession} db
 * @returns {Promise<NgList | null>}
 */
export async function readNgList(db) {
  const row = /** @type {{ value: string } | null} */ (
    await db.prepare('SELECT value FROM meta WHERE key = ?').bind('ng_list').first());
  return row ? JSON.parse(row.value) : null;
}

/**
 * @param {D1Database | D1DatabaseSession} db
 */
export async function computeFacets(db) {
  const faculties = await db.prepare(
    'SELECT faculty, COUNT(*) AS n FROM modules WHERE faculty IS NOT NULL GROUP BY faculty ORDER BY faculty',
  ).all();
  const levels = await db.prepare(
    'SELECT level, COUNT(*) AS n FROM modules WHERE level IS NOT NULL GROUP BY level ORDER BY level',
  ).all();
  const ng = await db.prepare('SELECT COUNT(*) AS n FROM modules WHERE ng = 1').first();
  // Per-value row counts for the remaining filters, in one scan. src/lexical.js
  // reads them (with the faculty, level and ng counts above) to pick the most
  // selective filter to drive its filter-driven plan.
  const byCredits = /** @type {D1Result<{ credits: number | null, n: number, s1: number, s2: number, s3: number, s4: number, g1: number, g2: number }>} */ (
    await db.prepare(
      `SELECT credits, COUNT(*) AS n, SUM(sem1) AS s1, SUM(sem2) AS s2, SUM(sem3) AS s3, SUM(sem4) AS s4,
              SUM(ng_sem1) AS g1, SUM(ng_sem2) AS g2
         FROM modules GROUP BY credits ORDER BY credits`,
    ).all());
  const total = (/** @type {'s1' | 's2' | 's3' | 's4' | 'g1' | 'g2'} */ k) =>
    byCredits.results.reduce((sum, r) => sum + (r[k] ?? 0), 0);
  const ngList = await readNgList(db);
  return {
    faculties: faculties.results.map((r) => ({ name: r.faculty, count: r.n })),
    levels: levels.results.map((r) => ({ level: r.level, count: r.n })),
    // updatedAsAt comes from data/ng-courses-*.json via ingest (meta.ng_list);
    // null until an ingest has recorded it.
    ng: { count: ng?.n ?? 0, updatedAsAt: ngList?.updatedAsAt ?? null },
    credits: byCredits.results.filter((r) => r.credits !== null).map((r) => ({ credits: r.credits, count: r.n })),
    semesters: [1, 2, 3, 4].map((sem) => ({ sem, count: total(/** @type {'s1'} */ (`s${sem}`)) })),
    ngSemesters: [1, 2].map((sem) => ({ sem, count: total(/** @type {'g1'} */ (`g${sem}`)) })),
  };
}

/**
 * @param {Env} env
 * @param {string} code The raw path segment after /module/.
 * @param {Trace} trace
 */
export async function handleModule(env, code, trace) {
  let decoded;
  try {
    decoded = decodeURIComponent(code);
  } catch {
    return bad('The module code in the path is not valid percent-encoding.');
  }
  const upper = decoded.toUpperCase();
  if (!MODULE_CODE_RE.test(upper)) return bad(`"${upper}" is not a module code.`);
  const db = readSession(env);
  /** @type {ModuleRow | null} */
  let row;
  try {
    row = await d1Timed(trace, 'd1', () =>
      db.prepare(`SELECT ${MODULE_COLUMNS} FROM modules WHERE code = ?`).bind(upper).first());
  } catch (err) {
    return upstream('d1', err);
  }
  if (!row) return json({ error: 'not_found', message: `No module ${upper} in this acad year.` }, 404);
  return json({
    ...row,
    semesters: JSON.parse(row.semesters ?? '[]'),
    workload: row.workload ? JSON.parse(row.workload) : null,
    ng: row.ng === 1,
    ng_semesters: JSON.parse(row.ng_semesters ?? '[]'),
  });
}
