#!/usr/bin/env node
// @ts-check
// 3H's pre-registered dev selection (docs/plans/phase3.md 3H, grids.json
// [3H] and [selection].prereq), over the four pooled runs and the shipped
// baseline, on the qrels in use:
// - raw vs stripped (per semantics): stripped wins unless raw's constraint-block
//   mean nDCG@10 is higher by >= rawMargin and raw's overall dev Δ >= 0;
// - semantics: mean ΔnDCG@10 over the dev queries with a parsed prereq intent,
//   (i) winning ties to 3 decimals;
// - the screen's third check: every dev query with no parsed intent keeps its
//   top 10 unchanged.
// The parsed intents come from each candidate's exempt file
// (eval/diag/constraint-exempt.mjs), which lists every intent query.
//
//   node eval/diag/3h-select.mjs --baseline shipped-<sha> --exempt-dir <dir> [--out <file>]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadGroups, withCorpusGroups } from '../lib/groups.mjs';
import { FEATURE_GAP_SHAPES, K, compare, scoreRun } from '../lib/metrics.mjs';
import { layout, loadQrels, loadQueries, runFile } from '../lib/sets.mjs';

const { values: a } = parseArgs({ options: { baseline: { type: 'string' }, 'exempt-dir': { type: 'string' }, out: { type: 'string' } } });
if (!a.baseline || !a['exempt-dir']) throw new Error('--baseline <variant> and --exempt-dir <dir> are required');
const grid = JSON.parse(await readFile(new URL('../prereg/grids.json', import.meta.url), 'utf8'))['3H'];
const set = layout('dev');
const [{ queries }, qrels] = await Promise.all([loadQueries(set), loadQrels(set)]);
const scored = withCorpusGroups(qrels, await loadGroups());
const readRun = async (/** @type {string} */ v) => JSON.parse(await readFile(runFile(set, v), 'utf8'));
const base = await readRun(a.baseline);
const baseScores = scoreRun(base, queries, scored);
const baseById = new Map(baseScores.map((s) => [s.id, s]));
const blockIds = new Set(queries.filter((q) => (q.shapes ?? []).some((t) => FEATURE_GAP_SHAPES.includes(t))).map((q) => q.id));
const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r3 = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;

/** @type {Record<string, any>} */
const points = {};
for (const [prereq, dense] of /** @type {[string, string][]} */ (grid.pooled)) {
  const name = `${prereq}-${dense}`;
  const run = await readRun(`3h-${name}`);
  const exempt = JSON.parse(await readFile(join(a['exempt-dir'], `3h-exempt-${name}.json`), 'utf8'));
  if (exempt.qrels !== qrels.version) throw new Error(`${name}: exempt file is on ${exempt.qrels}, qrels in use ${qrels.version}`);
  const scores = scoreRun(run, queries, scored);
  const byId = new Map(scores.map((s) => [s.id, s]));
  const intentIds = new Set(exempt.intent.map((/** @type {any} */ q) => q.id));
  const prereqIds = exempt.intent.filter((/** @type {any} */ q) => q.constraints.prereq === 'none').map((/** @type {any} */ q) => q.id);
  const delta = (/** @type {string} */ id) => /** @type {any} */ (byId.get(id)).ndcg - /** @type {any} */ (baseById.get(id)).ndcg;
  const top = (/** @type {any} */ r, /** @type {string} */ id) => (r.results[id]?.codes ?? []).slice(0, K).join(' ');
  const changedNoIntent = queries.filter((q) => !intentIds.has(q.id) && top(run, q.id) !== top(base, q.id)).map((q) => q.id);
  points[name] = {
    prereq, dense,
    overallDelta: compare(baseScores, scores).overall.ndcg.delta,
    constraintBlockNdcg: mean([...blockIds].map((id) => /** @type {any} */ (byId.get(id)).ndcg)),
    prereqIds,
    prereqMeanDelta: mean(prereqIds.map(delta)),
    intentDeltas: Object.fromEntries([...intentIds].map((id) => [id, r3(delta(id))])),
    exempt: exempt.ids,
    noIntentTop10Changed: changedNoIntent,
  };
}

/** @type {Record<string, string>} */
const denseChoice = {};
for (const prereq of grid.prereqSemantics) {
  const raw = points[`${prereq}-raw`], stripped = points[`${prereq}-stripped`];
  denseChoice[prereq] = raw.constraintBlockNdcg - stripped.constraintBlockNdcg >= grid.rawMargin && raw.overallDelta >= 0 ? 'raw' : 'stripped';
}
const [pi, pii] = [points[`i-${denseChoice.i}`], points[`ii-${denseChoice.ii}`]];
const semantics = r3(pii.prereqMeanDelta) > r3(pi.prereqMeanDelta) ? 'ii' : 'i';
const selected = `${semantics}-${denseChoice[semantics]}`;
const fallback = `${semantics === 'i' ? 'ii' : 'i'}-${denseChoice[semantics]}`;
const out = {
  schema: 'vnm-3h-select/1', set: 'dev', qrels: qrels.version, baseline: a.baseline, rawMargin: grid.rawMargin,
  blockIds: [...blockIds], points, denseChoice, semantics, selected, fallback,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
if (a.out) await writeFile(a.out, text);
process.stdout.write(text);
