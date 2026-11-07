# 3H dev screen: (ii)-stripped goes to L7 by Jacob's override (2026-11-08)

3H's query side reads no-exam, S/U, workload and no-prerequisite phrases and applies them as hard
filters (plan §2 3H). The phrases are stripped from the keyword query. Four points are pooled:
prerequisite semantics (i) `prerequisite IS NULL` or (ii) NULL or cohort-only, each with the
dense query raw or stripped.

The pre-registered selection picks **(ii)-stripped**, but it fails the dev screen's no-loss check
by −0.004. Its whole loss comes from two queries, and that loss is the cost the filter is
designed to have (below). The pre-registered fallback, (i)-stripped, passes the screen only
because the exemption rule leaves out its two larger losses. **Jacob chose to send (ii)-stripped
to L7 anyway (deviation, recorded in ADR 0006).** The holdout look runs the unchanged no-loss
rule, and (i)-stripped remains the named retry.

## Round p3h (qrels-dev-v10, judged@10 100% for every run)
The five runs (shipped `f004351` and the four points) pooled 48 unjudged documents over 98
queries. Judge A graded them under the single-judge protocol:
- planted repeats: 5 of 5 identical;
- drift sample: 116 pairs, with 0.948 agreement with the stored grades and a mean Δ of +0.034.

| point | nDCG@10 | Δ (85 primary) | BCa 95% CI | constraint block (5) | prereq queries mean Δ | exempt | no-loss |
|---|---|---|---|---|---|---|---|
| shipped `f004351` | 0.775 | | | 0.475 | | | |
| (i)-stripped | 0.757 | −0.018 | [−0.069, 0.002] | 0.556 | −0.299 | d-011, d-099 | pass (+0.003 over 83) |
| (i)-raw | 0.756 | −0.019 | [−0.070, 0.001] | 0.574 | −0.321 | d-011, d-099 | pass (+0.002 over 83) |
| **(ii)-stripped** | 0.770 | **−0.004** | [−0.025, 0.003] | 0.556 | **−0.075** | none | **fail** |
| (ii)-raw | 0.769 | −0.006 | [−0.026, 0.001] | 0.574 | −0.097 | none | fail |

Commands:
1. `node eval/diag/constraint-exempt.mjs --ref 3h-<point> --out docs/evidence/phase3/3h-exempt-<point>.json`
2. `npm run eval:report -- --run 3h-<point> --baseline shipped-f004351 --change-kind no-loss --exempt …`
3. `node eval/diag/3h-select.mjs --baseline shipped-f004351 --exempt-dir docs/evidence/phase3 --out docs/evidence/phase3/3h-select.json`

## Selection (pre-registered; `3h-select.json`)
- **Raw vs stripped: stripped, under both semantics.** Raw's constraint-block mean nDCG@10 is
  0.018 higher, short of the 0.05 margin. Its overall Δ is also below 0.
- **Semantics: (ii).** Its mean Δ over the five prereq-intent dev queries (d-011, d-023, d-048,
  d-080, d-099) is −0.075, against −0.299 for (i).
- **Fallback (named retry): (i)-stripped**, the other semantics with the same dense choice. It
  passes SC4 on dev (75/75) and the dev screen.

## The screen for (ii)-stripped
| check | result |
|---|---|
| SC4 intent rules | `test/full/sc4.test.js` 75/75 under `ii-stripped` |
| dev primary ΔnDCG@10 ≥ 0 over primary less exempt | **fail:** −0.0044 over 85. No query is exempt under (ii) |
| no-intent queries keep their top 10 | pass: all 88 unchanged |
| exact-code rank-1, errors, judged@10 | pass: 0 lost, 4 and 4 non-200, 100% |

Per intent query (Δ nDCG@10 vs shipped):
- **Prereq queries:**
  - d-011 `intro accounting no prerequisites`: −0.411;
  - d-099 `intro accunting no prerqeuisites`: −0.229;
  - d-023: +0.085;
  - d-048: +0.075;
  - d-080: +0.105.
- **Exam queries (constraint block, outside the primary metric):**
  - d-024: 0;
  - d-037: +0.283;
  - d-049: +0.168;
  - d-050: +0.096;
  - d-081: −0.142.

**Why d-011 and d-099 lose.**
- **d-011:** 3 of its 5 relevant modules have real prerequisites: ACC2706, FIN2704X and QF1100.
  The filter removes them, as the query asks. Only the two cohort-only modules remain,
  ACC1701XA and ACC1701XC. The ideal ranking still counts the removed modules, so the best
  nDCG@10 any filtered list can reach is 0.679.
- **d-099:** the same holds for 5 of its 7 relevant modules, and its ceiling is 0.709.
- **(ii)-stripped's ranking:** it puts ACC1701XA first on both queries.

## Exemption under qrels-dev-v10
The plan (§1, §2 3H) expected d-099 to be exempt under both semantics, because its only relevant
module failed both. Under qrels-dev-v10, d-099 has 7 relevant modules, and ACC1701XA and
ACC1701XC pass (ii). So the rule, run as pre-registered on the qrels in use, exempts nothing
under (ii). Under (i) it exempts d-011 and d-099.

## Deviation (Jacob, 2026-11-08)
- **Asked:** whether L7 spends on (ii)-stripped, overriding its dev-screen fail; on (i)-stripped,
  by the rules; or on nothing (pause 3H).
- **Answer:** (ii)-stripped.
- **Reasons:**
  - the dev loss is the filter's own ceiling on two queries;
  - every other intent query gains;
  - no other query changes;
  - (i) loses far more on the same two queries.
- **Safeguards:**
  - L7 runs the unchanged holdout rule;
  - the named retry is unchanged.

## Review (fresh context, diff and goal only)
Its checks pass:
- `npm test` 1001/1001 and SC4 75/75;
- a scratch sweep of every route, mode and backend: masks, pins, GE, phrase-only queries,
  grouping on and off, the standby, and the explicit/parsed `hoursBelow` minimum;
- the phrase list matches its mirror;
- no phrase word is corrected on the production vocabulary;
- `constraintExempt` on the real corpus agrees with this page;
- the eval's dense texts equal the Worker's.

It made three low-severity findings:
1. **Fixed: a not-offered code's `related` neighbours ignored parsed intents, and the standby
   ignored every 3H filter.**
   - **Bundle:** it now filters on the combined intents.
   - **Standby:** it reads 50 deep under a 3H constraint and checks each neighbour after
     hydrate.
   - **Test:** `search-constraints.test.js`. No result list changes, because `related` is not
     in `results`.
2. **Known: 3C's correction runs before pass A, so a corpus lacking a phrase word can correct it
   away.** On the fixture vocabulary, `hours` becomes `tours`, so the `N hours` phrases don't
   parse there. Every phrase word occurs in the pinned and production corpora, and a test holds
   that none is corrected (3H-1). The order is pre-registered (parse step 4 after 3C).
3. **Known: a misspelled phrase stays in the dense text under `stripped`.**
   - **Example:** d-099 `intro accunting no prerqeuisites` parses the intent on the corrected
     text. Its raw text holds no exact phrase to strip, so the raw query is embedded.
   - **Effect:** the eval embeds the same texts, so the Worker and the eval agree.

## Next
L7 on holdout: store the shipped `f004351` baseline and `ii-stripped`. Before that, the custodian
embeds the holdout queries' stripped texts (`eval:embed --set holdout --corrected-from-ref`).
