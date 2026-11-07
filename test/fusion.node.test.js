// @ts-check
// src/fusion.js, 3E's weighted RRF (docs/plans/phase3.md 3E, docs/plans/phase3-prereg.md §6,
// eval/prereg/grids.json `3E`): w_v/(k + r_v) + w_l/(k + r_l) + w_c/(k + r_c), w_l = w_c = 1,
// ties by best single-list rank, then dense rank, then code. `legacy` is the shipped fusion.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';
import { FUSION, FUSION_VARIANT, FUSION_VARIANTS, fuse } from '../src/fusion.js';

const grids = JSON.parse(readFileSync(join(REPO, 'eval/prereg/grids.json'), 'utf8'))['3E'];

/** The shipped fuse (src/search.js before 3E), verbatim, as the oracle for `legacy`. @param {string[][]} lists */
function shippedFuse(lists) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const list of lists) list.forEach((code, i) => scores.set(code, (scores.get(code) ?? 0) + 1 / (60 + i + 1)));
  const tiebreak = (/** @type {string} */ code) => {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
    return h;
  };
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || tiebreak(a[0]) - tiebreak(b[0]) || a[0].localeCompare(b[0]))
    .map(([code, score]) => ({ code, score }));
}

/** A deterministic pseudo-random list of codes. @param {number} seed @param {number} n */
function randomList(seed, n) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pool = Array.from({ length: 40 }, (_, i) => `AB${1000 + i * 37}`);
  const out = new Set();
  while (out.size < n) out.add(pool[Math.floor(rnd() * pool.length)]);
  return [...out];
}

describe('the variants', () => {
  it('are the pre-registered grid, in grid order, with w_l = w_c = 1 and the new tiebreak', () => {
    const grid = Object.values(FUSION_VARIANTS).filter((v) => v.tiebreak === 'rank');
    expect(grid.map((v) => [v.wv, v.k])).toEqual(grids.gridOrder);
    for (const v of grid) expect([v.wl, v.wc]).toEqual([grids.wl, grids.wc]);
  });

  it('legacy is the shipped fusion: k 60, unit weights, the hash tiebreak; the selected variant is one of them', () => {
    expect(FUSION_VARIANTS.legacy).toEqual({ wv: 1, wl: 1, wc: 1, k: 60, tiebreak: 'hash' });
    expect(FUSION_VARIANTS[FUSION_VARIANT]).toBe(FUSION);
  });
});

describe('fuse', () => {
  it('legacy reproduces the shipped fuse exactly, scores and order', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const v = randomList(seed, 15), l = randomList(seed + 1000, 12), c = randomList(seed + 2000, 5);
      const lists = [{ kind: /** @type {const} */ ('vector'), codes: v }, { kind: /** @type {const} */ ('lexical'), codes: l }];
      expect(fuse(lists, FUSION_VARIANTS.legacy)).toEqual(shippedFuse([v, l]));
      expect(fuse([...lists, { kind: 'code', codes: c }], FUSION_VARIANTS.legacy)).toEqual(shippedFuse([v, l, c]));
    }
  });

  it('weights each list: w_v/(k + r_v) + w_l/(k + r_l) + w_c/(k + r_c), ranks from 1', () => {
    const cfg = FUSION_VARIANTS.v200k20;
    const out = fuse([{ kind: 'vector', codes: ['A1000', 'B1000'] }, { kind: 'lexical', codes: ['B1000'] }, { kind: 'code', codes: ['C1000'] }], cfg);
    const score = Object.fromEntries(out.map((f) => [f.code, f.score]));
    expect(score.A1000).toBeCloseTo(2 / 21, 15);
    expect(score.B1000).toBeCloseTo(2 / 22 + 1 / 21, 15);
    expect(score.C1000).toBeCloseTo(1 / 21, 15);
    expect(out.map((f) => f.code)).toEqual(['B1000', 'A1000', 'C1000']);
  });

  it('breaks ties by best single-list rank, then dense rank, then code', () => {
    const cfg = FUSION_VARIANTS.v100k60;
    // Equal scores, equal best rank (1): the one the dense list holds first.
    expect(fuse([{ kind: 'vector', codes: ['B1000'] }, { kind: 'lexical', codes: ['A1000'] }], cfg).map((f) => f.code)).toEqual(['B1000', 'A1000']);
    // Equal scores, equal best rank, neither dense: by code.
    expect(fuse([{ kind: 'lexical', codes: ['X1', 'Z2000'] }, { kind: 'code', codes: ['X2', 'Y2000'] }], cfg).map((f) => f.code)).toEqual(['X1', 'X2', 'Y2000', 'Z2000']);
    // Rank 2 in one list each: the dense one first, as at rank 1.
    const t = fuse([{ kind: 'vector', codes: ['V1', 'P1000'] }, { kind: 'lexical', codes: ['L1', 'Q1000'] }], cfg).map((f) => f.code);
    expect(t).toEqual(['V1', 'L1', 'P1000', 'Q1000']);
  });

  it('review fix: scores equal in exact arithmetic tie even when float rounding splits them', () => {
    /** @param {string} tag @param {number} n @param {Record<number, string>} place */
    const list = (tag, n, place) => Array.from({ length: n }, (_, i) => place[i + 1] ?? `${tag}F${i + 1}`);
    /** @type {[keyof typeof FUSION_VARIANTS, import('../src/fusion.js').RankedList[], string[]][]} */
    const cases = [
      ['v100k60', [{ kind: 'vector', codes: list('V', 8, { 1: 'P1000', 7: 'Q1000' }) }, { kind: 'lexical', codes: list('L', 8, { 2: 'Q1000', 7: 'P1000' }) },
        { kind: 'code', codes: list('C', 8, { 1: 'Q1000', 2: 'P1000' }) }], ['P1000', 'Q1000']],
      ['v125k20', [{ kind: 'vector', codes: list('V', 22, { 1: 'P1000', 4: 'Q1000' }) }, { kind: 'lexical', codes: list('L', 22, { 22: 'P1000', 12: 'Q1000' }) }], ['P1000', 'Q1000']],
      ['v150k60', [{ kind: 'vector', codes: list('V', 30, { 10: 'P1000', 30: 'Q1000' }) }, { kind: 'lexical', codes: list('L', 30, { 30: 'P1000', 3: 'Q1000' }) }], ['Q1000', 'P1000']],
      ['v200k60', [{ kind: 'vector', codes: list('V', 57, { 3: 'P1000', 5: 'Q1000' }) }, { kind: 'lexical', codes: list('L', 57, { 57: 'P1000', 45: 'Q1000' }) }], ['P1000', 'Q1000']],
    ];
    for (const [v, lists, want] of cases) {
      expect(fuse(lists, FUSION_VARIANTS[v]).map((f) => f.code).filter((c) => want.includes(c)), v).toEqual(want);
    }
  });

  it('review fix: distinct scores 1.6e-11 apart keep their exact order, whatever the tiebreak says', () => {
    // Found by exact search over ranks ≤ 60 at w_v 2, k 60: P (v49, l13, c37) scores 1.58e-11 below
    // Q (v24, l40, c57) though P has the better single-list rank. A rounded comparison would tie them
    // and put P first.
    /** @param {string} tag @param {Record<number, string>} place */
    const list = (tag, place) => Array.from({ length: 60 }, (_, i) => place[i + 1] ?? `${tag}F${i + 1}`);
    const out = fuse([
      { kind: 'vector', codes: list('V', { 49: 'P1000', 24: 'Q1000' }) },
      { kind: 'lexical', codes: list('L', { 13: 'P1000', 40: 'Q1000' }) },
      { kind: 'code', codes: list('C', { 37: 'P1000', 57: 'Q1000' }) },
    ], FUSION_VARIANTS.v200k60).map((f) => f.code).filter((c) => c === 'P1000' || c === 'Q1000');
    expect(out).toEqual(['Q1000', 'P1000']);
  });

  it('a single list keeps its order under every variant', () => {
    const l = randomList(7, 20);
    for (const cfg of Object.values(FUSION_VARIANTS)) {
      expect(fuse([{ kind: 'lexical', codes: l }], cfg).map((f) => f.code)).toEqual(l);
    }
  });
});
