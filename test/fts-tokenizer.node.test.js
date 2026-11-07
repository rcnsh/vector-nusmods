// @ts-check
// B8: the query tokeniser in src/lexical.js splits exactly where the
// modules_fts tokenizer (`porter unicode61`, migrations/0006_fts_external.sql)
// splits, and ASCII queries keep their MATCH strings byte for byte, so only
// non-ASCII queries can rank differently. Runs in Node against node:sqlite's
// FTS5, the same unicode61 tables D1 uses (Unicode 6.1, frozen in FTS5).
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { probeSeparators, render } from '../scripts/gen-fts-separators.mjs';
import { STOPWORDS_IN_FORCE, ftsMatch, queryTokens } from '../src/fts-query.js';

const read = (/** @type {string} */ p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

/**
 * The tokeniser before B8 was fixed, kept verbatim as the differential
 * reference, over the stopword list in force (stopwords-v2 here), so the
 * comparison stays about tokenising.
 */
const STOPWORDS = STOPWORDS_IN_FORCE;
/** @param {string} query */
function oldFtsMatch(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tokens = all.filter((t) => !STOPWORDS.has(t));
  const used = tokens.length ? tokens : all;
  return used.length === 0 ? null : used.map((t) => `"${t}"`).join(' OR ');
}

/** FTS5 terms (after porter and diacritic folding) of each string, in order. */
function ftsTerms(/** @type {string[]} */ strings) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61');
           CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
  const insert = db.prepare('INSERT INTO t(rowid, x) VALUES (?, ?)');
  strings.forEach((s, i) => insert.run(i + 1, s));
  /** @type {string[][]} */
  const out = strings.map(() => []);
  for (const r of db.prepare('SELECT doc, term FROM v ORDER BY doc, offset').all()) out[Number(r.doc) - 1].push(String(r.term));
  db.close();
  return out;
}

/** Deterministic PRNG (mulberry32). */
function rng(/** @type {number} */ seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('B8 tokeniser', () => {
  // The full probe (every code point through SQLite) takes ~5.2 s on a GitHub
  // runner, past vitest's 5 s default; it is kept whole, not sampled.
  it('[B8 fixed] the separator table equals the unicode61 separators probed from SQLite, for every code point', () => {
    expect(read('src/fts-separators.js')).toBe(render(probeSeparators()));
  }, 60_000);

  // "At most": a token of nothing but strippable diacritics folds to no term at
  // all, in the index as in the query; FTS5 treats that empty phrase as
  // matching nothing, without an error (checked below).
  it('[B8 fixed] every query token is at most one FTS5 term, and together they are the FTS5 terms of the query', () => {
    const random = rng(8);
    // Mixed strings: ASCII, Latin diacritics (precomposed and decomposed),
    // marks unicode61 splits on, CJK, symbols, emoji old and new, private use.
    const alphabet = [...'aZ09 -_.,\'"’éÅßıİǅﬁ½²①ⅫΩж机学̈́ःְ⃝­​😀🥰𝐀'];
    const strings = ['naïve bayes', 'naïve bayes', 'Ångström café', 'São Paulo', 'İstanbul', '机器学习 data',
      'x² ½', "l'été", 'co-op', 'ａｂｃ', 'हिन्दी', 'עִברִית'];
    for (let i = 0; i < 400; i++) {
      strings.push(Array.from({ length: 1 + Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''));
    }
    const tokensPer = strings.map((s) => queryTokens(s));
    const whole = ftsTerms(strings);
    const each = ftsTerms(tokensPer.flat());
    let k = 0;
    strings.forEach((s, i) => {
      const parts = tokensPer[i].map(() => each[k++]);
      for (const p of parts) expect(p.length, `${JSON.stringify(s)}: ${JSON.stringify(tokensPer[i])}`).toBeLessThanOrEqual(1);
      expect(parts.flat(), JSON.stringify(s)).toEqual(whole[i]);
    });

    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61'); INSERT INTO t VALUES ('data base');");
    const n = (/** @type {string} */ m) => db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get(m)?.n;
    expect(n(/** @type {string} */ (ftsMatch('́ data')))).toBe(1);
    expect(n(/** @type {string} */ (ftsMatch('́')))).toBe(0);
  });

  it('[B8 fixed] "naïve" is one token, precomposed or decomposed', () => {
    expect(ftsMatch('naïve bayes')).toBe('"naïve" OR "bayes"');
    expect(ftsMatch('naïve bayes')).toBe('"naïve" OR "bayes"');
    expect(ftsTerms(['naïve', 'naïve', 'naive'])).toEqual([['naiv'], ['naiv'], ['naiv']]);
  });

  it('[B8 fixed] stopwords are recognised through diacritics and case, as FTS5 folds them', () => {
    expect(ftsMatch('Ánd the café')).toBe('"café"');
    expect(ftsMatch('ÁND THE')).toBe('"ánd" OR "the"');
  });

  it('[B8 fixed] ASCII queries keep byte-identical MATCH strings (differential over every query fixture)', () => {
    const lexical = /** @type {{ queries: string[] }} */ (JSON.parse(read('test/fixtures/lexical-queries.json'))).queries;
    const dev = /** @type {{ queries: { text: string }[] }} */ (JSON.parse(read('eval/dev/queries.json'))).queries.map((q) => q.text);
    const queries = [...new Set([...lexical, ...dev])];
    // Every printable ASCII character alone and in context, too.
    for (let c = 0; c < 128; c++) queries.push(String.fromCharCode(c), `data${String.fromCharCode(c)}Base 2`);
    const ascii = queries.filter((q) => [...q].every((ch) => ch.charCodeAt(0) < 128));
    expect(ascii.length).toBeGreaterThan(500);
    for (const q of ascii) expect(ftsMatch(q), JSON.stringify(q)).toBe(oldFtsMatch(q));
    // The non-ASCII fixture queries: which MATCH strings change.
    const changed = queries.filter((q) => !ascii.includes(q)).filter((q) => ftsMatch(q) !== oldFtsMatch(q));
    expect(changed).toEqual([]);
  });
});
