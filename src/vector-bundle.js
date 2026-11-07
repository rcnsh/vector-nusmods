// @ts-check
// The vectors bundle (Phase 3, 3-0): every corpus vector, L2-normalised
// float32, with a per-row filter table, in one binary file the Worker imports
// as a `Data` module (an ArrayBuffer, read zero-copy). Shared by the Worker
// (parseBundle, exactSearch: src/dense.js) and the Node builders
// (encodeBundle: scripts/vectors.mjs, eval/runner/run.mjs), so both sides
// agree on the bytes. WebCrypto and TextEncoder only: no bindings, no Node APIs.
//
// Layout, little-endian:
//   0   8 B   magic "VNMVEC01"
//   8   4 B   u32 header length H
//   12  H B   header, UTF-8 JSON (BundleHeader below), then zero padding to a
//             multiple of 8
//   T   count × ROW_STRIDE B   filter table, one row per code, in code order
//   V   count × dims × 4 B     vectors, float32, same row order
//
// Filter row (ROW_STRIDE = 32 B; offsets within the row):
//   0  u8   semesters 1–4 as bits 0–3
//   1  u8   level, 255 = null
//   2  u8   flags: bit 0 = ng
//   3  u8   NG semesters 1–4 as bits 0–3
//   4  u16  faculty id, an index into header.faculties; 0xFFFF = null
//   6  2 B  reserved: 3B's prefix id
//   8  f64  credits, NaN = null
//   16 4 B  reserved, zero: 3F's group id (3F keeps its groups in data/groups.json)
//   20 u8   3H: exam semesters 1–4 as bits 0–3
//   21 u8   3H: S/U flags: bit 0 = attributes.su, bit 1 = graded CS/CU (C-12)
//   22 u8   3H: prerequisite flags: bit 0 = none (C-5), bit 1 = cohort-only (A2-12)
//   23 1 B  reserved, zero
//   24 f64  3H: workload hours a week, NaN = null (C-11)
// A workstream that adds a field fills its slot and bumps BUNDLE_SCHEMA, so
// an old reader refuses a new bundle.
import { INTENT } from './intents.js';
import { dataVersion, rowHash, sha256Hex } from './rowhash.js';

export const BUNDLE_MAGIC = 'VNMVEC01';
export const BUNDLE_SCHEMA = 'vnm-vectors/2';
export const ROW_STRIDE = 32;
const NULL_LEVEL = 255;
const NULL_FACULTY = 0xffff;

/**
 * What a bundle was built from.
 * - fixture: test/fixtures/corpus.json, fake embedder (npm test, wrangler dev);
 * - pinned: the 6,771-module pinned corpus, eval corpus asset (full-corpus CI, SC4);
 * - production: the corpus D1 holds (npm run deploy only);
 * - eval: built by the eval harness for one run (eval/runner/run.mjs).
 * @typedef {'fixture' | 'pinned' | 'production' | 'eval'} BundleCorpus
 * @typedef {{
 *   schema: string, corpus: BundleCorpus, model: string, embedding: string, dims: number, count: number,
 *   dataVersion: string, rowsKey: string, rowStride: number, faculties: string[], codes: string[],
 * }} BundleHeader
 * @typedef {{
 *   header: BundleHeader, codes: string[], count: number, dims: number,
 *   table: Uint8Array, view: DataView, vectors: Float32Array, facultyId: Map<string, number>,
 * }} Bundle
 * @typedef {import('./rowhash.js').RowFields} RowFields
 * @typedef {{ sem?: number, level?: number, credits?: number, faculty?: string, ng?: boolean,
 *   exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} FilterEcho
 *   `exam`, `su`, `hoursBelow` and `prereq` are 3H's (explicit params or parsed from q).
 * @typedef {[string, string]} CodeRange a primary-key range [lo, hi) over codes (src/query-intent.js codeRange)
 * @typedef {FilterEcho & { ranges?: CodeRange[], levelWindow?: { min: number, max: number | null } }} Constraints
 *   The filters plus 3B's routes: `ranges`, the codes a mask admits (a partial
 *   code, the GE pillars), and `levelWindow`, a parsed level (`XX N000`; 3D's
 *   windows later). Built from the bundle's code list, which is in code order,
 *   so a range is a contiguous block of rows: the filter table needs no prefix id.
 */

/** Code order: by UTF-16 code unit, which for NUS codes ([A-Z0-9]) is also localeCompare's order. */
const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether a grading basis is CS/CU, which 3H's `su=1` also admits (C-12).
 * @param {string | null | undefined} basis
 */
export const suGrading = (basis) => basis === 'Completed Satisfactory/Unsatisfactory';

/** @param {number[]} sems semesters (1–4) as bits 0–3 */
const semBits = (sems) => sems.reduce((bits, s) => (Number.isInteger(s) && s >= 1 && s <= 4 ? bits | (1 << (s - 1)) : bits), 0);
/** @param {number} bits */
const bitsSems = (bits) => [1, 2, 3, 4].filter((s) => bits & (1 << (s - 1)));

/**
 * The manifest's `rowsKey` (B-2): sha256 over the sorted "code<TAB>textHash"
 * lines, so the deploy guard can tell whether D1 holds exactly the texts the
 * bundle embeds.
 * @param {{ code: string, textHash: string }[]} rows
 * @returns {Promise<string>} 64 hex characters
 */
export async function rowsKey(rows) {
  return sha256Hex(rows.map((r) => `${r.code}\t${r.textHash}`).sort().join('\n'));
}

/**
 * Builds a bundle. Rows are sorted by code; each vector is L2-normalised in
 * double precision, then stored as float32. Deterministic: no timestamps, so
 * the same input gives the same bytes (and sha256).
 * @param {{
 *   corpus: BundleCorpus, embedding: string, model: string, modules: RowFields[],
 *   vectorOf: (m: RowFields) => ArrayLike<number> | undefined, dims?: number,
 * }} args
 * @returns {Promise<Uint8Array>}
 */
export async function encodeBundle({ corpus, embedding, model, modules, vectorOf, dims = 384 }) {
  const seen = new Set();
  for (const m of modules) {
    if (seen.has(m.code)) throw new Error(`vectors bundle: duplicate code ${m.code}`);
    seen.add(m.code);
    // A-N6: the manifest's rowsKey and the deploy guard need every row's text hash.
    if (typeof m.textHash !== 'string' || m.textHash === '') throw new Error(`vectors bundle: ${m.code} has no textHash`);
  }
  const rows = [...modules].sort((a, b) => byCode(a.code, b.code));
  const faculties = [...new Set(rows.map((m) => m.faculty).filter((f) => typeof f === 'string'))].sort(byCode);
  if (faculties.length >= NULL_FACULTY) throw new Error(`vectors bundle: ${faculties.length} faculties do not fit a u16 id`);
  const facultyId = new Map(faculties.map((f, i) => [f, i]));

  /** @type {BundleHeader} */
  const header = {
    schema: BUNDLE_SCHEMA, corpus, model, embedding, dims, count: rows.length,
    dataVersion: await dataVersion(await Promise.all(rows.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) })))),
    rowsKey: await rowsKey(rows),
    rowStride: ROW_STRIDE, faculties, codes: rows.map((m) => m.code),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const tableAt = align8(12 + headerBytes.length);
  const vectorsAt = tableAt + rows.length * ROW_STRIDE;
  const out = new Uint8Array(vectorsAt + rows.length * dims * 4);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(BUNDLE_MAGIC), 0);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  const vectors = new Float32Array(out.buffer, vectorsAt, rows.length * dims);

  rows.forEach((m, i) => {
    const at = tableAt + i * ROW_STRIDE;
    out[at] = semBits(m.semesters);
    out[at + 1] = Number.isInteger(m.level) && /** @type {number} */ (m.level) >= 0 && /** @type {number} */ (m.level) < NULL_LEVEL
      ? /** @type {number} */ (m.level) : NULL_LEVEL;
    out[at + 2] = m.ng === true ? 1 : 0;
    out[at + 3] = semBits(m.ngSemesters ?? []);
    view.setUint16(at + 4, typeof m.faculty === 'string' ? /** @type {number} */ (facultyId.get(m.faculty)) : NULL_FACULTY, true);
    view.setFloat64(at + 8, typeof m.credits === 'number' ? m.credits : NaN, true);
    out[at + 20] = semBits(m.examSemesters ?? []);
    out[at + 21] = (m.su === true ? 1 : 0) | (suGrading(m.gradingBasis) ? 2 : 0);
    out[at + 22] = (m.prereqNone === true ? 1 : 0) | (m.prereqCohortOnly === true ? 2 : 0);
    view.setFloat64(at + 24, typeof m.workloadHours === 'number' ? m.workloadHours : NaN, true);

    const v = vectorOf(m);
    if (!v) throw new Error(`vectors bundle: no vector for ${m.code}`);
    if (v.length !== dims) throw new Error(`vectors bundle: ${m.code} has ${v.length} dimensions, expected ${dims}`);
    let norm = 0;
    for (let k = 0; k < dims; k++) {
      const x = Number(v[k]);
      if (!Number.isFinite(x)) throw new Error(`vectors bundle: ${m.code} is not finite`);
      norm += x * x;
    }
    if (norm === 0) throw new Error(`vectors bundle: ${m.code} is a zero vector`);
    norm = Math.sqrt(norm);
    for (let k = 0; k < dims; k++) vectors[i * dims + k] = Number(v[k]) / norm;
  });
  return out;
}

/** @param {number} n */
const align8 = (n) => Math.ceil(n / 8) * 8;

/**
 * Reads a bundle without copying its vectors. Throws on anything that is not
 * a whole bundle of this schema (the Worker then serves keyword-only results
 * with `degraded.source` "dense-index").
 * @param {ArrayBuffer} buffer
 * @returns {Bundle}
 */
export function parseBundle(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12
    || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== BUNDLE_MAGIC) {
    throw new Error('vectors bundle: bad magic (not a vectors bundle)');
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > buffer.byteLength) throw new Error('vectors bundle: header runs past the end (size)');
  /** @type {BundleHeader} */
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
  } catch {
    throw new Error('vectors bundle: header is not JSON');
  }
  if (header.schema !== BUNDLE_SCHEMA) throw new Error(`vectors bundle: schema ${header.schema}, this Worker reads ${BUNDLE_SCHEMA}`);
  const { count, dims, rowStride, codes } = header;
  if (!Number.isInteger(count) || !Number.isInteger(dims) || dims <= 0 || rowStride !== ROW_STRIDE
    || !Array.isArray(codes) || codes.length !== count || !Array.isArray(header.faculties)) {
    throw new Error('vectors bundle: malformed header');
  }
  const tableAt = align8(12 + headerLength);
  const vectorsAt = tableAt + count * ROW_STRIDE;
  const expected = vectorsAt + count * dims * 4;
  if (buffer.byteLength !== expected) throw new Error(`vectors bundle: size ${buffer.byteLength} B, header implies ${expected} B`);
  for (let i = 1; i < count; i++) {
    if (!(codes[i - 1] < codes[i])) throw new Error(`vectors bundle: codes not strictly in code order at ${codes[i]}`);
  }
  return {
    header, codes, count, dims,
    table: new Uint8Array(buffer, tableAt, count * ROW_STRIDE),
    view: new DataView(buffer, tableAt, count * ROW_STRIDE),
    vectors: new Float32Array(buffer, vectorsAt, count * dims),
    facultyId: new Map(header.faculties.map((f, i) => [f, i])),
  };
}

/**
 * Row `i`'s filter fields, decoded (verify compares them with D1).
 * @param {Bundle} b
 * @param {number} i
 */
export function decodeFilterRow(b, i) {
  const at = i * ROW_STRIDE;
  const level = b.table[at + 1];
  const faculty = b.view.getUint16(at + 4, true);
  const credits = b.view.getFloat64(at + 8, true);
  return {
    semesters: bitsSems(b.table[at]),
    level: level === NULL_LEVEL ? null : level,
    credits: Number.isNaN(credits) ? null : credits,
    faculty: faculty === NULL_FACULTY ? null : b.header.faculties[faculty],
    ng: (b.table[at + 2] & 1) === 1,
    ngSemesters: bitsSems(b.table[at + 3]),
    examSemesters: bitsSems(b.table[at + 20]),
    su: (b.table[at + 21] & 1) === 1,
    suGrading: (b.table[at + 21] & 2) === 2,
    workloadHours: Number.isNaN(b.view.getFloat64(at + 24, true)) ? null : b.view.getFloat64(at + 24, true),
    prereqNone: (b.table[at + 22] & 1) === 1,
    prereqCohortOnly: (b.table[at + 22] & 2) === 2,
  };
}

/**
 * The first row whose code is >= `code` (rows are in code order).
 * @param {string[]} codes @param {string} code
 */
function lowerBound(codes, code) {
  let lo = 0, hi = codes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (codes[mid] < code) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The row blocks [from, to) that code ranges cover, in row order, merged. A
 * range with no rows gives no block.
 * @param {Bundle} b
 * @param {CodeRange[]} ranges
 * @returns {[number, number][]}
 */
export function rowBlocks(b, ranges) {
  /** @type {[number, number][]} */
  const blocks = ranges.map(([lo, hi]) => /** @type {[number, number]} */ ([lowerBound(b.codes, lo), lowerBound(b.codes, hi)]))
    .filter(([from, to]) => to > from)
    .sort((x, y) => x[0] - y[0]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const blk of blocks) {
    const last = merged.at(-1);
    if (last && blk[0] <= last[1]) last[1] = Math.max(last[1], blk[1]);
    else merged.push([blk[0], blk[1]]);
  }
  return merged;
}

/** Whether the bundle holds `code` (an offered module, for 3B's code resolution). @param {Bundle} b @param {string} code */
export function hasCode(b, code) {
  const i = lowerBound(b.codes, code);
  return i < b.count && b.codes[i] === code;
}

/**
 * The filter mask for a search's structured filters, or null when there are
 * none. The same semantics as the Vectorize metadata filter it replaces
 * (src/search.js parseFilters): every given filter must hold; null fields
 * never match.
 * A parsed level window (3B's `XX N000`) admits levels min..max; a null level
 * never matches it. Code ranges are not tested here: exactSearch walks only
 * the rows they cover (rowBlocks).
 * @param {Bundle} b
 * @param {Constraints} echo
 * @returns {((i: number) => boolean) | null}
 */
export function compileMask(b, echo) {
  /** @type {((i: number) => boolean)[]} */
  const tests = [];
  const { table, view } = b;
  if (echo.sem !== undefined) {
    const bit = 1 << (echo.sem - 1);
    tests.push((i) => (table[i * ROW_STRIDE] & bit) !== 0);
  }
  if (echo.level !== undefined) {
    const level = echo.level;
    tests.push((i) => table[i * ROW_STRIDE + 1] === level);
  }
  if (echo.levelWindow) {
    const { min } = echo.levelWindow;
    const max = echo.levelWindow.max ?? NULL_LEVEL - 1;
    tests.push((i) => { const l = table[i * ROW_STRIDE + 1]; return l !== NULL_LEVEL && l >= min && l <= max; });
  }
  if (echo.ng === true) tests.push((i) => (table[i * ROW_STRIDE + 2] & 1) === 1);
  if (echo.faculty !== undefined) {
    const id = b.facultyId.get(echo.faculty);
    if (id === undefined) return () => false;
    tests.push((i) => view.getUint16(i * ROW_STRIDE + 4, true) === id);
  }
  if (echo.credits !== undefined) {
    const credits = echo.credits;
    tests.push((i) => view.getFloat64(i * ROW_STRIDE + 8, true) === credits);
  }
  // 3H (plan 3H "Query side"): no exam in the selected semester (any offered one
  // without sem); su or CS/CU; workload under N (NULL excluded); prereq by the semantics in force.
  if (echo.exam === 0) {
    const bits = echo.sem !== undefined ? 1 << (echo.sem - 1) : 0xf;
    tests.push((i) => (table[i * ROW_STRIDE + 20] & bits) === 0);
  }
  if (echo.su === 1) tests.push((i) => (table[i * ROW_STRIDE + 21] & 3) !== 0);
  if (echo.hoursBelow !== undefined) {
    const below = echo.hoursBelow;
    tests.push((i) => view.getFloat64(i * ROW_STRIDE + 24, true) < below);
  }
  if (echo.prereq === 'none') {
    const bits = INTENT.prereq === 'i' ? 1 : 3;
    tests.push((i) => (table[i * ROW_STRIDE + 22] & bits) !== 0);
  }
  if (tests.length === 0) return null;
  return (i) => tests.every((t) => t(i));
}

/**
 * Exact cosine search: the rows the code ranges cover (all rows without
 * ranges) that the mask admits, scored by dot product with
 * the L2-normalised query (rows are stored normalised, so this is cosine, the
 * index metric), keeping the top `depth` with a bounded insertion, ordered by
 * score desc, then code asc. Rows are in code order, so a later row never
 * displaces an equal-scoring earlier one.
 * @param {Bundle} b
 * @param {ArrayLike<number>} query
 * @param {Constraints} echo
 * @param {number} depth
 * @returns {{ code: string, score: number }[]}
 */
export function exactSearch(b, query, echo, depth) {
  const { dims, count, vectors } = b;
  if (query.length !== dims) throw new Error(`query vector has ${query.length} dimensions, the bundle ${dims}`);
  const q = new Float64Array(dims);
  let norm = 0;
  for (let k = 0; k < dims; k++) { q[k] = Number(query[k]); norm += q[k] * q[k]; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < dims; k++) q[k] /= norm;

  const mask = compileMask(b, echo);
  const cap = Math.max(0, Math.min(depth, count));
  const topScore = new Float64Array(cap);
  const topRow = new Int32Array(cap);
  let n = 0;
  const blocks = echo.ranges ? rowBlocks(b, echo.ranges) : [[0, count]];
  for (const [from, to] of blocks) for (let r = from; r < to; r++) {
    if (mask && !mask(r)) continue;
    const base = r * dims;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    let k = 0;
    for (; k + 3 < dims; k += 4) {
      s0 += vectors[base + k] * q[k];
      s1 += vectors[base + k + 1] * q[k + 1];
      s2 += vectors[base + k + 2] * q[k + 2];
      s3 += vectors[base + k + 3] * q[k + 3];
    }
    for (; k < dims; k++) s0 += vectors[base + k] * q[k];
    const s = (s0 + s1) + (s2 + s3);
    if (n === cap && !(s > topScore[cap - 1])) continue;
    let j = n < cap ? n : cap - 1;
    while (j > 0 && s > topScore[j - 1]) {
      topScore[j] = topScore[j - 1];
      topRow[j] = topRow[j - 1];
      j--;
    }
    topScore[j] = s;
    topRow[j] = r;
    if (n < cap) n++;
  }
  return Array.from({ length: n }, (_, i) => ({ code: b.codes[topRow[i]], score: topScore[i] }));
}

/**
 * Little-endian float32 values as base64 (/admin/vectors bodies, /admin/verify
 * samples), decoded into a fresh, aligned array.
 * @param {string} b64
 */
export function base64ToFloat32(b64) {
  const bin = atob(b64);
  const out = new Float32Array(Math.floor(bin.length / 4));
  const bytes = new Uint8Array(out.buffer);
  if (bin.length !== bytes.length) throw new Error(`${bin.length} bytes is not a whole number of float32 values`);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return out;
}

/** @param {ArrayLike<number>} values */
export function float32ToBase64(values) {
  const f32 = values instanceof Float32Array ? values : Float32Array.from(values);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
