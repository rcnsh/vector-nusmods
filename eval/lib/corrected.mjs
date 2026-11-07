// @ts-check
// 3C in the eval harness (docs/plans/phase3.md "3C Typos and prefixes").
//
// - The vocabulary a ranker corrects against is built from the run's own
//   corpus (the pinned snapshot, or a set's corpus.json) by the ranker's own
//   builder, and written over data/vocabulary.json in the run's workspace, so a
//   run never reads the production vocabulary the ref commits.
// - A ranker that embeds its corrected text (3C-2) needs an embedding for each
//   query's corrected form. The runner refuses a run that lacks one and names
//   the command that adds them: `eval:embed --corrected-from-ref <ref>`, which
//   asks the same corrector which texts it produces.
// - A ranker with 3H's parse (src/intents.js) also embeds the query with its
//   3H phrases stripped, under its `stripped` variant. `dense` asks the ranker's
//   own parse for every text its dense half embeds beyond the query, so both
//   commands cover those texts too.
// A ranker without src/typo.js has no corrector (null) and needs nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, embeddingKey } from './embeddings.mjs';

/**
 * @typedef {{
 *   file: { corpus: string, documents: number, count: number, dataVersion: string },
 *   serialized: string,
 *   embedsCorrected: boolean,
 *   corrected: (text: string) => string | null,
 *   dense: ((text: string) => string[]) | null,
 * }} RankerCorrector `corrected`: the text the ranker embeds beside the query
 *   (its canonical q with 3C's corrections), or null when it corrects nothing.
 *   `dense`: for a ranker with 3H's parse, every text its dense half embeds
 *   beyond the canonical query (3C-2's corrected form, 3H's stripped form);
 *   null for an older ranker, whose only extra text is `corrected`.
 */

/**
 * The 3C corrector of the ranker at `root`, with its vocabulary built from
 * `modules` by its own builder; null for a ranker without 3C.
 * @param {string} root a workspace (or the repo) holding the ranker's src/
 * @param {{ title: string, description?: string | null }[]} modules the run corpus
 * @param {string} label the run corpus's identity, recorded as the vocabulary's data version
 * @returns {Promise<RankerCorrector | null>}
 */
export async function rankerCorrector(root, modules, label) {
  const typoPath = join(root, 'src/typo.js');
  if (!existsSync(typoPath)) return null;
  const url = (/** @type {string} */ f) => pathToFileURL(join(root, 'src', f)).href;
  const { buildVocabulary, parseVocabulary, serializeVocabulary } = await import(url('vocabulary.js'));
  const { correctQuery, EMBED_CORRECTED } = await import(url('typo.js'));
  const { canonicalQuery } = await import(url('query-intent.js'));
  const file = buildVocabulary(modules, { corpus: 'eval', dataVersion: label });
  const vocab = parseVocabulary(file);
  /** @type {RankerCorrector['dense']} */
  let dense = null;
  const parse = await rankerIntentParser(root, vocab);
  if (parse) {
    // As src/search.js denseTexts: the dense query, and under 3C-2 the corrected one.
    dense = (text) => {
      const q = canonicalQuery(text.trim());
      const p = parse(q);
      return [p.dense, ...(EMBED_CORRECTED === true && p.corrected !== null ? [p.corrected] : [])].filter((t) => t !== q);
    };
  }
  return {
    dense,
    file,
    serialized: serializeVocabulary(file),
    embedsCorrected: EMBED_CORRECTED === true,
    corrected: (text) => {
      // As /search does: trimmed, then canonical (src/search.js parseSearch).
      const q = canonicalQuery(text.trim());
      const c = correctQuery(q, vocab);
      return c.text === q ? null : c.text;
    },
  };
}

/**
 * The 3H parse of the ranker at `root` (parseQuery over its own data files and
 * the given vocabulary), or null for a ranker without src/intents.js. Takes a
 * canonical query. Nothing is offered, so no code pins: callers read only the
 * dense text, the corrected text and the 3H constraints.
 * @param {string} root
 * @param {unknown} vocab the ranker's parsed vocabulary
 * @returns {Promise<((q: string) => { dense: string, corrected: string | null, constraints: Record<string, unknown> }) | null>}
 */
export async function rankerIntentParser(root, vocab) {
  if (!existsSync(join(root, 'src/intents.js'))) return null;
  const url = (/** @type {string} */ f) => pathToFileURL(join(root, 'src', f)).href;
  const { buildIntentContext, parseQuery } = await import(url('query-intent.js'));
  const { compileConstraintPhrases } = await import(url('intents.js'));
  const { STOPWORDS_IN_FORCE } = await import(url('fts-query.js'));
  const data = (/** @type {string} */ f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
  const ctx = buildIntentContext({
    prefixes: Object.keys(data('prefixes.json').prefixes), catalogueCodes: data('catalogue-codes.json').codes,
    collision: data('collision-list.json').list, ge: data('ge-pillars.json'), stopwords: STOPWORDS_IN_FORCE,
    isOffered: () => false, vocabulary: vocab, constraintPhrases: compileConstraintPhrases(data('constraint-phrases.json')),
  });
  return (q) => parseQuery(q, ctx);
}

/**
 * Writes the run's vocabulary where the ranker reads it.
 * @param {string} root the workspace
 * @param {RankerCorrector} corrector
 */
export async function writeRankerVocabulary(root, corrector) {
  await writeFile(join(root, 'data/vocabulary.json'), corrector.serialized);
  return {
    corpus: corrector.file.corpus, terms: corrector.file.count, documents: corrector.file.documents,
    sha256: createHash('sha256').update(corrector.serialized).digest('hex'),
  };
}

/**
 * The distinct corrected forms of `texts`, in first-seen order.
 * @param {Pick<RankerCorrector, 'corrected'> & Partial<Pick<RankerCorrector, 'dense'>>} corrector
 * @param {string[]} texts
 */
export function correctedTexts(corrector, texts) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const t of texts) {
    if (corrector.dense) for (const d of corrector.dense(t)) out.add(d);
    else {
      const c = corrector.corrected(t);
      if (c !== null) out.add(c);
    }
  }
  return [...out];
}

/**
 * Refuses a run whose ranker embeds corrected texts (3C-2) when any query's
 * corrected text has no embedding. Names only a count, never a text (holdout).
 * @param {{
 *   set: string, setDirArg: string, ref: string, queries: { text: string }[],
 *   corrector: Pick<RankerCorrector, 'corrected' | 'embedsCorrected'> & Partial<Pick<RankerCorrector, 'dense'>> | null, have: Set<string>,
 * }} o `setDirArg`: ' --set-dir <dir>' or ''; `have`: embedding keys available to the run
 */
export function assertCorrectedEmbedded({ set, setDirArg, ref, queries, corrector, have }) {
  if (!corrector?.embedsCorrected && !corrector?.dense) return;
  const missing = correctedTexts(corrector, queries.map((q) => q.text)).filter((t) => !have.has(embeddingKey(MODEL, t)));
  if (missing.length === 0) return;
  throw new Error(`${missing.length} dense query text(s) of the ${set} set have no embedding (the ranker embeds each query's corrected text, 3C-2, or its 3H-stripped text); `
    + `run \`npm run eval:embed -- --set ${set}${setDirArg} --corrected-from-ref ${ref}\` locally`);
}

/**
 * Every text the SC4 runner (test/full/sc4.test.js) sends to /search: item
 * texts, typo clean forms and constraint references, distinct.
 * @param {{ items: { text: string, params: Record<string, unknown> }[] }} suite
 */
export function sc4Texts(suite) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of suite.items) {
    out.add(item.text);
    for (const k of ['clean', 'reference']) if (typeof item.params[k] === 'string') out.add(/** @type {string} */ (item.params[k]));
  }
  return [...out];
}

/**
 * 3F: writes the run corpus's duplicate groups where a ranker with src/groups.js
 * reads them (data/groups.json in the workspace), built by the ranker's own
 * builder, so a run never reads the production groups its ref commits. Null
 * for a ranker without 3F.
 * @param {string} root the workspace
 * @param {{ code: string, title: string, description?: string | null }[]} modules the run corpus
 * @param {string} label the run corpus's identity, recorded as the groups' data version
 */
export async function writeRankerGroups(root, modules, label) {
  const path = join(root, 'src/groups.js');
  if (!existsSync(path)) return null;
  const { buildGroupsFile, serializeGroupsFile } = await import(pathToFileURL(path).href);
  const file = buildGroupsFile(modules, { corpus: 'eval', dataVersion: label });
  const serialized = serializeGroupsFile(file);
  await writeFile(join(root, 'data/groups.json'), serialized);
  return { version: file.version, groups: file.counts.groups, sha256: createHash('sha256').update(serialized).digest('hex') };
}
