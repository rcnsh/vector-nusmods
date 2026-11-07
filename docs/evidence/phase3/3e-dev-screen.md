# 3E dev screen: no eligible point; 3E is dropped, slot unspent (2026-11-07)

3E replaces the fusion with weighted RRF, w_v/(k + r_v) + w_l/(k + r_l) + w_c/(k + r_c) with
w_l = w_c = 1. Ties go to the best single-list rank, then the dense rank, then the code (plan §2
3E, prereg §6). All 8 grid points were screened against the shipped ranker `89cb10e` under the
general rule.

Only (w_v 2, k 20) passes dev, and it fails SC4 guard sc4-085. SC4 must be green at Phase 3's exit
(plan §8), and that guard passes on the shipped ranker. So no point is eligible, and 3E is dropped
with no look spent (L6 joins the reserve). Production keeps its fusion. The code stays on branch
`rrf-weighting-3e`.

## Result (qrels-dev-v8, 85 primary answerable queries, judged@10 100% for every run)
| point (w_v, k) | nDCG@10 | Δ | BCa 95% CI | gate |
|---|---|---|---|---|
| shipped `89cb10e` | 0.767 | | | |
| (1, 20) | 0.766 | −0.001 | [−0.006, 0.003] | fail |
| (1, 60) | 0.765 | −0.002 | [−0.009, −0.000] | fail |
| (1.25, 20) | 0.767 | +0.000 | [−0.007, 0.009] | fail |
| (1.25, 60) | 0.764 | −0.003 | [−0.008, 0.003] | fail |
| (1.5, 20) | 0.775 | +0.008 | [−0.003, 0.020] | fail |
| (1.5, 60) | 0.763 | −0.004 | [−0.013, 0.003] | fail |
| **(2, 20)** | **0.784** | **+0.017** | **[0.001, 0.036]** | **pass** (sign-flip p 0.054, persona-cluster CI [−0.006, 0.033]) |
| (2, 60) | 0.768 | +0.001 | [−0.010, 0.012] | fail |

The point (1, 60), the shipped weights with only the new tiebreak, loses 0.002 and fails.

## Why (2, 20) is not eligible
`test/full/sc4.test.js` on `3e-v200k20` fails guard **sc4-085** ("psychology electives for cs
majors"). The guard allows at most 2 CS modules in the top 10; this point gives 6 (PLB1201
CS2101 PL1101E CS2251 CS6101 CS5446 CS4249 PL4229 CS4234 CP4285). Doubling the dense list's
weight lets the embedding's reading of "cs majors" crowd the page. The plan added S2's cases to
the SC4 guards to catch this (plan 3E). The shipped ranker passes the guard.

Lead decision: the plan has no explicit rule for a 3E point that breaks an SC4 guard. A point that
breaks the exit suite cannot ship, so it is not eligible for selection. The named retry, the
second-ranked point (1.5, 20), fails the dev screen, so no eligible point remains. As with 3A-1
and `stopwords-v2`, the change is dropped at the dev screen. 3E is not a change SC4 needs, so this
is not a Q4 decision.

## How it was measured
- **Code:** `src/fusion.js` holds the 8 grid points as variants, plus `legacy`, which reproduces
  the shipped fusion bit for bit (tested against it).
- **Review:** the fresh-context review found one defect with a failing input. Float rounding split
  scores that are equal in exact arithmetic, so the new tiebreak never ran for them. The fix
  compares close scores exactly, using BigInt fractions; every grid weight is a multiple of 1/4.
  An exact search shows distinct three-list scores can be 3e-12 apart, so rounding to a tolerance
  would have merged real differences.
- **Runs:** `npm run eval -- --variant 3e-<p> --ref 3e-<p> --baseline shipped-89cb10e`, re-run
  after the fix.
- **Pool:** one round over shipped and the 8 points found 16 documents.
- **Judging:**
  - Round `p3e` used judge A, one fresh subagent per packet (6), and graded 135 of 135 items.
  - Planted repeats agreed exactly (4).
  - On the 115-pair drift sample, A agreed with the stored grade 0.939 of the time (mean Δ
    +0.009).
  - The round merged as `qrels-dev-v8`, and the typo diagnostic set was rebuilt from it.
- **No cross-family check:** no point was selected, so there was nothing to check.
- **No remote call.**
