# Progress log

Append-only. Re-read this file and `docs/PLAN.md` after every compaction or new session.

## 2026-11-03 — Phase 0 start

- Initial commit `3b18041` of the working tree the live Worker runs (incl. untracked
  `0005_rank.sql` and unstaged edits). Private repo `rcnsh/vector-nusmods` created; squash-only,
  auto-delete branches.
- Deployed version `c6744373-1aff-4d8d-8b7f-6dd4e6c3d513` (deployment `9e0c69cd…`,
  2026-09-04 12:06Z) ↔ commit `3b18041`. Evidence: live `/` byte-identical to `src/page.html`.
- Pinned upstream data: release `data-2026-2027-20260904` holds the gzipped `.data/` files
  production was built from. Raw sha256 moduleInfo
  `2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1`, moduleList
  `c56b6fbec195da856eff924a167c31b446686aebfa8ba7346a43dd12b893e36e`.
- Remote D1 schema snapshot (read-only pragma query): **estimate ~60 rows read / 0 written;
  actual 77 read / 0 written**. Saved for the rebuild diff.
- Earlier remote read for `sqlite_master` listing: 16 rows read (and one malformed query, 0).
- Workstream 0b (live + frontend reproductions) done: 36 `/search` + 7 other live calls,
  evidence in `/tmp/vnm-repro/` (to be copied into `docs/evidence/phase0/`).
- Critic incident: critic A's first experiment ran the test plugin with default
  `remoteBindings`, which made 2 Cloudflare API GETs (`/accounts`, `/memberships`). No AI,
  Vectorize or D1 call. Led to objection #2.
- Phase 0 planning loop round 1: 2 critics, 14 objections, all accepted (see PLAN.md).

## 2026-11-04 — Phase 0 workstream 0c (findings)

- `docs/FINDINGS.md` triages all 35 IDs: 30 reproduced, 3 partially-reproduced (B4, P2,
  V1), 2 fixed (O1, O2 by PR #1), 0 rejected. Each section gives the claim, the evidence
  (tests and/or `docs/evidence/phase0/` files) and the cause by file:line.
- Characterisation tests `[<ID> known-bug] …` (plain `it`, asserting the current wrong
  output) in `test/findings/`, plus `test/full/findings.test.js`. Over the full pinned
  corpus, B1 is exact: 31 sem-3 matches for `management`, lexical returns the same 6 codes
  production did. Mutation check: un-capping the FTS limit or fixing `topK=` fails the
  matching tests.
- `vitest.config.mjs` now has two projects: `workers` (as before) and `node` for
  `*.node.test.js` (Node-side `scripts/` code and repository-file checks; workerd can't load
  `node:*` without `nodejs_compat`, which production doesn't set). The workers project uses an
  extglob include rather than `exclude`, because a project-level exclude overrides the CLI's
  `--exclude 'test/full/**'`.
- `scripts/check-findings.mjs` + `npm run check:findings`, unit-tested in
  `test/check-findings.node.test.js`. CI: `.github/workflows/findings.yml` (no path filter,
  plain node, no `npm ci`).
- Live calls: none. Pinned corpus fetched from the GitHub release (not api.nusmods.com) into
  `/tmp/vnm-0c/` and `.data/` (gitignored) to run `test/full` locally.
- No change to `src/` or `scripts/lib.mjs`.

## 2026-11-04 — Phase 0 passed; Phases 1 and 2 planned

- PR #1 (harness, migrations, lint, typecheck, CI) and PR #2 (35 findings triaged: 30 reproduced,
  3 partially reproduced, 2 fixed; characterisation tests; findings CI) merged. Main CI green on
  `546a91d` (CI + Findings). Each PR went through 4 fresh-context review rounds; findings fixed
  (fake Vectorize semantics, CI path filter, B5 tests made behavioural, check-findings reads
  exact test titles from the AST).
- Phase 0 exit: CI green on main; `check-findings` OK; `db:rebuild-check` 0 differences. No
  deploy (no runtime change); production still `c6744373` ↔ `3b18041` (behaviourally = `546a91d`).
- Phase 1 and Phase 2 plans converged after 3 critic rounds each (`docs/plans/`). Key facts found:
  D1 primary is WEUR with read replication disabled (likely cause of latency for SIN users);
  indexing `code` in FTS or raising depth to 100 would change rankings; a D1 write overrun is an
  account-wide outage; a reused holdout inflates SC5's false-positive rate (simulated 14% vs 2.5%).
- Tagged `eval-v0` = `7ac9841` (ranker identical to production).

## 2026-11-04 — Phase 1 step 0: module split and instrumentation (`phase1/instrument`)

- `src/index.js` is now only the router. Search (cache, rate limiter, filters, FTS, fusion,
  hydration) is in `src/search.js`, `/module` and `/facets` in `src/modules.js`, the admin
  ingest routes in `src/ingest.js`, response helpers in `src/http.js`, spans and D1 counters in
  `src/timing.js`, and the default model id in `src/embedding.js`. 1A, 1B and 1C can now edit
  different files.
- Behaviour-neutral: every Phase 0 test passes unchanged except three. `[B4 known-bug] responses
  carry no Server-Timing header` is flipped to `[B4 instrumented] …`. Two source-text tests (O3,
  S1) now read all of `src/*.js` instead of `src/index.js`, and the README's `NG_LIST_UPDATED`
  pointer moved to `src/modules.js`. A throwaway differential test ran the old `index.js` and the
  new router side by side on 31 paths (errors, every filter, every mode, admin 404) and got
  identical status, headers (minus the two new ones) and bodies.
- `/search` responses carry `Server-Timing` (`cache;desc=hit|miss`, `limit`, `pin`, `embed`,
  `vector`, `fts`, `hydrate`, `total` from fetch entry, only stages that ran). Cache hits get fresh
  spans, and the stored entry never holds any. `/module` and `/facets` have `d1` and `total`.
  Each `/search` writes one JSON log line: status, cache, q (first 100 chars), q length, mode,
  filters, topK, counts, spans, D1 queries/rows read/served_by_region/served_by_primary, colo,
  version. Headers and IPs are not logged.
- `version_metadata` binding (`CF_VERSION_METADATA`); every response has `x-app-version` (tag,
  else version id, else `dev`); `GET /health` → `{ ok, versionId, versionTag }`, no D1.
- `npm run deploy` → `scripts/deploy.mjs`: refuses a dirty tree, an unfetchable origin, or a HEAD
  not on `origin/main`; runs `wrangler deploy --tag <short sha> --message "<sha> <subject>"`;
  prints the version id. Not run. Plain `wrangler deploy` still works; the README says
  `npm run deploy` is the only supported path.
- Tests 98 → 117 (`test/instrument.test.js`, `test/deploy.node.test.js`). No live calls, no
  remote commands, no deploy.

## 2026-11-04 — Phase 1 workstream 1B (search request path, PR #7)

- B4, B5, B6, B7, O3 → `fixed`; B8 stays `reproduced` with three of four sub-claims fixed
  (the Unicode tokeniser is 1A's, in `src/lexical.js`). Characterisation tests flipped.
- `/search`: parameters validated first (400s touch no cache, limiter or binding); canonical
  cache key from validated params + `DATA_VERSION` (`src/data-version.json`, seeded
  `2d138795d387`, the pinned moduleInfo sha256 prefix), no D1 read before the lookup;
  pin, lexical and embed→Vectorize concurrent, then one hydrate of only rendered columns and
  rows; all public D1 reads on `withSession('first-unconstrained')`, admin on `env.DB`.
  Vectorize gets no `returnMetadata`; depth and `MAX_TOPK` stay 50, RRF unchanged.
- Timeouts (`src/upstream.js`): AI 1.5 s (also aborted via `signal`), Vectorize 1.5 s, D1 3 s.
  Hybrid AI/Vectorize failure → lexical-only, `degraded: { source, reason }`, Server-Timing
  `degraded`, cached 60 s; per-isolate breaker skips the dense half for 30 s after 3
  consecutive failures. `mode=vector` still 502s. Top-level catch → JSON 500 with
  `requestId` (cf-ray); `/module` bad percent-encoding → 400; rate limiter fails open.
- `/module/:code` selects the 0001–0005 columns by name. O3: ingest posts the NG list's
  `{ updatedAsAt, source, count }` to `/admin/facets` → `meta('ng_list')`; the constant is gone.
- Neutrality: `test/differential.test.js` runs 522 generated requests (every query × mode with
  random filters/topK/junk, incl. invalid ones) through a frozen copy of the pre-1B route
  (`test/legacy/search-f61072e.js`) and the new Worker: 0 differences beyond the declared
  fixes (empty `topK=`, canonical `query` echo). Mutation check: depth multiplier 3 → 2 fails
  it. With stale vectors injected, results are identical; only `retrieval.fused` may be higher
  (hydration stops when the page is full).
- Not done here (remote, lead's): enabling D1 read replication (ADR 0002), the SC7
  measurement. Ingest does not yet write `src/data-version.json` (1C).
- Tests 119 → 128; full corpus 4/4. No live calls, no remote commands, no deploy.

## 2026-11-04 — Phase 2 workstream 2a (eval harness)

- Branch `phase2/harness`: eval runner (`vitest.eval.config.mjs`, separate from `npm test`;
  actual Worker in workerd, seeded through `/admin/ingest`, fake Vectorize with real corpus
  vectors, fake AI serving precomputed vectors and failing loudly otherwise), custom reporter via
  `task.meta`, `--ref` overlay (used with `eval-v0`), metrics/stats/gate, `scripts/embed.mjs`,
  holdout custody (`scripts/holdout.mjs`, AES-256-GCM, ledger, 12-look limit), CLI
  (`eval`, `eval:report`, `eval:pool`, `eval:embed`, `eval:verify`, `test:eval`). v1 eval moved
  to `eval/v1/`. Docs: `eval/README.md`.
- **Workers AI neurons (estimated from token counts, 1,841/M tokens; logged in
  `docs/evidence/neurons.tsv`): 1,837.2 total** = fixture set 6.7 (31 texts, 1 request) + one
  corpus pass 1,829.1 (5,920 unique texts, 60 requests) + determinism check 1.4 (3 texts).
  No Vectorize, D1 remote, deploy, live-site or api.nusmods.com call.
- Release `emb-bge-small-v0` (corpus embeddings, text = `embeddingText()` at `eval-v0`):
  `corpus.f32.gz` sha256 `584555bb3a5d277c82b93ac4b4a0774ccf49004d7836df66a7aa7716ec70a3f2`,
  `corpus.index.json` sha256 `2de0622cd47bba4befb4e0532904fcb0c4854e066639c9bb82479f38dc84d495`.
- Finding: Workers AI embeddings are not bit-deterministic across calls/batches. Same text,
  two REST calls: cosine 0.9994–0.9998; batch of 31 vs batches of 100: min 0.9797, median 0.9957
  (23 texts). Relevant to the 2c fidelity check (offline vs live near-tie order).
- Full-corpus smoke run (fixture queries, 6,771 modules, `--ref eval-v0`): 19 s end to end.

## 2026-11-04 — Phase 2 2a: PR #6 review fixes (eval harness)

- **Errors** (medium): a non-200 response is never correct-empty or relevant; every gate (dev,
  holdout, cutoff, SC5) has "no new errors"; `npm run eval` prints the error count after a dev
  run. The reviewer's case (8 answerable + 4 no-answer, candidate 500s on the 4) now fails the
  cutoff gate on dev and holdout instead of passing.
- **Ledger custody** (medium): `holdout` and `test` always count looks in
  `eval/holdout-ledger.md`, whatever `--set-dir` says. Ciphertexts are `VNMENC2` with AAD
  `<set>/<file>`, so files copied into another set's directory do not decrypt. The self-test
  uses a new encrypted `selftest` set (ledger in its own directory; ciphertexts regenerated with
  a throwaway key each run). `holdout.mjs encrypt|decrypt` take `--set`.
- **Concurrency** (medium): check-then-append runs under an `O_EXCL` lock (`<ledger>.lock`; waits
  2 min; a lock older than 30 min is removed with a message). `npm run eval` reserves its look
  (`reserved` row, counted) before retrieval and finalises it as the verdict, `aborted` or
  `unjudged`. Three parallel reports from 11 rows now record 12, not 14.
- **Leaks** (medium): holdout/test errors print only `eval: <set> run failed (<class>); details
  withheld`. Metrics errors give a bad grade's value and position, never the rationale or id.
- **Tampering** (low): every table row counts however it is spaced; a look is refused when the
  ledger has fewer rows than `HEAD` or `origin/main`, or is missing while git has it.
- **Small samples** (low): < 10 primary answerable queries fails every gate ("insufficient
  queries"); zero-variance BCa intervals are `degenerate` and never pass a CI check; tripwires
  with n < 3 use the point estimate.
- **Corpus** (low): `report`/`run` refuse when qrels and run corpus sha256s (moduleInfo; NG if
  recorded) differ; comparison output names the qrels version.
- **Which ranker ran** (low): run files record `ranker.treeHash`; the self-test checks it against
  `git archive eval-v0`. A mutant that runs HEAD under `--ref eval-v0` now fails the self-test.
- No Cloudflare, live-site or api.nusmods.com call; no neurons spent.

## 2026-11-04 — PR #6 review round 2 (fix delta `3eee229..bcd843b`)

A fresh-context review of the fixes found 7 issues (1 high); all fixed, each with a test that
fails on the previous code.

- **Worker output** (high): workerd prints a Worker's uncaught exceptions to stderr itself, so
  holdout query text reached the terminal despite `silent`. Vitest now runs in a child process
  (`eval/runner/vitest-child.mjs`); for encrypted sets its stdout and stderr are discarded and
  the outcome returns over IPC. Self-test step 5 runs a probe ranker (a dangling commit object)
  that logs, throws and throws uncaught with the query text: visible on the fixture set, absent
  on `selftest`.
- **Ledger edits** (medium): the tamper check compares looks per known set against `HEAD` and
  `origin/main`, so relabelling `holdout` rows `selftest` or `test` is refused.
- **Lock ownership** (medium): the lock holds a random token; a holder writes (`assertHeld()`
  right before a synchronous append) and removes the lock only while the token is its own. A
  stale lock is broken under `<ledger>.lock.break`, so two breakers cannot remove each other's
  fresh lock; an abandoned break lock is cleared after 1 min.
- **Decisive comparison** (low–medium): gate amendment, to record in ADR 0003. A cutoff verdict
  needs ≥ 3 no-answer queries; the dev targeted route needs ≥ 3 distinct answerable queries
  across its target shapes (otherwise only the CI route can pass). The 10-query overall floor
  stays. Floors are 3, not 10, because dev has 5 `noanswer` queries and some shapes have 2.
- **Withheld line** (low): a failed encrypted run now prints `eval: <set> run failed
  (RunFailedError); details withheld`.
- **treeHash** (low): covers `test/wrangler.test.jsonc` (its compatibility date and flags change
  what runs).
- Tests 207 → 213 unit; self-test 5 steps. No Cloudflare, live-site or api.nusmods.com call.
- Round 3 (fresh review of `bcd843b..bd43eb5`): one finding. With `--embed-missing` on an
  encrypted set, a failed `scripts/embed.mjs` exited directly, leaving the reserved look
  unfinalised and printing its output. Now its output is discarded for encrypted sets and the
  failure throws `EmbeddingError` (withheld line; look finalised `aborted`). `.lock.break`
  gitignored. Tests 214.
- Merging main (PR #7) broke the `eval-v0` overlay: the runner used `test/helpers.js`, which now
  imports `src/search.js` and `src/upstream.js`, absent at `eval-v0`. The runner now has its own
  `eval/runner/harness.js` that uses only `src/index.js`'s default `fetch` and `/admin/ingest`;
  a node test fails if any overlaid runner file imports another `src/` module. Since PR #7 the
  ranker embeds the canonical (ASCII-lowercased) query, so two fixture texts (`cs1010s`,
  `xyz9999`) were embedded (1 request, ~0.0 neurons, logged). Phase 2c will need the same for
  dev and holdout queries whose canonical form differs.
- Round 4 (fresh review of `6fe708b..8a04d9a`, the last allowed round): two findings fixed, one
  accepted.
  - Medium: the harness no longer resets the dense breaker, so three missing canonical-form
    vectors in a row opened it and later queries passed keyword-only, hiding their misses. Now
    `embed.mjs` and the run pre-check cover both forms of each query (`queryTextForms`: raw,
    and the canonical form `/search` embeds; a workerd test checks it against `parseSearch`),
    and any `degraded` response fails its query (self-test probe). One more fixture text
    embedded (~0.1 neurons, logged).
  - Low–medium: the runner import guard is now an acorn AST walk: `export … from`, several
    imports per line, and non-literal dynamic imports (refused) are covered.
  - Accepted: encrypted runs print the pre-retrieval header (ranker, counts; no query content)
    before the withheld line; the self-test already allows exactly that.

## 2026-11-04 — Phase 1A: migration 0006 and exact filtered lexical search (`phase1/fts`)

- `migrations/0006_fts_external.sql`: `modules_fts` rebuilt as external-content FTS5
  (`content='modules'`, `content_rowid='rowid'`, `code UNINDEXED`, `prefix='2 3 4'`) with the
  rank config restored; rowid triggers using the FTS5 `'delete'` command, the update trigger
  guarded by `UPDATE OF code, title, description … WHEN` any of them changed; VIRTUAL generated
  `sem1..sem4`, `ng_sem1`, `ng_sem2`; `row_hash`; `meta('schema','6')`. Not applied remotely.
- B1 fixed (`src/lexical.js`): filters in SQL on the generated columns; bounded top-2000 CTE,
  then, only when the cap may have cut matches, a filter-driven plan (indexed filtered rows,
  FTS5 probed by rowid) behind a cap probe. Exact over 440 queries × 13 filters on the full
  corpus; worst 6,989 rows read per search (gate 8,000), mean 1,071
  (`docs/evidence/phase1/lexical-cost.md`). Unfiltered SQL unchanged.
- Deviation: 0006 also creates `idx_modules_level`, `idx_modules_credits` and partial
  `idx_modules_sem3/4`. Without them the filter-driven plan scans `modules` and the worst
  case is 13,278 rows. Cost: 0006 estimate rises from 16k to ~30.1k rows written, and a forced
  full re-ingest writes 34,381 rows locally (index entries ~5/row), reads 6,771.
- B3 fixed: trigger statements plan without scans; a title update reads 1 row (was every FTS
  row); a forced re-ingest of unchanged rows writes nothing to FTS (asserted byte for byte);
  old triggers: 105,404 changes for the same re-ingest in node:sqlite
  (`docs/evidence/phase1/0006-cost.md`).
- Ranking neutrality: 0006 applied on top of a populated 0001–0005 database leaves unfiltered
  lexical top-50 identical for all 417 distinct queries (0 tie-only diffs, 0 bm25 changes).
  Remotely the rebuild realigns FTS rowids, so exact-bm25 ties may reorder (pre-declared, r3).
- `db:rebuild-check` now proves 0001–0005 == the remote capture (unchanged) and the full chain
  == `test/fixtures/schema-0006.json` (`-- --update` regenerates it).
- `scripts/remote-migration.mjs <name> [--bootstrap]` writes `/tmp/vnm-remote-<name>.sql`
  (wrangler's `d1_migrations` DDL + 0001–0005 rows, body, own row) and prints a rows-written
  estimate; its structure is asserted in `test/migrations.node.test.js`, which also fails on
  any `INSERT OR REPLACE` into `modules`.
- New tests: `test/fts.test.js` (trigger fuzz vs `'rebuild'` + `integrity-check`, no-op
  re-ingest, generated columns), `test/full/lexical.test.js`, `test/migrations.node.test.js`;
  B1/B3 characterisation tests flipped. Mutation-checked: removing the update trigger's
  `'delete'`, its `WHEN` guard, or the lexical fallback each fails a test.
- No remote commands, no deploy, no live requests. Corpus copied from the pinned `.data/`.

## 2026-11-04 — Phase 1A review fixes (PR #8)

- Rebased `phase1/fts` onto `main` after PR #7. Conflicts only in `docs/FINDINGS.md` (summary
  table: B1/B3 `fixed` from #8, B4–B7 `fixed` from #7) and `docs/PROGRESS.md` (both entries
  kept). B8 stays `reproduced`; its note now says the tokeniser is still open after #8.
  `/module` still selects the 0001–0005 columns by name (`test/smoke.test.js` on a 0006 DB).
- High (combined filters over the 8k budget): without `sqlite_stat1`, SQLite drove the
  filter-driven plan from the most recently created equality index (`in`, Computing +
  credits=4: 11,546 rows). `src/lexical.js` now picks the driver (`chooseDriver`) from per-value
  counts in `meta('facets')` and writes every other filter `+m.col`. `/admin/facets` adds
  `credits`, `semesters` and `ngSemesters` counts to the row (data, not schema:
  `schema-0006.json` unchanged); the live `/facets` fallback reads 21,488 rows. Counts load once
  per isolate, only when a search with two or more indexed filters reaches the filter-driven
  plan. Without counts: `FIXED_DRIVER_ORDER` (sem3/4, faculty, ng, level, credits).
- Grid (`test/full/lexical.test.js`): every single value × 419 queries, every two-filter
  combination and 412 three-to-five-filter ones × 12 broad queries: 46,078 depth-50 searches,
  0 mismatches, worst 7,772 rows read (single 6,989, two 7,646). Fixed order (no counts): exact,
  worst 9,148, 101 of 6,700 over 8,000; logged, not gated. **Run `POST /admin/facets` right
  after the deploy** so production has the counts (`docs/evidence/phase1/lexical-cost.md`).
- Low: `test/migrations.node.test.js` bans `UPDATE … SET rowid` in `src/`, `scripts/`,
  `migrations/`; the hazard is in 0006's header comment. Rebutted tie reorder: the reviewer's
  churned-DB measurement is recorded in `docs/evidence/phase1/0006-cost.md`.
- Full-corpus suite 37 s → ~4.5 min locally (CI job timeout 15 min). No remote commands, no
  deploy, no live requests.
- Review round 2 of the fix delta (`c6495ce..03d3f63`): two findings, both fixed.
  - Medium: a facets row without counts was cached per isolate as "no counts", so warm isolates
    kept the fixed order (9,148 rows) after a facets rebuild. Now neither a failed read nor a
    row without counts is cached; the next fallback re-reads the row (1 row).
  - Low: the textual rowid ban missed the upsert form ingest uses (`ON CONFLICT … DO UPDATE SET
    rowid`), schema-qualified, aliased, bracketed and row-value forms. Replaced by a database
    guard: 0006 adds `modules_rowid_immutable` (BEFORE UPDATE, aborts when `new.rowid IS NOT
    old.rowid`); a test applies the migrations in `node:sqlite` and checks 11 spellings are
    refused and rowid-preserving updates (incl. ingest's upsert) still work. 0006 estimate
    unchanged (30,076 rows written; one more schema object).
  - Rollout order (supersedes "right after the deploy"): apply 0006, then rebuild the facets row
    with this code (`POST /admin/facets` through `wrangler dev --remote`, ~21.5k rows read),
    then deploy, so no isolate serves the fixed order.
- Review round 3 (`03d3f63..92c0297`): two findings, both fixed.
  - Medium: as a BEFORE trigger, `modules_rowid_immutable` made SQLite re-read every updated row,
    which D1 bills: forced re-ingest reads 13,542 instead of 6,771. Now AFTER UPDATE (ABORT
    still rolls back the statement and the FTS writes; the 11 refused forms still fail). The
    full-corpus test now asserts exactly 6,771 / 1 / 1 rows read (was `< 3 × modules`).
  - Low (pre-existing): `UPDATE OR REPLACE modules SET code = …` onto an existing code corrupts
    the index like INSERT OR REPLACE; the REPLACE ban now covers it (and `main.`, quoted names),
    with a test showing the corruption.

## 2026-11-04 — Phase 1/2 in flight

- PR #4 (module split + Server-Timing, structured logs, version_metadata, guarded `npm run deploy`)
  and PR #5 (lexical retriever moved to `src/lexical.js`, takes a D1 handle) merged. **Not deployed**:
  the brief allows deploys only after a phase passes its exit criteria, so the plan's "instrumentation
  deploy first" step is replaced by a read-only analytics baseline (below).
- **Production baseline** (GraphQL `workersInvocationsAdaptive`, script `vector-nusmods`,
  2026-10-28..2026-11-04, all routes, 225 successful requests incl. our Phase 0 probes): wall time
  p50 **279 ms**, p90 1,017 ms, p99 1,886 ms; CPU p50 4.3 ms, **p99 18.5 ms** (above the nominal
  10 ms Free limit, with 0 errors). 2 `scriptThrewException` = our B5 probes. Per-span numbers come
  with the Phase 1 deploy.
- Phase 2 2b: 147 persona queries (6 writer subagents, no corpus/tool access; prompts and seeded
  shape quotas in `eval/v2/`) + 18 mechanical code queries + 15 noise-model typos = 180. Split
  provenance-first, TF-IDF topic clusters (single-link, threshold 0.35 = lowest of 0.30–0.50 giving
  every shape ≥ 2 per split): **dev 99 / holdout 81**. Dev sha256 `cf33e601…bc3b4`; holdout plaintext
  sha256 `8f653595…f7bdb4` held by the custodian (lead) in `~/.config/vnm/custody/`, to be committed
  only encrypted. Deviation: TF-IDF instead of embedding similarity for clustering (embedding tool
  not ready); recorded for ADR 0003.
- Running: 2a eval harness, 1A (0006 + exact filtered lexical), 1B (request path).


## 2026-11-04 — Phase 2 2b: query sets committed, ADR 0003

- Dev set moved to the harness layout (`eval/dev/queries.json`, 99 queries, sha256 unchanged
  `cf33e601…bc3b4`). Holdout (81) encrypted with `scripts/holdout.mjs` (`VNMENC2`, bound to
  `holdout/queries.json.enc`): ciphertext sha256 `2431c18e…f66b057` in `eval/holdout/MANIFEST.json`;
  decrypting it reproduces the plaintext sha256 `8f653595…f7bdb4` recorded at the split.
- Custody: the key file was base64 from before the custody tool existed; re-encoded to hex in place
  (same 32 bytes; base64 backup kept, mode 600). `~/.config/vnm/` and `custody/` set to mode 700.
  The custody plaintext is kept (reason in ADR 0003).
- ADR 0003: query sets and locks, custody (procedural, plainly), metrics, the gate as implemented,
  the SC5 sealed-test reading (queued for Jacob), deviations (AES-GCM not age, TF-IDF clustering,
  decisive-comparison floors, both query forms embedded).
- PR #10 review (7 findings) → query sets amended to **v2.1** before any look
  (`eval/v2/amend-v2.1.mjs`, ADR 0003): code queries carry `code-<form>` shapes (the exact-code
  check matched nothing before), non-existent codes are `noAnswerByRule`, the typo copy `d-098`
  is dropped (dev 98), and the holdout's 7 code queries are redrawn from a custody-held seed (the
  v2 picks were rebuildable from public inputs). Holdout code forms: 1 exact, 2 space, 1 partial,
  3 non-existent, so the dev gate now also runs the exact-code check. New hashes in ADR 0003;
  `test/eval/lock.node.test.js` ties the files to them. `eval:verify` refuses any non-`.enc`
  file in an encrypted-set directory, and `.gitignore` keeps plaintext there out of git. The
  custody tool accepts `judge-<judge>.json`. Protocol doc fixes (single-link; 20–28 per persona).
- PR #10 review round 2 (4 findings, fixed): an exact-code regression is now a lower-graded (or
  missing) rank-1 result, not any change (fixing a variant or swapping equal cross-listings
  failed the gate); the holdout's partial code query is redrawn as a code family (a GE pillar
  had ~3 guessable values); drawn targets may not overlap any v2 pick, writer example or other
  draw as a prefix; `eval:verify` ignores dotfiles (`.DS_Store`). Dev unchanged (byte-identical
  re-run); new holdout hashes in ADR 0003.
- PR #10 review round 3 (3 findings, fixed): the partial-code draw excludes `GE*` codes (a
  family such as `GEX10` is nearly a whole pillar) and `ge` is tagged only on `GE[A-Z]` pillars;
  non-existent draws use the same prefix-overlap check as the rest; `eval:verify` skips only
  macOS Finder files (`.DS_Store`, `._*`; also git-ignored), so a hidden plaintext such as
  `.queries.json` is still refused. Re-running the fixed amendment with the custody seed
  reproduces the committed dev file and the committed holdout plaintext byte for byte (the
  committed holdout had no GE-prefixed or overlapping draw), so no hash changes.

## 2026-11-04 — Phase 2 2c (custodian half): holdout embeddings and the eval-v0 holdout run

- Holdout query embeddings (both forms, 119 texts, 2 requests, ~3.4 neurons, logged) in
  `eval/holdout/embeddings.json.enc`; `eval-v0` holdout run stored with `--store-only`
  (`eval/holdout/run-v0.json.enc`, no look, no ledger row). Both ciphertexts are in the manifest.
  Output was counts only.

## 2026-11-04 — Phase 2 2c (dev): baseline, embedding noise, live fidelity

- Dev query embeddings: `npm run eval:embed -- --set dev`, 136 texts, ≈ 4.5 neurons, one pass;
  committed as `eval/dev/embeddings.json`. Raw and canonical forms embed bit-identically
  (bge-small is uncased), so PR #7's canonical form is a no-op for the dense half.
- Baseline (dev v2.1):
  - `v0` (`--ref eval-v0`) and `main-2ddf0aa` both return 20 results on 94/98 queries and 400 on
    the four home-course pastes over 200 characters. 0 degraded.
  - **Top-10 and top-20 are identical on all 98 queries.**
  - Run files are not committed (the README does not say they are); their sha256s are in
    `docs/evidence/phase2/baseline.md`.
- Workers AI nondeterminism (`docs/evidence/phase2/noise.json`):
  - One extra 20-text request (≈ 0.46 neurons). Re-embedding the same text gives cosine
    0.9785–0.99987.
  - That changes the eval-v0 top-10 order on 15/20 queries and the top-10 set on 9/20.
  - Synthetic noise at cos 0.9996 changes the set on 15–19/94; at batch-effect levels, 58–69/94.
  - A 1–2-item dense-driven top-10 change on one query is within noise.
- Live fidelity check:
  - 15 live `/search` calls (`requests.tsv` 35–49), method and rule pre-registered in
    `docs/evidence/phase2/fidelity.md`.
  - Rows and lexical match exactly (up to FTS5 tie groups) on 15/15.
  - The dense half differs as expected: mean overlap@10 8.40 vs the replica, below every modelled
    noise condition's mean (8.47–9.93).
  - **Verdict FAIL** under the pre-registered rule: d-001 (8 vs envelope 9) and d-065 (7 vs 8) are
    unexplained. Candidates (Vectorize ANN, production ingest-batch noise) are unverified.
  - Nothing changed; the lead decides before any gating relies on dense-half resolution.
- Holdout half of 2c not touched (custodian's job).
- Lead decision on the failed fidelity check (2 of 15 queries one item outside their dense-noise
  envelope; lexical half exact): gating proceeds on the replica, limitation recorded in ADR 0003
  "Replica fidelity"; re-check after the Phase 1 forced re-ingest.
- PR #12 review: the hybrid-score decomposition cannot prove lexical ranks (score symmetry and
  collisions; a "must appear" rule that cannot fire on 5 queries). Replaced by a direct check:
  15 live `mode=lexical&topK=50` calls (`requests.tsv` rows 50–64) vs the replica's lexical lists:
  PASS 15/15 up to tie order (10/15 identical). Docs reworded; the ADR decision now cites it.
  Live `/search` calls this session: 30 (15 hybrid, 15 lexical).

## 2026-11-04 — Phase 1 1C: ingest pipeline, B2/B8/B9 fixed

- **B2 fixed.** `text_hash` = hash(model id + embedded-text version + text); `row_hash` =
  hash(normaliser version + the exact bound tuple + Vectorize metadata), shared by the Worker
  and the scripts (`src/rowhash.js`). `/admin/hashes` returns both plus a 0006 schema report.
  `scripts/ingest-core.mjs`: text change → re-embed; row-only change → row rewrite + vector
  re-upsert with its stored values (`getByIds`, no embedding; deviation from r1's "re-embed,
  cheap"); unchanged → skip. Deletes through the new `/admin/delete` (Vectorize, then D1), last,
  only after a clean upsert phase; 95% mass-delete abort before any write. Write budget (default
  40k) summed from `meta.rows_written`, clean resumable stop (`--from` for forced runs). Bounded
  wait on `describe().processedUpToMutation` (the last upsert batch runs alone so the last
  mutation is well defined). `.data/` cache revalidates with an ETag/Last-Modified sidecar past
  `--max-age` (24 h) unless `--offline`. Ingest refuses a database without 0006, a mixed acad
  year, duplicate codes or an embedding-model mismatch. A finished run writes
  `src/data-version.json`; README runbook: ingest → verify → commit it → `npm run deploy`.
  acad_year sub-claim: no query-time fix; rows keyed by code, so deletes and row-hash rewrites
  leave one year (tested).
- `npm run verify`: missing/extra vectors (wrangler `list-vectors` ids), row_hash recomputed from
  stored columns, sampled (≤ 100) metadata via `getByIds`; exits non-zero on drift. Tested with
  the fake index and a stubbed wrangler only; never run remotely.
- **SC6 measured locally** (`docs/evidence/phase1/ingest-cost.md`): forced full re-ingest
  **35,079 rows read** (gate < 500k) / 34,381 written; no-op 28,308 / 2; 25 field-only changes
  28,334 / 138 with no embedding; 10 deletes 28,317 / 22 (local D1 under-counts delete writes).
  Found while measuring: a cold load writes ~7.1 rows/module (~48k), over the 40k default; the
  budget stops it cleanly and a rerun finishes it.
- **B8 fixed:** query tokens split on the exact unicode61 separator set, generated from SQLite
  (`src/fts-separators.js`); ASCII MATCH strings byte-identical over every query fixture.
- **B9 fixed:** README cost section names Vectorize queried dims as the binding limit with the
  arithmetic; per-search D1 numbers marked pending the Phase 1 deploy.
- Nothing deployed, no remote call, no migration change. The first remote ingest after 0006 is
  the forced full re-ingest (every `row_hash` NULL, every `text_hash` on the new formula): ADR
  0002's separate-UTC-day rule and headroom check apply.

## 2026-11-04 — Phase 1 1C: PR #13 review fixes

- Mass-delete guard counts the planned deletes (> 5% of D1's codes refuses), so a same-size
  corpus of other codes is refused; a corpus for another acad year than most of D1's rows is
  refused unless `--allow-year-change` (`/admin/hashes` returns `acadYears` counts).
- Vector metadata carries `textHash` (not indexed); the row-only path reuses stored values only
  when it matches and the dimension is 384, else re-embeds; verify compares it. Production
  vectors have none, so the planned forced re-ingest re-embeds everything as before.
- The last sent mutation id persists in `.data/ingest-state.json` (per `--url`) until a wait
  confirms it; a rerun with nothing to send waits for it before writing `data-version.json`.
- Schema guard requires all four 0006 triggers. `/admin/delete` clears the hashes before
  `deleteByIds`. The `.data/` sidecar records the body sha256; a mismatch forces a full GET.
- **Cold-load cost corrected:** ~48k table/index + 89,337 FTS5 shadow rows ≈ 137k written
  (`docs/evidence/phase1/fts-writes.mjs`), over the 100k/day cap. The budget now charges
  max(`meta.rows_written`, estimate with FTS); a cold load must not run remotely until remote
  FTS metering is measured. The forced re-ingest writes 0 FTS rows and is charged 37,251.
- CI: the full unicode61 separator probe gets a 60 s timeout (5.2 s on the runner).
- Nothing deployed, no remote call.

## 2026-11-04 — Phase 1 1C: PR #13 second review fixes

- **The FTS write charge follows the FTS triggers.** `/admin/hashes` returns `ftsHash` (code,
  title, description of the stored row, `src/rowhash.js`); the budget charges the FTS term only
  when it differs from the corpus's. `text_hash` still decides re-embedding. Against production
  (main's `hashOf(text)`, `row_hash` NULL) the old rule charged every row 21.5 and stopped at
  1,850 of 6,771 modules; the planned run is now charged 37,251 (local, `productionStart` in
  `test/full/ingest.test.js`) and finishes in one run under the 40k default.
- **The mutation wait cannot deadlock.** `/admin/ingest` and `/admin/delete` return `sentAt`
  (the Worker's `Date.now()` once Vectorize accepted the mutation); the state file stores it,
  and the wait also ends when `processedUpToDatetime` (ISO or number) is strictly later. README
  documents the manual way out for entries without `sentAt`.
- **One ingest at a time.** `.data/ingest-state.json.lock` (O_EXCL, pid; the refusal says
  whether the pid is alive); state writes use a per-process tmp file. A failed state write no
  longer kills the run: it finishes, exits 1, names the unrecorded mutation ids and does not
  write `data-version.json`.
- Nothing deployed, no remote call.

## 2026-11-04 — PR #13 third review fixes

- **Wait no longer ends on the run's own earlier mutation.** The pending entry carries
  `earlier` (this run's ids, after those of a carried-over pending entry); the
  `processedUpToDatetime > sentAt` check ignores them, so an undocumented "processed time"
  reading of that field cannot end the wait with the last batch still queued.
- **Run lock released on SIGINT/SIGTERM** (exit 130/143), and only while it carries this run's
  nonce, so a hand-deleted lock's old owner never removes the next run's.
- Nothing deployed, no remote call.

## 2026-11-04 — PR #13 fourth review fixes (last review round)

- **Retried mutating request → wait by id only.** A 5xx or dropped connection on
  `/admin/ingest` or `/admin/delete` may hide a queued mutation (the Worker mutates Vectorize
  before D1), so the run records `sentAt: null` from then on (re-recording the last id) and a
  rerun carrying that entry inherits it.
- **Signals stop the run cleanly.** First SIGINT/SIGTERM aborts: no new request, in-flight ones
  finish and are recorded, status `interrupted`, exit 130/143, lock released. A second signal
  forces exit.
- **Residual, accepted at the review cap:** a request whose every attempt fails after Vectorize
  accepted it, with no earlier mutation recorded in the run, leaves a hidden mutation no entry
  marks id-only; a forced second signal mid-POST can lose an id. Both need a failure plus a
  processing-time reading of `processedUpToDatetime`; the cost is a data version written while
  that mutation is still queued, caught by `npm run verify`.
- Nothing deployed, no remote call.

## 2026-11-03 (UTC evening) — Phase 1 remote ops: replication, 0006, deploy

- Headroom check, then: read replication `auto`; Time Travel bookmark; `d1_migrations`
  bootstrap + 0006 in one atomic import (**41,440 read / 14,108 written** vs 30,076 written
  estimated: D1 does not bill index entries separately); checks clean; facets row rebuilt via
  `wrangler dev --remote`; deployed `c2d37d5` as version `75ec8580` (rollback target
  `c6744373`); smoke test 4/4. Log: `docs/evidence/phase1/remote-ops.md`.
- Next: small-batch remote ingest, then the forced full re-ingest on 2026-11-04 late UTC.


## 2026-11-04 — Phase 2d: judging tooling (no judging run yet)

- `eval/JUDGING.md`: grades 0/1/2 against the intent narrative and constraints for an incoming
  exchange student, hard-constraint violations 0, worked examples from dev queries and real
  corpus courses, and the judge and adjudicator instructions that packets embed verbatim.
- `npm run eval:judge`: `prepare` (rule pre-grading, judge `rule`; per-judge packets of ~12
  queries with seeded shuffles, ~5% planted repeats, optional 5% drift sample), `collect`
  (validation, self-consistency, drift), `agree` (raw, Krippendorff ordinal α, binary κ ≥ 1,
  quadratic κ; overall and per shape), `adjudicate` (blind pass 1, then pass 2 with both
  grades), `merge` (`vnm-eval-qrels/1`, version bumped, a judges object per judgment,
  `moduleInfoSha256`), `calibrate export|import` (dev only, ~150 stratified pairs), `clean`.
  Encrypted sets: state and qrels only as ciphertext; packets in a 0700 `.eval-work/` directory
  until `clean`.
- `npm run eval -- --mode lexical|vector` runs one retrieval half (the Worker's own `mode`
  parameter, present at `eval-v0`), so the pool can be v0 hybrid ∪ lexical ∪ vector top-10.
- `npm run test:eval` now runs the whole judge → collect → agree → adjudicate → merge → report
  cycle on the fixture set and on an encrypted copy, with scripted judges and a throwaway key.
- No LLM, Cloudflare or live call; no holdout file decrypted. Next: the lead runs round r1 on
  dev, then holdout.


## 2026-11-04 (UTC morning): Jacob's decisions; Phase 1 forced re-ingest

- **Decisions (ADR 0004).**
  - The account is on Workers Paid. There is no daily D1 cap; the budget is the included monthly
    allowance, with no overage allowed. Vectorize queried dims, at ~123,400 uncached searches a
    month, stay the binding limit.
  - Relevance judging uses one judge, A (`claude-opus-5-5`); there is no judge B or adjudicator.
    Judge A finished round r1 on dev: 1,671 of 1,671 items, 80 of 80 planted repeats exact.
    The single-judge tooling is a separate PR.
- **Small batch:** 10 modules, 52 rows written (5.2 per module).
- **Forced full re-ingest** from the pinned snapshot: 6,771 upserted and embedded, 0 deleted,
  **34,383 rows written** (local 34,381), 2,395 neurons. Verify is clean. Data version
  `c25f43ebfbdb`. SC6 is measured (`docs/evidence/phase1/remote-ops.md`).
- **Finding.** The small batch's fresh fetch overwrote the pinned snapshot, because the ingest
  cache and `scripts/pinned-corpus.mjs` shared a path. The snapshot was restored from the release,
  and the cache moves to `.data/cache/` (PR #16).
- **Upstream changed.** NUSMods published a new catalogue at 05:35 UTC: 97 modules dropped, 104
  added, 302 changed. It lands as an incremental ingest after the second fidelity check.


## 2026-11-04 — Phase 2d: dev qrels v1 (single judge)

- Round r1 is now single-judge (ADR 0004). `drop-judge` removed judge B's 8 unjudged packets and
  recorded the reason. Judge A (`claude-opus-5-5`) graded 1,671 of 1,671 items; all 80 planted
  repeats got the same grade twice. That agreement is a floor on A's consistency, since the
  repeats sat in the same packets as their originals.
- `eval/dev/qrels.json` is `qrels-dev-v1`: 1,616 pairs over 94 queries (25 graded by the rule,
  1,591 by A), with grades 0/1/2 = 1,076 / 361 / 179. 83 queries are answerable. The other 4 dev
  queries have no pool: their runs return 400, because q is over 200 characters.
- Baseline on dev, primary answerable n = 78, judged@10 = 100% for all three runs:

  | run | nDCG@10 | P@5 | MRR@10 |
  |---|---|---|---|
  | v0 hybrid | 0.762 | 0.631 | 0.872 |
  | v0 lexical only | 0.648 | 0.495 | 0.800 |
  | v0 vector only | 0.723 | 0.603 | 0.848 |

  On the no-answer queries (n = 15), 0% come back empty, 11 return false positives and 4 return
  errors. Violations@10 total 12. EVAL.md's baseline table with CIs follows the holdout judging.
- Next: holdout judging (custodian, single judge); Jacob's human calibration export.


## 2026-11-04 — Phase 2d: holdout qrels v1 (single judge, custodian)

- **Store-only holdout runs.** The custodian stored `v0-lexical` and `v0-vector` holdout runs
  (`--store-only`, so no look; the ledger is unchanged). They pooled with `v0` (`--custodian`):
  1,319 documents over 81 queries.
- **Round h1.** Single judge, `claude-opus-5-5`, seed 20261105, 7 packets. The judges ran as
  in-process subagents, not T3 threads (Phase 2 plan, objection 14), and each read only its own
  packet.
  - Grading: 1,361 of 1,361 items; all 65 planted repeats got the same grade twice.
  - Merged into `eval/holdout/qrels.json.enc` (`qrels-holdout-v1`): 23 rule pairs and 1,296 pairs
    graded by A. Only ciphertext is committed.
  - The plaintext packets and outputs were deleted (`clean`).
- **Setting difference.** Dev judge A ran as a T3 delegate at medium effort. The holdout judges ran
  as in-process subagents at the session's default effort. Model, packet format and instructions
  are identical.
- **Next:**
  - EVAL.md baseline table with CIs. Dev is from `qrels-dev-v1`; the holdout verdict is spent only
    on Phase 3 candidates.
  - Jacob's calibration sheet (`.eval-work/calibration-dev.csv`, 150 pairs).
## 2026-11-04 — NUSMods catalogue update in production

- **Deployed** `8d94982` (version `78ef263b`) with the pinned data version `c25f43ebfbdb`. The
  second fidelity check made its live calls against it (PR #20).
- **Incremental ingest** of the 2026-11-04 catalogue: 406 upserted (194 re-embedded), 97 deleted,
  2,617 rows written. Verify is clean, and production holds 6,778 modules (data version
  `c1cf88518972`). The eval stays on the pinned 2026-09-04 snapshot. A new pin is needed before
  any further live fidelity check.


## 2026-11-04: SC7 FAIL; D1 primary moving to APAC

- **SC7 FAIL** (PR #23): p50 351 ms (CI 343–385, n = 33 SIN samples) against 250 ms.
  - Warm: an APAC replica serves D1, and the time goes to `vector` ~232 ms plus `embed` ~88 ms.
  - After a gap of ~6–10 min or more, after writes, or after a deploy: reads go to the WEUR
    primary, with fts plus hydrate about 800 ms.
- **D1 to APAC** (Jacob, ADR 0005). The new database `nusmods-apac` (APAC primary) is migrated,
  replicated, cold-loaded (6,778 modules, 47,981 rows written) and verified. It is identical to the
  old one on the checks run. The binding switch is in the next PR. The old `nusmods` database
  stays for rollback.
- SC7 still needs the warm path fixed: about 320 ms of embed plus vector. The candidate is
  in-Worker exact vector search, for Phase 3 planning.


## 2026-11-04 — Judge A calibration by model cross-check

- Jacob replaced human calibration with a model cross-check (ADR 0004 amendment).
- **Grading:** `gemini-3.8-flash-high` graded the 150 calibration pairs blind to A, then fresh
  Sonnet verifiers checked every grade and overturned 4.
- **Agreement with A:** verified grades raw 0.880, quadratic κ 0.915; Gemini alone raw 0.867,
  κ 0.893. A is slightly lenient on partial matches, and the Δ sign agrees.
- **Evidence:** `docs/evidence/phase2/calibration/`.
- **Process note:** the first Gemini run wrote all 150 rows in one reply and hit the 32k
  output-token cap. Batches of 30 work.


## 2026-11-04 — Duplicate groups and the Phase 2 baseline

- **Duplicate groups** (PR #28): `groups-v1` holds 509 groups built from public fields of the
  pinned corpus. Two kinds of group:
  - variant families: the same code stem and title;
  - cross-listings: the same title and description, where a placeholder description doesn't
    count.

  They are merged at scoring time for every set, with a corpus-sha guard. A returned member that
  violates a query's constraints leaves its group for that query. A fresh-context review found
  no defects. It rebuilt the groups byte-identical and fuzzed scoring with 20,000 random cases.
- **The dev baseline is now group-aware.** v0 hybrid: nDCG@10 0.758 [0.703, 0.804], P@5 0.608,
  MRR 0.872. Lexical alone 0.648, vector alone 0.715. Grouping lowered P@5 by 0.013–0.031 on
  each run.
- **EVAL.md** has the Phase 2 baseline section: CIs, paired Δ against both halves, judged@10,
  the cross-family κ and the holdout status. It is generated by
  `docs/evidence/phase2/baseline-table.mjs`.
- **Next:** the Phase 2 exit red-team. Phase 3 plan r2 is being revised after the round-1
  critics: 3 critics, 19 blocking objections, PR #27.


## 2026-11-04 — Phase 2 exit: code-target rule grades (qrels v2)

- **Finding (exit red-team).** Five dev code queries had no pooled target: `d-087` "cn 2109",
  `d-089` "is 4246", and the partials `d-090` "MUL21", `d-091` "DAO17" and `d-092` "GEC". They
  scored as no-answer. Emptying them in v0 passed `--change-kind cutoff`, with correct-empty
  going from 0 to 0.333.
- **Fix.** `eval/lib/code-rule.mjs` applies JUDGING.md rule 4 mechanically as judge `rule`. It
  grades from public corpus fields, pooled or not, and replaces A's grade where one exists.
  `merge` applies it, and so does `npm run eval:judge -- code-rule`.
  - `qrels-dev-v2`: 56 rule pairs over 11 queries (50 new). It overrode 6 A grades, all
    unchanged.
  - `qrels-holdout-v2`: 15 rule pairs over 4 queries (14 new). It overrode 1 A grade, unchanged.
    The command printed counts only and took no look.
- **Dev v0, v1 → v2.**
  - Primary answerable n: 78 → 83. No-answer n: 15 → 10.
  - nDCG@10: 0.758 → 0.712. P@5: 0.608 → 0.571. MRR@10: 0.872 → 0.820.
  - The same five-query emptying now fails the cutoff gate: correct-empty stays at 0 over 10
    no-answer queries.


## 2026-11-04 — Phase 2 exit; Phase 3 plan converged

- **Phase 2 exit red-team.** Every baseline figure reproduced from a clean clone. Three findings
  blocked the exit, and three were custody or gate gaps. All six are fixed:
  - **#29:** EVAL.md labels the baseline as the offline replica, and the reproduce block is
    corrected.
  - **#30:** the code-target rule grades. Five answerable code queries had been scored as
    no-answer, and emptying them passed the cutoff gate. The changes:
    - `qrels-dev-v2` and `qrels-holdout-v2` (the holdout only by counts, with no look);
    - dev v0 hybrid reads nDCG@10 0.712 [0.644, 0.770] over 83 answerable queries.
  - **#32** (replaces #31, which GitHub could not reopen during an outage). Six refusals:
    - a cutoff must truncate the baseline;
    - the rule applied and the baseline ranker sha are recorded in the ledger;
    - the baseline must be `eval-v0` (filtered, hybrid, clean runner);
    - a manifested run is never overwritten without `retire-run`;
    - every ciphertext a verdict reads must match its manifest;
    - judge merges record only the file they write.
- **Phase 2 passed.** Holdout looks so far: 0 of 12.
- **Phase 3 plan converged at r3.1** (#27; ADR 0006), after three critic rounds. Round counts:
  - Round 1 raised 41 objections and round 2 raised 33.
  - Round 3 raised 8 blocking and 18 non-blocking objections, all applied without a further
    pass.
  - Four are recorded as dissent.
  - Jacob's answers to Q1 (SC5 set), Q2 (VPN for the counted SC7 run) and Q4 (failed
    SC4-required changes) are due before the first holdout look.

## 2026-11-06 — 3-0 live; Phase 3 gate answers

- **Jacob's answers:** the sealed test set decides SC5 (Q1); the counted SC7 run is VPN off
  (Q2); a failed SC4-required change goes to Jacob, as written (Q4). Recorded in ADR 0003,
  ADR 0006 and plan §10 (#33).
- **Gate rules merged (#34):** no-answer is tagged AND has no grade-≥1 judgment; change kinds
  `no-loss` and `answerable-floor`; `--gate sc5` only at L12; `eval:count`; split baseline
  pins.
- **3-0 live (#35, #36):** in-Worker exact vector search, version `343ea371` (tag `e8a7124`).
  Runbook steps 1–8 ran; D1 needed no write; Vectorize is a level standby. Rollback:
  `npx wrangler rollback ee96bbd0-add9-4aa6-8f2f-78e219087817`.
  - Warm server `total` p50 131 ms, down from 332 ms.
  - CPU p50 9.1 ms per request; CPU is now the binding allowance at ~2.5M requests a month.
  - Startup time was not recorded.
- **Shipped-ranker pin** moves to `e8a7124`. Holdout looks so far: 0 of 12.
- **Next:** P-6, the pre-registration commit; then L1 (3A-1).

## 2026-11-06 — P-6 pre-registration

- **P-6 merged (#38):** `docs/plans/phase3-prereg.md` and `eval/prereg/` fix every grid, list,
  threshold and rule before any 3B–3H code or holdout look. That covers the 90-item SC4 suite
  (`test/sc4/queries.json`, sha-pinned), the 40-string gibberish set and its seeded split.
  - T = 5: the minimum oracle overlap@10 over the 6 dev typo pairs.
  - M = 3.
  - The collision list is completed by a stated rule over all 241 off-list prefixes, now 116
    entries.
- **Review:** a fresh-context reviewer found that the suite's tests checked shape, not meaning.
  Consistency tests now catch all six of its mutations. It also found that the guard count rule
  was vacuous: two of P-6's own guards now use the `cs` and `lsm` department tokens. The d-025
  gibberish shape is excluded, with its reason logged.
- **Embeddings:** 156 query forms, ~1.8 neurons (`requests.tsv` row 78). No text is a
  near-duplicate of a dev text.
- **Custody:** the holdout check (`eval/prereg/sc4-custody.mjs`) found 0 hits over 147 texts. Its
  dev self-check hits 5. Holdout looks so far: 0 of 12.
- **Next:** L1, 3A-1 (query instruction prefix), against the shipped pin `e8a7124`.

## 2026-11-06 — 3A-1 dropped at the dev screen

- **3A-1** (bge query instruction prefix, draft PR #39) fails the dev screen. ΔnDCG@10 is
  +0.005 [−0.016, 0.029] against the shipped ranker under `qrels-dev-v3`, with every pair judged.
  It has no named retry and SC4 does not require it, so it is dropped. **No holdout look is
  spent:** 0 of 12, and the reserve gains the L1 slot.
- **qrels-dev-v3:** judging round `p3a1` (judge A, 108 pooled documents plus a 5% drift sample;
  drift agreement 0.911). Two more queries are answerable, and the shipped ranker reads
  nDCG@10 0.688 over 85 queries.
- **Embedding:** 6.0 neurons for prefixed dev and fixture queries (`requests.tsv` rows 79–80).
  One fixture attempt crashed with its output lost, so ≤ 1 request may be unlogged.
- **Holdout:** the shipped ranker's holdout run is stored (no look) as L2's baseline.
- **Next:** 3A-2, the three embedding-text variants. Each needs a full pinned-corpus embedding
  pass (~2.4k neurons each, at most 2 a UTC day).

## 2026-11-07 — 3A-2 passes L2 (holdout look 1 of 12)

- **3A-2 v1** (embedding text `CODE. Title. Level N (label). Description. Department. Faculty.`)
  is selected on dev. ΔnDCG@10 is +0.057 [0.027, 0.109] against the shipped ranker under
  `qrels-dev-v4`. v2 also passes and is the named retry; v3 fails
  (`docs/evidence/phase3/3a2-dev-screen.md`).
- **Cross-family check:** Gemini grades, verified by Sonnet, on 435 of 519 pairs. Chunk 6 was
  rate-limited, and Jacob accepted the 84%. Agreement with A is 0.936 (κ quadratic 0.892). The
  verified-grade Δ sign is +, matching A's. Resampling chunk 6 never turns it (P(Δ ≤ 0) = 0 in
  4,000 draws). A targeted worst case of 7 grades would.
- **L2:** v1's holdout run was stored and pooled with `run-shipped-e8a7124` (149 documents).
  Round `h2` (judge A) merged as `qrels-holdout-v3`. Verdict: **pass** under the holdout
  general rule (point estimates ≥ 0). ΔnDCG@10 is +0.038 [−0.007, 0.092] and ΔP@5 +0.037
  [−0.003, 0.085]. **Holdout looks: 1 of 12.**
- **Next:** ship v1 by the runbook. Make `emb-bge-small-v1` the default embedding, then the
  production bundle, a D1-only ingest, the standby upsert, the shipped-pin move and PR #41 ready.

## 2026-11-07 — 3A-2 v1 shipped

- **Live:** version `8d1b85be-edd1-4e6c-902d-ea1ece96a0d1` (tag `45bd716`, PR #41), data version
  `32b590de51aa`, production bundle `emb-bge-small-v1-x4a990cd5` (6,778 rows). The runbook ran
  steps 1–8 (`docs/evidence/phase3/remote-ops.md`).
  - D1-only ingest: 34,425 rows written, 0 neurons.
  - Smoke: 3 calls, all 200 through SIN.
  - Standby: 6,778 upserts. D1 and Vectorize agree, including a 100-row values sample.
- **Shipped-ranker pin** moves to `45bd716` (ADR 0003). The next look's baseline is its holdout
  run, which the custodian stores before that look.
- **Tests:** look-taking test clones now start from an empty committed ledger, not this
  checkout's. Their throwaway commits and tags are not GPG-signed.
- **Rollback target:** `343ea371` (tag `e8a7124`), plus the D1 bookmark in `remote-ops.md`.
- **Next:** 3B (codes, GE pillars, keyword brittleness), L3.

## 2026-11-07 — 3B passes L3 (holdout look 2 of 12)

- **3B** (PR #44: code joins and resolution, partial-code and GE masks, the third RRF list,
  `noMatch`, `catalogue_only`) passes dev under the targeted rule. ΔnDCG@10 is +0.049
  [0.017, 0.108] under `qrels-dev-v5`: code-space +0.54, code-partial +0.28, GE +0.30,
  abbreviation 0.
  - **stopwords-v2** fails dev alone (Δ 0.000), so it is dropped.
  - **Gate amendment:** the abbreviation tripwire failed as degenerate when every query moved by
    exactly 0. Jacob amended the rule for every change (ADR 0003, PR #45).
- **L3:** pass. ΔnDCG@10 is +0.013 [0.003, 0.050] and ΔP@5 +0.003 [0.000, 0.017]
  (`qrels-holdout-v4`). **Holdout looks: 2 of 12.**
- **Next:** ship 3B. That means migration 0008 on remote D1, an ingest that loads
  `catalogue_only`, the deploy, the smoke test, the shipped-pin move and the baseline holdout run.

## 2026-11-07 — 3B shipped

- **Live:** version `8e743876-6361-4db6-91a4-8bf951d76e7f` (tag `ad8e10c`, PR #44).
  - Migration 0008 is applied to remote D1, and `catalogue_only` holds 14,430 rows (28,860 rows
    written).
  - The data version and the vectors are unchanged, so the standby was not touched.
  - Smoke: 4 calls (`remote-ops.md`).
- **Shipped-ranker pin** moves to `ad8e10c` (ADR 0003).
- **Rollback target:** `8d1b85be` (tag `45bd716`).
- **Next:** 3C (typos and prefixes), L4.

## 2026-11-07 — 3C passes L4 (holdout look 3 of 12)

- **3C** (PR #47): prefix terms for df-0 tokens, then OSA correction, with the original kept.
  Both variants pass dev and the SC4 typo rule under `qrels-dev-v6`:
  - 3C-1: ΔnDCG@10 +0.016 [0.005, 0.043], typo +0.162.
  - 3C-2: +0.036 [0.012, 0.085], typo +0.390.

  **3C-2 is selected**, and 3C-1 is the named retry.
- **L4:** pass. ΔnDCG@10 is +0.006 [−0.002, 0.019] and ΔP@5 +0.020 [0.006, 0.045]
  (`qrels-holdout-v5`). **Holdout looks: 3 of 12.**
- **Embeddings:** 1.7 neurons for 3C-2's corrected forms (`requests.tsv` 87–88).
- **Next:** ship 3C. A deploy only: the vocabulary is a committed Worker module, and there is no
  migration and no data-version change.

## 2026-11-07 — 3C shipped

- **Live:** version `c402a75d-d165-4c69-b7c1-4f5d1df24fb9` (tag `89cb10e`, PR #47). A deploy only:
  no migration, no ingest, no data-version change, the standby untouched.
  - Smoke: 4 calls, a typo and a prefix query among them (`remote-ops.md`).
- **CI caught a test that assumed `.eval-work/` exists** (absent on a fresh checkout). Fixed in the
  PR before merge.
- **Shipped-ranker pin** moves to `89cb10e` (ADR 0003).
- **Rollback target:** `8e743876` (tag `ad8e10c`).
- **Next:** 3D (level intent; cross-family check required).

## 2026-11-07 — 3D passes the dev screen

- **3D** (level intent): level phrases become hard windows (beginner 1–4, graduate 5+, level N,
  year N–4). Phrases are negated by `not`/`non`/`except`/`beyond`, matched leftmost-longest
  alongside GE, combined as a union, and undone by `ignore=level`. Two priors follow fusion: α for
  beginner queries and β for level 5+ when no level intent is parsed (`src/level-prior.js`).
- **Selected: the bundle, rules + α 0.35 + β 0.1.** On dev, ΔnDCG@10 is +0.005 [−0.007, 0.015],
  and the level target gains +0.036 (targeted pass). SC4 passes 73 of 73; sc4-031 waits for 3H.
- **The named retry `a0` (the rules alone) fails the dev screen:** its level-target tripwire
  trips. A failed L5 therefore goes to Jacob (Q4).
- **No cross-family check.** Gemini was rate-limited on all three attempts; Jacob signed off on
  skipping it (ADR 0004 deviation).
- **qrels-dev-v7** (`p3d`). Evidence: `docs/evidence/phase3/3d-dev-screen.md`.
- **Next:** L5.

## 2026-11-07 — 3D fails L5 (holdout look 4 of 12)

- **L5:** fail. ΔnDCG@10 is −0.005 [−0.020, 0.004] and ΔP@5 −0.020 [−0.045, 0.003]
  (`qrels-holdout-v6`). **Holdout looks: 4 of 12.**
- **The named retry `a0` fails the dev screen**, so the next step is Jacob's (Q4).
- **Diagnosis (dev only):** the bundle misreads `intro` inside pasted course descriptions (d-073,
  d-017), and α then buries the exact match. Candidate `3d-r2` reads level phrases only in queries
  of at most 12 tokens. On dev, ΔnDCG@10 is +0.009 [0.003, 0.020], and the level target keeps its
  +0.036. It waits on Jacob before any reserve look.

## 2026-11-07 — 3D dropped for Phase 3 (holdout looks 5 of 12)

- **Retry look on `3d-r2`** (the bundle plus the 12-token rule, Jacob's go): fail. ΔnDCG@10 is
  −0.004 [−0.019, 0.004] and ΔP@5 −0.017 [−0.042, 0.003]. **Holdout looks: 5 of 12.**
- **3D is dropped for this phase** (Jacob's decision before the look). PR #49 closes unmerged;
  `level-intent-3d` keeps the code for Phase 4.
- **SC4's level items stay unmet** until Phase 4's study-level input.
- **Next:** 3E (RRF weighting; cross-family check in scope).

## 2026-11-07 — 3E dropped at the dev screen (slot unspent)

- **3E** (weighted RRF, 8 grid points): only (w_v 2, k 20) passes dev, at +0.017 [0.001, 0.036].
  It fails SC4 guard sc4-085 (6 CS modules in the top 10 for "psychology electives for cs
  majors"; the limit is 2). The runner-up (1.5, 20) fails dev, so no point is eligible.
- **3E is dropped and the shipped fusion stays.** L6 joins the reserve, and `rrf-weighting-3e`
  keeps the code.
- **qrels-dev-v8** (`p3e`). Evidence: `docs/evidence/phase3/3e-dev-screen.md`.
- **Holdout looks: 5 of 12.** Next: 3F (near-duplicate collapse, no look).

## 2026-11-07 — 3F shipped (no look)

- **3F** (near-duplicate collapse): each groups-v1 group keeps its first-ranked member, and the
  other members that pass the filters ride along as `variants`. The gate passes:
  - identity with the group-first projection on dev and the fixture;
  - dev ΔnDCG@10 +0.009 [0.005, 0.016] (`no-loss`).
- **Live:** version `6e832483` (tag `2ce17c6`). Evidence: `docs/evidence/phase3/3f-dev-screen.md`.

## 2026-11-07 — 3G shipped (no look)

- **3G** ("no matches"): `/search` answers `count: 0`, `noMatch: { reason: "no-signal" }` when
  three conditions hold: no route fires, no token is known, and the top exact cosine is below
  τ = `max` (0.6013).
- **The gate passes:**
  - 18/20 of the gate half return count 0;
  - no untagged dev query is emptied;
  - dev answerable Δ is +0.000;
  - SC4 passes 92/92.
- **Live:** version `f638992b` (tag `47838db`). Evidence: `docs/evidence/phase3/3g-gate.md`.

## 2026-11-08 — 3H-0 shipped (data only, no ranking change)

- **3H-0** stores the intent fields (migration 0007, `NORMALISER_VERSION` 2, bundle schema
  `vnm-vectors/2`): exam semesters, S/U, grading basis, workload hours, no-prerequisite and
  cohort-only prerequisite. All 98 dev lists equal shipped's.
- **Live:** version `0173bddf` (tag `f004351`), data version `4b6d12fab3d3`. Evidence:
  `docs/evidence/phase3/3h-0.md`.

## 2026-11-08 — 3H query side: (ii)-stripped to L7 (deviation)

- **3H** parses no-exam, S/U, workload and no-prerequisite phrases as hard filters, strips them
  from the keyword query, echoes them in `interpreted`, and accepts the explicit
  `exam`/`su`/`hoursBelow`/`prereq` params.
- **Selected: (ii) NULL-or-cohort-only, dense query stripped.**
  - **Selection:** raw's constraint-block gain (+0.018) is short of the 0.05 margin. On the
    prereq queries, (ii)'s mean Δ is −0.075 against (i)'s −0.299.
  - **Dev screen:** it fails no-loss by −0.0044. The whole loss is d-011 and d-099, whose
    relevant modules mostly have prerequisites the filter removes.
  - **Other checks:** SC4 passes 75/75, and all 88 no-intent queries keep their top 10.
- **Jacob sent it to L7 anyway** (ADR 0006 deviation). The named retry stays (i)-stripped,
  which passes SC4 and passes the screen with d-011 and d-099 exempt.
- **qrels-dev-v10** (`p3h`). Evidence: `docs/evidence/phase3/3h-dev-screen.md`.
- **Holdout looks: 5 of 12.** Next: L7.

