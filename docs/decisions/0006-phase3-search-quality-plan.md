# 0006: Phase 3 search-quality plan

Status: accepted (lead, 2026-11-04). Jacob answered the gate questions on 2026-11-06
(`docs/plans/phase3.md` §10): Q1 sealed test set, Q2 VPN off, Q4 the standing rule as written.
Q3 did not trigger (`docs/evidence/phase3/embed-latency.md`). The plan converged at r3.1 after three critic rounds (eval discipline; vectors, deploy and
cost; SC4 and student queries). Its §11 logs every objection and where it landed.

## Context
Phase 3 must meet SC4 (codes, GE pillars, typos, level and exam/S/U/workload intents, "no
matches") and SC5 (the shipped ranker beats the current one on held-out data), and re-measure
SC7, which failed at a pooled p50 of 351 ms. Warm searches spend ~232 ms in Vectorize, and the
holdout allows 12 looks.

## Decisions
- **In-Worker exact vectors, Vectorize as standby.** Dense search is a brute-force dot product
  over float32 corpus vectors bundled in the Worker as a `Data` module (10.7 MB of 64 MiB,
  measured below).
  - One keyed builder makes a pinned bundle for CI and SC4 and a production bundle for deploys.
    The manifest records `rowsKey`, and the deploy guard refuses any bundle that differs from D1.
  - Every corpus change follows one runbook. The manifest and an offline data version merge
    first, then D1 is written in a D1-only mode behind a bookmark, then the deploy and smoke.
    Vectorize is written last, with every code upserted and the mutation awaited.
  - Vectorize stays an identical cold standby behind `DENSE_BACKEND=vectorize`. That flip is
    degraded service: masks fall back to code order, and 3H applies after hydrate.
  - The cache key carries the deploy's version id and every new parameter.
- **Look budget.** Seven change looks (L1–L7: 3A-1, 3A-2, 3B, 3C, 3D, 3E, 3H). The reserve is
  5 under the sealed SC5 reading and 4 under the holdout reading, where L12 is the SC5 look.
  - Retries are named before each look, and the reserve funds at most one per failed change.
    Never a 13th look.
  - Each look's baseline is stored and judged, and the verdict comes from `eval:report` on
    fully judged runs.
  - A count from the custodian-only `eval:count` prints one integer, is logged outside the
    ledger, and is not a look. ADR 0003's look definition is amended to say so.
- **No-look gates.**
  - 3-0: identical result lists on dev and the fixture.
  - 3F: identity with the group-first projection, plus dev ΔnDCG@10 ≥ 0.
  - 3G must pass all of:
    - the SC4 suite;
    - ≥ 90% of a held-apart gibberish half;
    - no untagged dev query emptied;
    - dev answerable ΔnDCG@10 ≥ −0.01;
    - a custodian count of emptied untagged holdout queries equal to 0.
- **Hard beginner exclusion.** An explicit beginner phrase removes level ≥ 5 outright and adds a
  soft prior for levels 1–2. It is echoed in `interpreted` and undoable with `ignore=level`.
- **Year as a level window.** `3rd year` means 3 ≤ level ≤ 4, because d-064's answers are level
  4. `level 3000`, `3000 level` and `3k` stay exact. Several level phrases take the union.
- **groups-v1 is the product's duplicate rule**, the same rule the eval scores by (variant
  families and exact cross-listings). Collapsed members ride as `variants` with their credits.
- **The SC4 suite** is 90 pre-registered queries, each with an exact expected `interpreted`
  JSON.
  - It runs on the pinned bundle in CI, with partial codes at topK = 50, and is confirmed live
    by ≤ 20 fresh queries.
  - The custodian checks it against the holdout by count only.
- **3H's dev screen** exempts queries whose only relevant documents fail the parsed constraint
  (d-099 under both prereq semantics, d-011 under the literal one). L7's holdout rule has no
  such exemption.

## Consequences
- Production dense search becomes exact, so the replica-vs-production caveat narrows to the
  corpus pin. Vectorize queried dims drop to ~0, and the binding limit becomes Workers CPU or
  neurons, whichever measures smaller.
- Every corpus change needs a deploy, and the guard blocks deploys from `main` between the
  merge and the D1 write.
- 3-0's PR adds the measured bundle size, startup time and CPU per query to this ADR (below).

## Measured at 3-0 (local, 2026-11-06; [`3-0.md`](../evidence/phase3/3-0.md))
- **Bundle size.** 32 B/row of filter table plus 384 float32 per row. That is pinned
  10,683,976 B (6,771 rows) and production 10,695,040 B (6,778 rows, dry build). The Worker
  uploads 10,520 KiB (gzip 8,666 KiB): 16% of 64 MiB. The filter row is 32 B, not the ~12 B
  estimated, because 16 B are reserved for 3B's prefix id, 3F's group id and 3H's fields.
- **Startup.** With `wrangler check startup` (local Miniflare, Apple M5 Pro), the 10.5 MB
  bundle and the 0.7 MB fixture both show an 8–20 ms profile window and 0 ms active CPU. The
  `Data` module is an ArrayBuffer, parsed on the first dense search (~1 ms). The binding gate,
  `startup_time_ms` ≤ 200 from `wrangler versions upload`, runs at deploy.
- **CPU per query.** The exact search over the pinned bundle in the Vitest workerd pool takes
  **1.44 ms** warm and unfiltered, 0.17–0.99 ms filtered, and 3 ms on the first call. The live
  figure is the 3-0 smoke's mean `CPUTimeMs`.
- **Identity, no look.** On dev, 98 of 98 queries return the same `results` as the `eval-v0`
  replica, hybrid and dense-only. On the fixture, all 111 dense differences are swaps of exact
  ties (|Δ| ≤ 2.2e-16), each one listed.

## Measured live (version `343ea371`, 2026-11-06; [`3-0-cutover.md`](../evidence/phase3/3-0-cutover.md))
- **Startup.** The deploy gate passed it under 200 ms, but the figure is not recorded; the next
  deploy records it.
- **CPU per request.** GraphQL `workersInvocationsAdaptive` over the first 18 requests (searches
  and `/health` mixed): p50 9.1 ms, p75 15.5 ms, p99 34.2 ms. A fresh isolate's first search
  takes 33–34 ms. At ~12 ms a request, the 30M included CPU-ms cover ~2.5M requests a month,
  so CPU is the binding allowance.
- **Latency.** A warm SIN burst of 12 fresh queries reads server `total` p50 131 ms and p67
  156.8 ms (Vectorize before: 332 / 335.4). That is the warm half of SC7 only; the counted run
  is at the freeze.
- **Standby.** Vectorize holds all 6,778 rows and agrees with D1 (runbook step 8).

## Dissent
No objection was rejected outright. Four were applied in part:
1. **B-8 (round 1): delay the D1 write until the smoke passes.** The deploy guard needs D1 to
   match the manifest before the deploy, so the D1 write cannot wait. It runs behind a Time
   Travel bookmark and is restored, with the merge reverted, if the smoke fails. Every Vectorize
   write still waits for the smoke.
2. **A2-7 (round 2): a working fallback for every change SC4 needs.** Each has one, but some
   can coincide with the failed candidate or be ineligible (3B without `stopwords-v2`, 3C's other
   variant, 3D's α = 0 point, 3G's next τ). Those failures go straight to Jacob (Q4) rather than
   to new variants no critic has reviewed.
3. **A2-13 (round 2): cite the group-aware baseline on `docs/phase2-baseline`.** It is scored
   under `qrels-dev-v1`, which scores five answerable code queries as no-answer. The plan gates
   on the `qrels-dev-v2` baseline in `EVAL.md` (PR #30).
4. **A3-2 (round 3): the whole SC4 suite green at 3G's gate.** 3G can merge before 3H, and a
   change can be dropped under Q4, so the gate skips items owned by an unmerged or dropped
   workstream. It never skips the typo, gibberish, non-existent-code and guard items. SC4's exit
   check still needs the whole suite.

## Deviations
- **3H goes to L7 on (ii)-stripped, which fails the dev screen (Jacob, 2026-11-08).** The
  pre-registered selection picks (ii)-stripped. It fails dev no-loss by −0.0044, and no query is
  exempt under (ii) on `qrels-dev-v10`.
  - **Where the loss comes from:** all of it is d-011 and d-099. The filter removes the
    relevant modules that have real prerequisites, which caps each query's nDCG@10 near 0.7.
  - **Why the fallback is not taken:** (i)-stripped passes the screen only because the
    exemption leaves out its larger losses on the same two queries.
  - **What stays as written:** L7 runs the unchanged holdout no-loss rule, and (i)-stripped
    remains the named retry.
  - Evidence: [`3h-dev-screen.md`](../evidence/phase3/3h-dev-screen.md).
