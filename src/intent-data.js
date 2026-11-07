// @ts-check
// The Worker's IntentContext for src/query-intent.js: the 3B-0 data files
// (data/, built by scripts/build-3b-data.mjs from the pinned corpus), the
// stopword list in force, 3C's corpus vocabulary, and the offered-code lookup
// the caller supplies (the bundle's code list, or D1 when the bundle is
// unusable). The static part is built once per isolate.
//
// The vocabulary is data/vocabulary.json, built from the production bundle's
// corpus and versioned with it (scripts/build-vocabulary.mjs). The Vitest
// configs alias this import to the fixture or the pinned vocabulary, the one
// for the corpus the tests search, and every eval run overwrites the file in
// its workspace with one built from the run corpus (eval/lib/corrected.mjs).
import catalogueCodes from '../data/catalogue-codes.json';
import collision from '../data/collision-list.json';
import constraintPhrases from '../data/constraint-phrases.json';
import ge from '../data/ge-pillars.json';
import prefixes from '../data/prefixes.json';
import vocabularyFile from '../data/vocabulary.json';
import { STOPWORDS_IN_FORCE } from './fts-query.js';
import { compileConstraintPhrases } from './intents.js';
import { buildIntentContext } from './query-intent.js';
import { parseVocabulary } from './vocabulary.js';

/** @type {import('./query-intent.js').IntentContext | null} */
let base = null;

/**
 * @param {(code: string) => boolean} isOffered upper-case code → offered in this Worker's corpus
 * @returns {import('./query-intent.js').IntentContext}
 */
export function intentContext(isOffered) {
  base ??= buildIntentContext({
    prefixes: Object.keys(prefixes.prefixes),
    catalogueCodes: catalogueCodes.codes,
    collision: collision.list,
    ge,
    stopwords: STOPWORDS_IN_FORCE,
    isOffered: () => false,
    vocabulary: parseVocabulary(/** @type {import('./vocabulary.js').VocabularyFile} */ (vocabularyFile)),
    constraintPhrases: compileConstraintPhrases(constraintPhrases),
  });
  return { ...base, isOffered };
}
