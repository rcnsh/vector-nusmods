// @ts-check
// 3C in the eval harness (eval/lib/corrected.mjs): a run builds the ranker's
// vocabulary from the run's own corpus with the ranker's own builder and
// writes it where the ranker reads it, so no run reads a production
// vocabulary; a 3C-2 ranker's corrected query texts must have embeddings
// before a run starts, and the refusal names the command that adds them; and
// `eval:embed --corrected-from-ref` collects exactly the corrected texts the
// ref produces.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCorrectedEmbedded, correctedTexts, rankerCorrector, sc4Texts, writeRankerVocabulary,
} from '../../eval/lib/corrected.mjs';
import { MODEL, embeddingKey } from '../../eval/lib/embeddings.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { buildWorkspace } from '../../eval/lib/workspace.mjs';

const fixture = JSON.parse(readFileSync(join(REPO, 'test/fixtures/corpus.json'), 'utf8'));
/** @type {{ root: string }} */
let ws;
beforeAll(async () => {
  ws = await buildWorkspace({ name: 'test-corrected' });
}, 60_000);
afterAll(async () => {
  await rm(ws.root, { recursive: true, force: true });
});

describe('rankerCorrector', () => {
  it('is null for a ranker without 3C (no src/typo.js)', async () => {
    const dir = await mkdtemp(join(REPO, '.eval-work', 'no-3c-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    expect(await rankerCorrector(dir, fixture.modules, 'x')).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the vocabulary from the run corpus with the ranker\'s builder, and corrects as the ranker does', async () => {
    const c = /** @type {NonNullable<Awaited<ReturnType<typeof rankerCorrector>>>} */ (await rankerCorrector(ws.root, fixture.modules, 'label'));
    expect(c).not.toBeNull();
    expect(c.file.corpus).toBe('eval');
    expect(c.file.documents).toBe(fixture.modules.length);
    // A query with nothing to correct has no corrected text; canonical form first.
    expect(c.corrected('  Machine   Learning ')).toBeNull();
  });

  it('writes the run vocabulary over data/vocabulary.json in the workspace, never the production one', async () => {
    const c = /** @type {NonNullable<Awaited<ReturnType<typeof rankerCorrector>>>} */ (await rankerCorrector(ws.root, fixture.modules, 'label'));
    const production = await readFile(join(REPO, 'data/vocabulary.json'), 'utf8');
    expect(await readFile(join(ws.root, 'data/vocabulary.json'), 'utf8')).toBe(production);
    const info = await writeRankerVocabulary(ws.root, c);
    const written = JSON.parse(await readFile(join(ws.root, 'data/vocabulary.json'), 'utf8'));
    expect(written.corpus).toBe('eval');
    expect(written.documents).toBe(fixture.modules.length);
    expect(info).toMatchObject({ corpus: 'eval', terms: written.count });
    expect(JSON.parse(production).corpus).toBe('production');
  });
});

describe('the corrected texts a ranker embeds', () => {
  /** A corrector double: corrects `machne` to `machine`. */
  const corrector = (/** @type {boolean} */ embedsCorrected) => ({
    embedsCorrected,
    corrected: (/** @type {string} */ t) => (t.toLowerCase().includes('machne') ? t.toLowerCase().replace('machne', 'machine') : null),
  });
  const queries = [{ id: 'q1', text: 'Machne learning' }, { id: 'q2', text: 'databases' }, { id: 'q3', text: 'machne vision' }];

  it('are the distinct corrected forms of the texts', () => {
    expect(correctedTexts(corrector(true), ['Machne learning', 'databases', 'machne learning'])).toEqual(['machine learning']);
  });

  it('a 3C-2 run is refused when one lacks an embedding, naming the command to run', () => {
    const have = new Set([embeddingKey(MODEL, 'machine learning')]);
    expect(() => assertCorrectedEmbedded({ set: 'dev', setDirArg: '', ref: '3c2', queries, corrector: corrector(true), have }))
      .toThrow('1 dense query text(s) of the dev set have no embedding (the ranker embeds each query\'s corrected text, 3C-2, or its 3H-stripped text); run `npm run eval:embed -- --set dev --corrected-from-ref 3c2` locally');
    expect(() => assertCorrectedEmbedded({ set: 'dev', setDirArg: ' --set-dir eval/diag/typo', ref: 'WORKTREE', queries, corrector: corrector(true), have }))
      .toThrow('`npm run eval:embed -- --set dev --set-dir eval/diag/typo --corrected-from-ref WORKTREE`');
  });

  it('never names a query text in the refusal (holdout)', () => {
    try {
      assertCorrectedEmbedded({ set: 'holdout', setDirArg: '', ref: '3c2', queries, corrector: corrector(true), have: new Set() });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toMatch(/mach/);
      expect(String(err)).toMatch(/^Error: 2 dense/);
    }
  });

  it('a 3C-1 run, or a run with every corrected text embedded, passes', () => {
    expect(() => assertCorrectedEmbedded({ set: 'dev', setDirArg: '', ref: '3c1', queries, corrector: corrector(false), have: new Set() })).not.toThrow();
    const have = new Set(['machine learning', 'machine vision'].map((t) => embeddingKey(MODEL, t)));
    expect(() => assertCorrectedEmbedded({ set: 'dev', setDirArg: '', ref: '3c2', queries, corrector: corrector(true), have })).not.toThrow();
    expect(() => assertCorrectedEmbedded({ set: 'dev', setDirArg: '', ref: 'x', queries, corrector: null, have: new Set() })).not.toThrow();
  });
});

describe('sc4Texts', () => {
  it('is every text the SC4 runner sends: item texts, typo clean forms and constraint references', () => {
    const suite = JSON.parse(readFileSync(join(REPO, 'test/sc4/queries.json'), 'utf8'));
    const texts = sc4Texts(suite);
    expect(texts).toContain('psycholgy of learning and memory');
    expect(texts).toContain('psychology of learning and memory');
    for (const item of suite.items) {
      expect(texts).toContain(item.text);
      if (item.params.reference) expect(texts).toContain(item.params.reference);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('the SC4 corrected-form cache', () => {
  it('exists in the eval cache format, beside the pinned SC4 caches it never replaces', async () => {
    const path = join(REPO, 'test/fixtures/sc4-corrected-embeddings.json');
    expect(existsSync(path)).toBe(true);
    const cache = JSON.parse(await readFile(path, 'utf8'));
    expect(cache).toMatchObject({ schema: 'vnm-eval-embeddings/1', model: MODEL, dims: 384 });
    expect(typeof cache.entries).toBe('object');
  });
});
