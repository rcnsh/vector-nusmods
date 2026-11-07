// @ts-check
// Reciprocal-rank fusion (docs/plans/phase3.md 3E, docs/plans/phase3-prereg.md §6,
// eval/prereg/grids.json `3E`). Each list contributes w/(k + rank) to a document's
// score, rank from 1: w_v for the dense list, w_l for the lexical one, w_c for 3B's
// code list. Rank-based, so the vector engine's cosine scores and FTS5's bm25
// values never have to be made commensurable.
//
// RRF produces exact ties often (two documents at the same rank in one list each).
// - `hash` (the shipped fusion): a stable hash of the code, arbitrary but unbiased.
//   Breaking ties alphabetically would favour early-alphabet codes, which correlates
//   with whatever a corpus happens to contain.
// - `rank` (3E): the best single-list rank, then the dense rank, then the code, for
//   scores equal in exact arithmetic (float rounding can split an exact tie).
//
// Each grid point is a variant; the selected one is FUSION_VARIANT. `legacy` is the
// shipped fusion, k = 60 from the original Cormack et al. RRF paper.

/**
 * @typedef {{ wv: number, wl: number, wc: number, k: number, tiebreak: 'hash' | 'rank' }} FusionConfig
 * @typedef {{ kind: 'vector' | 'lexical' | 'code', codes: string[] }} RankedList
 */

/** @param {number} wv @param {number} k @returns {FusionConfig} */
const point = (wv, k) => Object.freeze({ wv, wl: 1, wc: 1, k, tiebreak: /** @type {const} */ ('rank') });

export const FUSION_VARIANTS = Object.freeze({
  legacy: Object.freeze({ wv: 1, wl: 1, wc: 1, k: 60, tiebreak: /** @type {const} */ ('hash') }),
  v100k20: point(1, 20),
  v100k60: point(1, 60),
  v125k20: point(1.25, 20),
  v125k60: point(1.25, 60),
  v150k20: point(1.5, 20),
  v150k60: point(1.5, 60),
  v200k20: point(2, 20),
  v200k60: point(2, 60),
});
/** @typedef {keyof typeof FUSION_VARIANTS} FusionVariant */

/** The shipped fusion until the dev screen selects a grid point. @type {FusionVariant} */
export const FUSION_VARIANT = 'legacy';

/** @type {FusionConfig} */
export const FUSION = FUSION_VARIANTS[FUSION_VARIANT];

/**
 * Float scores further apart than this are ordered by their floats: a sum of at most three
 * terms w/(k + r) carries a rounding error near 1e-16. Closer ones are compared exactly.
 */
const CLOSE = 1e-12;

/**
 * Compares two scores given as exact terms [a, d], each a/d (w = a/4, d = 4(k + r)): the sign
 * of x − y, by BigInt cross-multiplication.
 * @param {[number, number][]} x @param {[number, number][]} y
 */
function exactCompare(x, y) {
  /** @param {[number, number][]} t @returns {[bigint, bigint]} */
  const sum = (t) => t.reduce(([n, d], [a, b]) => [n * BigInt(b) + BigInt(a) * d, d * BigInt(b)], [0n, 1n]);
  const [xn, xd] = sum(x), [yn, yd] = sum(y);
  const l = xn * yd, r = yn * xd;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** @param {string} code */
function hash(code) {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
  return h;
}

/**
 * The fused order, best first.
 * @param {RankedList[]} lists
 * @param {FusionConfig} config
 * @returns {{ code: string, score: number }[]}
 */
export function fuse(lists, { wv, wl, wc, k, tiebreak }) {
  const weight = { vector: wv, lexical: wl, code: wc };
  /** @type {Map<string, { score: number, best: number, dense: number, terms: [number, number][] }>} */
  const docs = new Map();
  for (const { kind, codes } of lists) {
    const w = weight[kind];
    if (tiebreak === 'rank' && !Number.isInteger(w * 4)) throw new Error(`fusion weight ${w} is not a multiple of 1/4`);
    codes.forEach((code, i) => {
      const d = docs.get(code) ?? { score: 0, best: Infinity, dense: Infinity, terms: [] };
      d.score += w / (k + i + 1);
      d.terms.push([w * 4, 4 * (k + i + 1)]);
      d.best = Math.min(d.best, i);
      if (kind === 'vector') d.dense = Math.min(d.dense, i);
      docs.set(code, d);
    });
  }
  const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  const entries = [...docs.entries()];
  if (tiebreak === 'hash') {
    entries.sort((a, b) => b[1].score - a[1].score || hash(a[0]) - hash(b[0]) || a[0].localeCompare(b[0]));
  } else {
    // Scores equal in exact arithmetic can differ in the last bit, depending on the order the
    // terms were added (1.25/21 + 1/42 and 1.25/24 + 1/32 are both 1/12), and distinct scores can
    // be 3e-12 apart (three lists), so close scores are compared exactly.
    /** @param {{ score: number, terms: [number, number][] }} a @param {{ score: number, terms: [number, number][] }} b */
    const byScore = (a, b) => (Math.abs(a.score - b.score) > CLOSE ? b.score - a.score : exactCompare(b.terms, a.terms));
    entries.sort((a, b) => byScore(a[1], b[1]) || a[1].best - b[1].best || a[1].dense - b[1].dense || byCode(a[0], b[0]));
  }
  return entries.map(([code, d]) => ({ code, score: d.score }));
}
