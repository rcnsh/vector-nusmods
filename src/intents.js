// @ts-check
// 3H's query side (docs/plans/phase3.md 3H, prereg §7 "3H"): the grid
// variants and parse pass A, which reads the no-exam, S/U, workload and
// prerequisite phrases (data/constraint-phrases.json, the P-6 lists mirrored
// by scripts/build-3b-data.mjs) and strips them from the lexical query.

/**
 * The four pooled points (eval/prereg/grids.json [3H]): prereq semantics
 * (i) prerequisite IS NULL, (ii) NULL or cohort-only; the dense query raw or
 * with the 3H phrases stripped.
 * @type {Readonly<Record<string, Readonly<{ prereq: 'i' | 'ii', dense: 'stripped' | 'raw' }>>>}
 */
export const INTENT_VARIANTS = Object.freeze({
  'i-stripped': Object.freeze({ prereq: 'i', dense: 'stripped' }),
  'i-raw': Object.freeze({ prereq: 'i', dense: 'raw' }),
  'ii-stripped': Object.freeze({ prereq: 'ii', dense: 'stripped' }),
  'ii-raw': Object.freeze({ prereq: 'ii', dense: 'raw' }),
});

/** The variant in force. */
export const INTENT_VARIANT = 'i-stripped';

/** The variant in force's settings. */
export const INTENT = INTENT_VARIANTS[INTENT_VARIANT];

/** The bases `su=1` accepts, as `interpreted.su` names them (C-12, prereg A2). */
export const SU_BASIS = Object.freeze(['CS/CU', 'su']);

/**
 * @typedef {{ re: RegExp, kind: 'exam' | 'su' | 'hoursBelow' | 'prereq', hours: number | null }} ConstraintPhrase
 *   `hours`: a fixed hour limit (`light workload`), or null when the phrase captures N.
 * @typedef {{ exam: string[], su: string[], hoursBelow: string[], light: number, prereq: string[] }} ConstraintPhrasesFile
 * @typedef {{ text: string, exam: boolean, su: boolean, hoursBelow: number | null, prereq: boolean }} PassA
 */

/**
 * A phrase as a regex (prereg §5 "Matching"): bounded by no [a-z0-9] on
 * either side, a space matching a run of whitespace or '-', every other
 * character literal, and N an integer 1–99 (C26).
 * @param {string} phrase
 */
const phraseRegex = (phrase) => new RegExp(`(?<![a-z0-9])${phrase.split('N').map((part) =>
  part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]+')).join('([1-9][0-9]?)')}(?![a-z0-9])`, 'g');

/**
 * @param {ConstraintPhrasesFile} file
 * @returns {ConstraintPhrase[]}
 */
export function compileConstraintPhrases(file) {
  /** @type {ConstraintPhrase[]} */
  const out = [];
  for (const kind of /** @type {const} */ (['exam', 'su', 'hoursBelow', 'prereq'])) {
    for (const phrase of file[kind]) {
      out.push({ re: phraseRegex(phrase), kind, hours: kind === 'hoursBelow' && !phrase.includes('N') ? file.light : null });
    }
  }
  return out;
}

/**
 * Pass A (parse step 4): every 3H phrase, leftmost-longest and
 * non-overlapping, read and stripped. An ignored intent's phrases are not
 * read and stay in the text. Of several hour limits the smallest holds.
 * @param {string} text the canonical query (after 3C's correction for the lexical side)
 * @param {ConstraintPhrase[]} phrases
 * @param {Set<string>} ignored
 * @returns {PassA}
 */
export function passA(text, phrases, ignored) {
  /** @type {{ start: number, end: number, kind: ConstraintPhrase['kind'], hours: number | null }[]} */
  const all = [];
  for (const p of phrases) {
    if (ignored.has(p.kind)) continue;
    for (const m of text.matchAll(p.re)) {
      const start = /** @type {number} */ (m.index);
      all.push({ start, end: start + m[0].length, kind: p.kind, hours: p.kind === 'hoursBelow' ? p.hours ?? Number(m[1]) : null });
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  /** @type {PassA} */
  const out = { text, exam: false, su: false, hoursBelow: null, prereq: false };
  /** @type {[number, number][]} */
  const spans = [];
  let at = 0;
  for (const m of all) {
    if (m.start < at) continue;
    at = m.end;
    spans.push([m.start, m.end]);
    if (m.kind === 'hoursBelow') out.hoursBelow = Math.min(out.hoursBelow ?? Infinity, /** @type {number} */ (m.hours));
    else out[m.kind] = true;
  }
  let stripped = text;
  for (const [s, e] of spans.reverse()) stripped = `${stripped.slice(0, s)} ${stripped.slice(e)}`;
  out.text = spans.length ? stripped.replace(/\s+/g, ' ').trim() : text;
  return out;
}
