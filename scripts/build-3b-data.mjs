#!/usr/bin/env node
// @ts-check
// Phase 3 step 3B-0 (docs/plans/phase3.md 3B-0, docs/plans/phase3-prereg.md §3):
// the corpus data the 3B code parser reads, built from the pinned corpus
// (scripts/pinned-corpus.mjs, sha-checked) and the P-6 files, never from the
// network. Writes, under data/:
//   prefixes.json        the letter parts of offered codes, with their module counts;
//   catalogue-codes.json the catalogue-only codes (in moduleInfo.json, no offering
//                        in the pinned year), sorted: what the Worker bundles;
//   catalogue-only.json  the same codes with their titles and descriptions (noMatch
//                        `not-offered`), the rows ingest loads into D1 `catalogue_only`;
//   ge-pillars.json      the GE pillar table, from eval/prereg/ge-pillars.json;
//   collision-list.json  the P-6 collision list and its exempt pillar prefixes, from
//                        eval/prereg/collision-list.json (the Worker cannot read eval/);
//   constraint-phrases.json  3H's P-6 phrase lists (no exam, S/U, workload, prerequisite),
//                        from eval/prereg/intent-phrases.json `constraints`, for parse pass A;
//   cohort-only-prereq.json  3H-0's P-6 cohort-only prerequisite rule, from
//                        eval/prereg/cohort-only-prereq.json (normalise() reads it, and
//                        the eval workspace has data/ but not eval/).
// and docs/evidence/phase3/3b-0-counts.json, critic C's corpus counts (plan §1)
// re-run on the pinned corpus.
//
//   node scripts/build-3b-data.mjs            write every file
//   node scripts/build-3b-data.mjs --check    rebuild in memory; exit 1 if any committed file differs
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { queryTokens } from '../src/fts-query.js';
import { catalogueOnlyRecords } from './lib.mjs';
import { loadPinnedCorpus, PINNED_RELEASE } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The files this script owns, relative to the repo root. */
export const OUTPUTS = Object.freeze({
  prefixes: 'data/prefixes.json',
  catalogueCodes: 'data/catalogue-codes.json',
  catalogueOnly: 'data/catalogue-only.json',
  gePillars: 'data/ge-pillars.json',
  collisionList: 'data/collision-list.json',
  cohortOnly: 'data/cohort-only-prereq.json',
  constraintPhrases: 'data/constraint-phrases.json',
  counts: 'docs/evidence/phase3/3b-0-counts.json',
});

/** @param {string} rel */
const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
/** @param {string} code */
const lettersOf = (code) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(code))[0];
const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** The PK range of a partial code: [P(+'0' when P is letters only), P + ':'). @param {string} p */
export const partialRange = (p) => [/\d$/.test(p) ? p : `${p}0`, `${p}:`];

/**
 * Every output, as the bytes it should hold.
 * @returns {Promise<Record<keyof typeof OUTPUTS, string>>}
 */
export async function build() {
  const corpus = await loadPinnedCorpus();
  const source = { release: PINNED_RELEASE, acadYear: corpus.acadYear, moduleInfoSha256: corpus.moduleInfoSha256 };
  const offered = corpus.modules.map((m) => m.code).sort(byCode);
  const offeredSet = new Set(offered);
  const moduleOf = new Map(corpus.modules.map((m) => [m.code, m]));
  const recordOf = new Map(corpus.records.map((r) => [String(r.moduleCode), r]));

  /** @type {Record<string, number>} */
  const prefixCounts = {};
  for (const c of offered) prefixCounts[lettersOf(c)] = (prefixCounts[lettersOf(c)] ?? 0) + 1;
  const prefixes = Object.keys(prefixCounts).sort(byCode);

  const catalogue = catalogueOnlyRecords(corpus.records).sort((a, b) => byCode(a.code, b.code));
  const catalogueSet = new Set(catalogue.map((r) => r.code));

  const ge = await readJson('eval/prereg/ge-pillars.json');
  const collision = await readJson('eval/prereg/collision-list.json');
  const cohort = await readJson('eval/prereg/cohort-only-prereq.json');
  const phrases = await readJson('eval/prereg/intent-phrases.json');

  // groups-v1, a singleton counting as its own group (A2-5).
  const groups = (await readJson('eval/groups.json')).groups;
  /** @type {Map<string, number>} */
  const groupOf = new Map();
  groups.forEach((/** @type {string[]} */ g, /** @type {number} */ i) => g.forEach((m) => groupOf.set(m, i)));
  /** @param {string[]} codes */
  const groupCount = (codes) => new Set(codes.map((c) => (groupOf.has(c) ? `g${groupOf.get(c)}` : c))).size;
  /** @param {string} p */
  const members = (p) => {
    const [lo, hi] = partialRange(p);
    return offered.filter((c) => c >= lo && c < hi);
  };
  /** @param {string} p */
  const partial = (p) => ({ members: members(p).length, groups: groupCount(members(p)) });

  /** @type {Map<string, number>} */
  const df = new Map();
  for (const m of corpus.modules) for (const t of new Set(queryTokens(`${m.title} ${m.description}`))) df.set(t, (df.get(t) ?? 0) + 1);

  const prefixPairs = [];
  for (const a of prefixes) for (const b of prefixes) if (a !== b && b.startsWith(a)) prefixPairs.push(`${a}/${b}`);
  const strictN000 = (/** @type {string} */ c) => /^[A-Z]+[1-9]000$/.test(c);
  const suffixedN000 = (/** @type {string} */ c) => /^[A-Z]+[1-9]000[A-Z]*$/.test(c);
  const withAndWithoutS = offered.filter((c) => !c.endsWith('S') && offeredSet.has(`${c}S`));
  const pillarMembers = offered.filter((c) => ge.prefixes.includes(lettersOf(c)));

  const counts = {
    schema: 'vnm-3b0-counts/1',
    source: { ...source, offered: offered.length, catalogueRecords: corpus.records.length },
    plan: 'docs/plans/phase3.md §1 "Corpus facts for 3B–3H" (critic C), re-run by 3B-0',
    prefixes: {
      count: prefixes.length,
      byLength: prefixes.reduce((n, p) => ({ ...n, [p.length]: (n[p.length] ?? 0) + 1 }), /** @type {Record<number, number>} */ ({})),
      notPrefixes: Object.fromEntries(['ART', 'LAW', 'COMP', 'MATH', 'ECON'].map((p) => [p, prefixCounts[p] ?? 0])),
      collisionSeed: Object.fromEntries(collision.seed.map((/** @type {string} */ p) => [p, prefixCounts[p] ?? 0])),
      prefixPairs: { count: prefixPairs.length, examples: prefixPairs.filter((p) => ['CS/CSA', 'SE/SEA', 'PH/PHS', 'LA/LAJ', 'GES/GESS'].includes(p)) },
      dfPositive: { count: prefixes.filter((p) => (df.get(p.toLowerCase()) ?? 0) > 0).length, of: prefixes.length,
        examples: ['CS', 'GEN', 'GET', 'GEX'].filter((p) => (df.get(p.toLowerCase()) ?? 0) > 0) },
    },
    ranges: {
      naiveCS: offered.filter((c) => c >= 'CS' && c < 'CT' && c.startsWith('CSA')),
      digitBoundedCS: offered.filter((c) => c >= 'CS0' && c < 'CS:' && !/^CS\d/.test(c)),
      digitBoundedGES: members('GES').filter((c) => c.startsWith('GESS')),
    },
    partialCodes: Object.fromEntries(['GEA', 'CS101', 'DAO17', 'MUL21', 'CS32', 'GEC', 'GEX', 'GESS', 'PL32'].map((p) => [p, partial(p)])),
    xxN000: {
      offeredStrict: offered.filter(strictN000).length,
      offeredWithSuffix: offered.filter(suffixedN000).length,
      offeredWithSuffixCodes: offered.filter(suffixedN000),
      catalogueStrict: catalogue.filter((r) => strictN000(r.code)).length,
      catalogueWithSuffix: catalogue.filter((r) => suffixedN000(r.code)).length,
    },
    trailingS: {
      count: withAndWithoutS.length,
      cs1231: { offered: offeredSet.has('CS1231'), offeredS: offeredSet.has('CS1231S'), su: recordOf.get('CS1231')?.attributes?.su === true },
    },
    cs4400: { offered: offeredSet.has('CS4400'), catalogue: recordOf.has('CS4400') },
    catalogueOnly: {
      count: catalogue.length,
      examples: Object.fromEntries(['GEQ1000', 'GEH1001', 'IS1103', 'ACC1701X'].map((c) => [c, catalogueSet.has(c) ? recordOf.get(c)?.title : null])),
    },
    pillars: {
      byPrefix: Object.fromEntries(ge.prefixes.map((/** @type {string} */ p) => [p, prefixCounts[p] ?? 0])),
      members: pillarMembers.length,
      groups: groupCount(pillarMembers),
    },
    meCodes: { ME3000: offeredSet.has('ME3000'), IS6000: offeredSet.has('IS6000'), GEA1000: offeredSet.has('GEA1000'), ES1000: offeredSet.has('ES1000') },
    level: { CS3000offered: offeredSet.has('CS3000'), cs3Level3: offered.filter((c) => /^CS\d/.test(c) && moduleOf.get(c)?.level === 3).length },
  };

  const json = (/** @type {unknown} */ v) => `${JSON.stringify(v, null, 1)}\n`;
  return {
    prefixes: json({
      schema: 'vnm-3b-prefixes/1', source, rule: 'the letter part of every offered code in the pinned corpus, with its offered-module count',
      count: prefixes.length, prefixes: Object.fromEntries(prefixes.map((p) => [p, prefixCounts[p]])),
    }),
    catalogueCodes: `${JSON.stringify({
      schema: 'vnm-3b-catalogue-codes/1', source, rule: 'codes in moduleInfo.json with no offering in the pinned year (catalogue-only), sorted',
      count: catalogue.length, codes: catalogue.map((r) => r.code),
    })}\n`,
    // One row per line, so a catalogue change diffs by row.
    catalogueOnly: `{"schema":"vnm-3b-catalogue-only/1","source":${JSON.stringify(source)},"columns":["code","title","description"],"count":${catalogue.length},"rows":[\n${
      catalogue.map((r) => JSON.stringify([r.code, r.title, r.description])).join(',\n')}\n]}\n`,
    gePillars: json({
      schema: 'vnm-3b-ge-pillars/1', from: 'eval/prereg/ge-pillars.json (P-6, unchanged)',
      source: { url: ge.source.url, check: 'docs/evidence/phase3/3b-0.md "GE page"' },
      prefixes: ge.prefixes, genericPhrases: ge.genericPhrases, pillars: ge.pillars,
    }),
    collisionList: json({
      schema: 'vnm-3b-collision-list/1', from: 'eval/prereg/collision-list.json (P-6, unchanged)',
      list: collision.list, exempt: collision.exempt,
    }),
    cohortOnly: json({
      schema: 'vnm-3h-cohort-only/1', from: 'eval/prereg/cohort-only-prereq.json (P-6, unchanged)',
      normalise: cohort.normalise, remove: cohort.remove, remainder: cohort.remainder, remainderFlags: cohort.remainderFlags,
    }),
    constraintPhrases: json({
      schema: 'vnm-3h-constraint-phrases/1', from: 'eval/prereg/intent-phrases.json `constraints` (P-6, unchanged)',
      exam: phrases.constraints.exam.phrases, su: phrases.constraints.su.phrases,
      hoursBelow: phrases.constraints.hoursBelow.phrases, light: phrases.constraints.hoursBelow.light,
      prereq: phrases.constraints.prereq.phrases,
    }),
    counts: json(counts),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  const out = await build();
  const stale = [];
  for (const [key, rel] of Object.entries(OUTPUTS)) {
    const want = out[/** @type {keyof typeof OUTPUTS} */ (key)];
    if (values.check) {
      const have = await readFile(join(ROOT, rel), 'utf8').catch(() => null);
      if (have !== want) stale.push(rel);
    } else {
      await writeFile(join(ROOT, rel), want);
      console.log(`wrote ${rel}`);
    }
  }
  if (values.check) {
    if (stale.length) { console.error(`out of date: ${stale.join(', ')} (node scripts/build-3b-data.mjs)`); process.exitCode = 1; }
    else console.log('3B-0 data up to date');
  }
}
