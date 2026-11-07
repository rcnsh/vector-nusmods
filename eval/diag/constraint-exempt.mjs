#!/usr/bin/env node
// @ts-check
// 3H's constraint-exempt dev queries (docs/plans/phase3.md 3H, C3-8,
// pre-registered at P-6). A dev query is exempt iff it parses a 3H intent and
// every one of its grade-≥1 documents fails that constraint under the
// candidate's semantics. The candidate's own parse (its src/ at the ref, with
// its vocabulary built from the pinned corpus, as a run builds it) decides
// what each query parses; the qrels in use decide what is relevant. Dev only:
// the report refuses `--exempt` on an encrypted set.
//
//   node eval/diag/constraint-exempt.mjs --ref <ref> [--out <file>]
//
// Prints, and with --out writes, { ids, intent, ... }: `ids` is what
// `eval:report --change-kind no-loss --exempt <file>` reads; `intent` lists
// every dev query with a parsed 3H intent and its constraints.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadPinnedWith } from '../lib/corpus.mjs';
import { rankerIntentParser } from '../lib/corrected.mjs';
import { qrelsFor } from '../lib/metrics.mjs';
import { layout, loadQrels, loadQueries } from '../lib/sets.mjs';
import { buildWorkspace } from '../lib/workspace.mjs';

/**
 * @typedef {{ exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} IntentConstraints
 * @typedef {{ examSemesters: number[], su: boolean, gradingBasis: string | null, workloadHours: number | null, prereqNone: boolean, prereqCohortOnly: boolean }} IntentFields
 */

/**
 * The first 3H constraint a module fails, or null. As src/search.js applies
 * them: exam=0 with a semester filter means no exam in that semester.
 * @param {IntentFields} m
 * @param {IntentConstraints} c
 * @param {{ prereq: 'i' | 'ii', suGrading: (basis: string | null) => boolean, sem?: number }} o
 */
export function failedConstraint(m, c, o) {
  if (c.exam === 0 && (o.sem !== undefined ? m.examSemesters.includes(o.sem) : m.examSemesters.length > 0)) return 'exam';
  if (c.su === 1 && !(m.su || o.suGrading(m.gradingBasis))) return 'su';
  if (c.hoursBelow !== undefined && (m.workloadHours === null || m.workloadHours >= c.hoursBelow)) return 'hoursBelow';
  if (c.prereq === 'none' && !(m.prereqNone || (o.prereq === 'ii' && m.prereqCohortOnly))) return 'prereq';
  return null;
}

/**
 * The exempt ids, by C3-8.
 * @param {{
 *   queries: { id: string, text: string, filters?: Record<string, unknown> }[],
 *   qrels: import('../lib/metrics.mjs').Qrels,
 *   parse: (text: string) => IntentConstraints,
 *   fieldsOf: (code: string) => IntentFields | undefined,
 *   prereq: 'i' | 'ii', suGrading: (basis: string | null) => boolean,
 * }} o `parse` takes the raw query text and returns its parsed 3H constraints
 */
export function constraintExempt({ queries, qrels, parse, fieldsOf, prereq, suGrading }) {
  /** @type {{ id: string, constraints: IntentConstraints, relevant: number, failing: Record<string, string> }[]} */
  const intent = [];
  for (const [i, q] of queries.entries()) {
    const constraints = parse(q.text);
    if (Object.keys(constraints).length === 0) continue;
    const relevant = [...qrelsFor(qrels, q.id, i).grades].filter(([, g]) => g >= 1).map(([code]) => code);
    const sem = q.filters?.sem === undefined ? undefined : Number(q.filters.sem);
    /** @type {Record<string, string>} */
    const failing = {};
    for (const code of relevant) {
      const m = fieldsOf(code);
      if (!m) throw new Error(`${q.id}: relevant ${code} is not in the run corpus`);
      const why = failedConstraint(m, constraints, { prereq, suGrading, sem });
      if (why) failing[code] = why;
    }
    intent.push({ id: q.id, constraints, relevant: relevant.length, failing });
  }
  const ids = intent.filter((q) => q.relevant > 0 && Object.keys(q.failing).length === q.relevant).map((q) => q.id);
  return { ids, intent };
}

async function main() {
  const { values: a } = parseArgs({ options: { ref: { type: 'string' }, out: { type: 'string' } } });
  if (!a.ref) throw new Error('--ref <ref> is required: the candidate whose parse and semantics decide');
  const { root, ranker } = await buildWorkspace({ ref: a.ref, name: `exempt-${a.ref.replace(/[^a-z0-9.-]/gi, '_')}` });
  const src = (/** @type {string} */ f) => import(pathToFileURL(join(root, 'src', f)).href);
  const { INTENT } = await src('intents.js');
  if (!INTENT) throw new Error(`${a.ref} has no 3H parse (src/intents.js INTENT)`);
  const { buildVocabulary, parseVocabulary } = await src('vocabulary.js');
  const { canonicalQuery } = await src('query-intent.js');
  const { suGrading } = await src('vector-bundle.js');
  const { modules, info } = await loadPinnedWith(root);
  const vocab = parseVocabulary(buildVocabulary(modules, { corpus: 'eval', dataVersion: info.textSha256 }));
  const parse = /** @type {NonNullable<Awaited<ReturnType<typeof rankerIntentParser>>>} */ (await rankerIntentParser(root, vocab));
  const set = layout('dev');
  const [{ queries }, qrels] = await Promise.all([loadQueries(set), loadQrels(set)]);
  const byCode = new Map(modules.map((m) => [m.code, m]));
  const { ids, intent } = constraintExempt({
    queries, qrels, prereq: INTENT.prereq, suGrading, fieldsOf: (code) => byCode.get(code),
    parse: (text) => /** @type {IntentConstraints} */ (parse(canonicalQuery(text.trim())).constraints),
  });
  const out = {
    schema: 'vnm-3h-exempt/1', rule: 'C3-8', set: 'dev', ref: ranker.ref, sha: ranker.sha,
    semantics: INTENT.prereq, dense: INTENT.dense, qrels: qrels.version, ids, intent,
  };
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (a.out) await writeFile(a.out, text);
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
