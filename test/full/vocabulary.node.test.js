// @ts-check
// 3C over the pinned corpus: the vocabulary test/full and the SC4 suite search
// with is the one scripts/build-vocabulary.mjs builds from the pinned corpus,
// its index terms are exactly the terms SQLite's FTS5 indexes for that corpus,
// the porter port agrees with SQLite on every pinned term and typo-shaped
// variants of them, and so a prefix term's fate is decided exactly. Skipped
// without .data/; with FULL_CORPUS=1 a missing corpus fails instead.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, pinnedVocabularyPath } from '../../scripts/build-vocabulary.mjs';
import { MODULE_INFO_PATH, loadPinnedCorpus } from '../../scripts/pinned-corpus.mjs';
import { queryTokens } from '../../src/fts-query.js';
import { ftsTerm, porterStem } from '../../src/porter.js';
import { correctQuery } from '../../src/typo.js';
import { parseVocabulary, prefixMatches } from '../../src/vocabulary.js';
import { ftsIndex, sqliteTerms, typoVariants } from '../sqlite-fts.node.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);

describe.skipIf(!available)('3C vocabulary over the pinned corpus', () => {
  it('the pinned vocabulary the full project aliases is what the build script writes', { timeout: 60_000 }, async () => {
    const path = await pinnedVocabularyPath();
    expect(readFileSync(path, 'utf8')).toBe(await build('pinned'));
  });

  it('its index terms are exactly SQLite\'s FTS5 index terms for the corpus; ftsTerm is SQLite on every term', { timeout: 120_000 }, async () => {
    const { modules } = await loadPinnedCorpus();
    const v = parseVocabulary(JSON.parse(await build('pinned')));
    expect(v.documents).toBe(modules.length);
    const fts = ftsIndex(modules);
    expect(v.stems).toEqual(fts.terms());
    fts.close();
    const terms = [...new Set(modules.flatMap((m) => queryTokens(`${m.title} ${m.description ?? ''}`)))];
    expect(terms.map(ftsTerm)).toEqual(sqliteTerms(terms));
  });

  it('porterStem is SQLite on typo-shaped variants of every pinned term, and prefixMatches is FTS5 on them', { timeout: 300_000 }, async () => {
    const { modules } = await loadPinnedCorpus();
    const v = parseVocabulary(JSON.parse(await build('pinned')));
    const variants = typoVariants(v.terms, 20261107);
    expect(variants.length).toBeGreaterThan(30_000);
    expect(variants.map(porterStem)).toEqual(sqliteTerms(variants));
    const fts = ftsIndex(modules);
    const wrong = variants.filter((tok) => prefixMatches(v, tok) !== (fts.matches(`"${tok}"*`) > 0));
    fts.close();
    expect(wrong).toEqual([]);
  });
});

// 3H's pass A reads the corrected text (prereg C2-4), so a phrase 3C corrected would never match.
describe.skipIf(!available)('3H phrases survive 3C over the real corpora', () => {
  it('3C corrects no word of any 3H phrase, on the pinned and the production vocabulary', async () => {
    const phrases = JSON.parse(readFileSync(new URL('../../data/constraint-phrases.json', import.meta.url), 'utf8'));
    const texts = [...phrases.exam, ...phrases.su, ...phrases.hoursBelow.map((/** @type {string} */ p) => p.replace('N', '12')), ...phrases.prereq];
    const production = JSON.parse(readFileSync(new URL('../../data/vocabulary.json', import.meta.url), 'utf8'));
    const pinned = JSON.parse(readFileSync(await pinnedVocabularyPath(), 'utf8'));
    for (const file of [pinned, production]) {
      const v = parseVocabulary(file);
      for (const t of texts) expect(correctQuery(t, v).text, `${file.corpus}: ${t}`).toBe(t);
    }
  });
});
