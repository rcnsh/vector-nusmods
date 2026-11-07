# Findings

Phase 0 triage of every §4 finding ID in [`CRITERIA.md`](CRITERIA.md). Each claim was checked
against `main` at `7ac9841` (production runs `3b18041`; `src/` is identical). The status set is
closed: `reproduced | partially-reproduced | rejected | fixed`. Line references of the form
`src/index.js:N` point at `7ac9841`; Phase 1 split that file into `src/*.js` modules.
`npm run check:findings` (`scripts/check-findings.mjs`) fails CI if an ID is missing, has
another status, or a reproduced/fixed finding names evidence that does not exist.

**Evidence kinds**
- **Tests** are characterisation tests named `[<ID> known-bug] …`: plain `it`, asserting the
  current wrong behaviour, so each one fails the moment the bug is fixed and must then be
  rewritten to assert the fix (see PLAN.md). `[<ID> evidence]` tests pin data facts a finding
  rests on. Worker tests run in workerd over the 400-module fixture (`test/fixtures/corpus.json`)
  with the fakes in `test/fakes.js`; `*.node.test.js` run in Node; `test/full/` runs over the
  full pinned corpus (6,771 modules) in the `full-corpus` CI job.
- **Live evidence** is the 0b run against production on 2026-11-03, in `docs/evidence/phase0/`
  (`raw/<ID>_*.body|headers` from curl; `fe-results.json`, `axe-1280-*.json`, `shots/` from
  Playwright). Every live call is logged in `docs/evidence/requests.tsv`. No live call was made
  for this triage. "Server time" below is curl `ttfb − tls`, which still includes one round trip.

## Summary

| ID | Status | Evidence |
|---|---|---|
| B1 | fixed | tests (fixture + full corpus, property test), live (PR #8) |
| B2 | fixed | tests (hash rules, skip, deletes, cache, budget, verify, full-corpus cost) |
| B3 | fixed | tests (EXPLAIN QUERY PLAN, trigger fuzz, cost) (PR #8) |
| B4 | fixed | tests (concurrency, differential), live latency |
| B5 | fixed | tests, live |
| B6 | fixed | test |
| B7 | fixed | test, live |
| B8 | fixed | tests, live |
| B9 | fixed | test (README arithmetic) |
| S1 | reproduced | test (source + EVAL.md) |
| S2 | reproduced | live |
| S3 | reproduced | tests |
| S4 | reproduced | tests, live |
| S5 | reproduced | tests, live |
| S6 | reproduced | live, full-corpus test |
| S7 | reproduced | tests |
| S8 | reproduced | tests, live |
| P1 | reproduced | tests, live |
| P2 | partially-reproduced | tests, live |
| P3 | reproduced | test |
| F1 | reproduced | test, Playwright |
| F2 | reproduced | test |
| F3 | reproduced | test, Playwright |
| F4 | reproduced | test |
| F5 | reproduced | test, Playwright, axe |
| F6 | reproduced | test, axe |
| F7 | reproduced | test, live |
| F8 | reproduced | test |
| F9 | reproduced | test |
| F10 | reproduced | test, Playwright, screenshot |
| V1 | partially-reproduced | test, screenshots |
| O1 | fixed | test, `db:rebuild-check` (PR #1) |
| O2 | fixed | test, CI (PR #1) |
| O3 | fixed | test |
| O4 | reproduced | tests |

Checked and **not** findings (noted, no ID): the `/search` cache does work on workers.dev
(`raw/B7conn.headers`: `cf-cache-status: HIT` on an identical repeat); the 87 s page load was
the network, not the Worker.

## Backend and data

### B1 · Semester filter drops keyword results

**Status:** fixed

**Claim:** FTS runs with `LIMIT 4 × depth`, then the semester filter runs in JS, so
`q=management&sem=3&mode=lexical` returns 6 when about 31 match.

**Evidence:**
- test `[B1 fixed] lexical management&sem=3&topK=50 returns all 31 sem-3 keyword matches, in rank order` (`test/full/findings.test.js`): over the full pinned corpus the search now returns all 31, equal to brute force, including the 6 production returned.
- test `[B1 fixed] lexical sem=3 returns the sem-3 "management" matches however many sem-1 matches outrank them` (`test/findings/b1.test.js`): 20 strong sem-1 decoys + 3 sem-3 targets, `topK=1` → the top target (was 0 results).
- test `[B1 fixed] hybrid sem=3 finds the targets through both halves`
- test `filtered lexical equals brute force on a grid of single, two- and many-filter searches, and costs <= 8,000 rows read` (`test/full/lexical.test.js`): 419 queries (`test/fixtures/lexical-queries.json` plus broad ones) × every single filter value (62), plus 12 broad queries (> 2,000 matches each) × every two-filter combination (1,263) and 412 three-to-five-filter combinations, plus depths 3 and 15 for the selective values: 46,078 depth-50 searches, every result equals all matches ranked by bm25 then filtered; worst 7,772 rows read.
- test `without a driver, SQLite drives faculty+credits from the credits index (the bug)` (`test/lexical-driver.test.js`), and the parametrised tests after it: with a driver the plan walks only that filter's index; `chooseDriver` picks the filter with the fewest rows (counts in `meta('facets')`), not the index SQLite picks by creation order.
- `docs/evidence/phase1/lexical-cost.md`: rows-read distribution of that grid.
- Before the fix: `docs/evidence/phase0/raw/B1_sem3.body`, live `count: 6` (BMC5415, TCX2003, BME5042, BMA5134, TCX2005, BME5046).

**Notes:** Fixed by PR #8. Filters now run in SQL (`src/lexical.js` `runFts`) against
VIRTUAL generated columns `sem1..sem4` (and `ng_sem1/2`) added by
`migrations/0006_fts_external.sql`, after a bounded FTS top-N (`LIMIT 2000` by rank). When that
bound may have cut matches (fewer than `limit` survivors and more than 2,000 matches), a
filter-driven plan walks the indexed filtered rows and probes FTS5 by rowid, so recall is exact
and a search reads at most ~2 × 2,000 + 2,001 + the walk; the walk goes through the index of
the active filter with the fewest rows (per-value counts in `meta('facets')`, other filters
written `+m.col`). Unfiltered queries keep the old
top-N SQL. Was: cause `src/index.js:223` (`bind(...binds, limit * 4)`) then `:226` (sem filter
in JS).

### B2 · Re-ingest misses field changes; nothing deletes; cache never expires; acad_year ignored

**Status:** fixed

**Claim:** Ingest hashes only the embedded text (title/department/faculty/description), so
changes to semesters, NG flags, credits and prereqs never land; nothing deletes dropped
modules; the `.data/` download cache never expires; `/search` ignores `acad_year`.

**Evidence:**
- test `[B2 fixed] row_hash changes with semesters, credits, workload, prerequisite, preclusion, NG flags and acad year; text_hash does not` (`test/findings/ingest.node.test.js`)
- test `[B2 fixed] text_hash is the hash of the model id, the embedded-text version and the text`
- test `[B2 fixed] row_hash is the hash of the normaliser version, the exact bound tuple and the vector metadata, and is recomputable from the stored row`
- test `[B2 fixed] the skip rule: text changed re-embeds, only the row changed re-upserts without embedding, unchanged is skipped`
- test `[B2 fixed] /admin/hashes returns text_hash, row_hash and the FTS-column hash for every module` (`test/findings/b2.test.js`)
- test `[B2 fixed] a field-only change (semesters, NG flags, credits, prereqs, workload) lands in D1 and the Vectorize metadata, without re-embedding`: through `runIngest` and the real routes; `/module` and the `sem` filter see the change, the vector keeps its values, Workers AI is not called, and a rerun sends nothing.
- test `[B2 fixed] a module dropped from the corpus is deleted from Vectorize, then D1`
- test `[B2 fixed] acad_year: rows are keyed by code, so a run leaves only the current year (stale rows deleted or rewritten)`
- test `[B2 fixed] an entry older than --max-age is revalidated with If-None-Match, and a 304 keeps the cached body` (`test/findings/ingest.node.test.js`), and the four cache tests after it (200 replaces body and sidecar; a fresh entry is used without a request; `--offline`; an entry with no sidecar).
- test `cold ingest, forced full re-ingest (SC6), no-op rerun, field-only change, 10 deletes, verify` (`test/full/ingest.test.js`): over the full pinned corpus, a forced full re-ingest reads 35,079 rows (SC6 gate < 500,000) and writes 34,381 by the budget's count; 25 field-only changes land with no embedding; 10 dropped modules leave both stores; verify agrees. Costs and estimates: `docs/evidence/phase1/ingest-cost.md`.
- test `reports missing and extra vectors` (`test/verify.test.js`), `reports metadata drift in the sample`, `reports a row whose stored row_hash no longer matches its columns, and a row with none`: `npm run verify` (`scripts/verify.mjs`) exits non-zero on each.
- PR #13 review fixes (`test/ingest.test.js`, `test/verify.test.js`): test `[PR13 #1a] refuses when the deletes exceed 5% of D1, even when the corpus is as large as D1`, `[PR13 #1b] refuses a corpus for another acad year than D1 holds unless allowYearChange; /admin/hashes reports the year`, `re-embed when the stored vector is not for this text_hash, so an old embedding never overwrites a new one`, `[PR13 #2] reports a sampled vector whose metadata textHash is not the row's text_hash, or has none`, `leaves the module re-embedded when it comes back: hashes are cleared before Vectorize deletes`.
- test `refuses a corpus below 95% of the D1 count unless allowMassDelete` (`test/ingest.test.js`), `run only when no upsert batch failed`, `stops cleanly before a batch would exceed it, never exceeds it, and a rerun resumes through the hash skip`, `reports done only once describe() has processed the last mutation, polling on that state`, `refuses a database without migration 0006, and /admin/hashes says what is missing`.

**Notes:** Was: hash input `scripts/lib.mjs:94-101` (`embeddingText`) and `:163` (`textHash:
hashOf(text)`); skip predicate `scripts/ingest.mjs:61`; cache read with no age check
`scripts/lib.mjs:39-44`; no `acad_year` predicate in `runFts` or `fetchRows`.

Fixed in workstream 1C (plan "Ingest (changes vs r1)"). `text_hash` = hash(model id +
embedded-text version + text) (`scripts/lib.mjs`); `row_hash` = hash(normaliser version + the
exact tuple `/admin/ingest` binds + the Vectorize metadata) (`src/rowhash.js`, shared by the
Worker and the scripts; the Worker stores the hash of what it actually binds).
`/admin/hashes` returns both. `scripts/ingest-core.mjs` plans each module: text changed →
re-embed and upsert vector and row; only the row changed → rewrite the row and re-upsert the
vector with its stored values (`getByIds`) under new metadata, embedding only if the vector
is missing or its `metadata.textHash` is not the module's (a deviation from r1's "re-embed,
cheap": same vector, no neurons; the textHash check stops stale values from a lagging
Vectorize overwriting a pending new embedding); unchanged → skip. Codes D1 holds and the
corpus lacks are deleted through the new authenticated `/admin/delete` (hashes cleared, then
Vectorize `deleteByIds`, then D1), last, and only when no upsert batch failed. A plan that
deletes more than 5% of D1's codes, or a corpus for another acad year than most of D1's rows,
aborts the run before any write unless `--allow-mass-delete` / `--allow-year-change`. The
`.data/` cache keeps `ETag`/`Last-Modified` and the body's sha256 in a `<entry>.cache.json`
sidecar and revalidates entries older than `--max-age` (24 h) unless `--offline`.

The acad_year sub-claim needs no query-time fix: one database holds one acad year by
construction, because rows are keyed by `code` alone. A run refuses a corpus that mixes acad
years; a code that left the corpus is deleted with its old-year row, and a code offered in both
years is one row whose `row_hash` (which includes the acad year) differs, so it is rewritten
with the current year. After a finished run every row carries the corpus's year (tested), so
an `acad_year` predicate in `/search` would only add a column read per row. Between a failed
run and its rerun, old-year rows can still be served.

### B3 · FTS triggers delete by an UNINDEXED column

**Status:** fixed

**Claim:** The FTS update/delete triggers delete by UNINDEXED `code`, so every row change scans
the whole FTS table.

**Evidence:**
- test `[B3 fixed] the FTS triggers address the index by rowid: no full FTS scan, constant cost per row` (`test/findings/backend.test.js`): every statement in every trigger body plans without a SCAN; a title update reads < 10 rows (was 401 on the fixture).
- test `stays equal to a fresh rebuild under random inserts, upserts, updates and deletes` (`test/fts.test.js`): `integrity-check` passes and MATCH equals a fresh `'rebuild'`.
- test `a no-op re-ingest of every row writes nothing to the FTS index` (`test/fts.test.js`)
- test `[B3] a forced full re-ingest writes nothing to the FTS index; one title change reads a handful of rows` (`test/full/lexical.test.js`)
- `docs/evidence/phase1/0006-cost.md`: 0006 and re-ingest costs on the full corpus.

**Notes:** Fixed by PR #8. `migrations/0006_fts_external.sql` rebuilds `modules_fts` as an
external-content table (`content='modules'`, `content_rowid='rowid'`); triggers use the FTS5
`'delete'` command keyed on `old.rowid`, and the update trigger fires only when `code`, `title`
or `description` actually change. Was: `migrations/0002_fts.sql:5` (`code UNINDEXED`) and the
triggers at `:15-21`; a full re-ingest read ~46M FTS rows. `INSERT OR REPLACE` on `modules` would
corrupt the external-content index; `test/migrations.node.test.js` fails if any code uses it.

### B4 · Request path is fully serial

**Status:** fixed

**Claim:** pin → embed → Vectorize → FTS → hydrate run one after another; measured server
time hybrid ~540 ms, `/module` ~240 ms.

**Evidence:**
- test `[B4 fixed] with Workers AI hanging, the pin and lexical queries still start before the embedding resolves`
- test `[B4 fixed] pin, lexical and embed -> Vectorize run concurrently, then one hydrate query, all on a read session`: with the embedding held back, the FTS (and pin) statements have already been issued and nothing is hydrated; once it is released, exactly one hydrate query follows, and every statement ran on a `withSession('first-unconstrained')` session.
- test `[B4 instrumented] /search responses carry Server-Timing spans for each stage`: flipped from the Phase 0 characterisation test that asserted there was none; `test/instrument.test.js` covers misses, hits, errors and the log line
- test `1B is ranking-neutral` (`test/differential.test.js`): 522 generated requests through the pre-1B route and the new one give identical bodies.
- `docs/evidence/requests.tsv` rows 4–9 (`raw/B4_search_*`, `raw/B4_module_*`): hybrid cache-miss `ttfb−tls` 932 / 1427 / 1411 ms; `/module/CS3244` 242 / 387 / 716 ms.

**Notes:** The serial structure was reproduced exactly (`src/index.js:304-367` at `7ac9841`);
the latency figures only partly (hybrid measured 0.9–1.4 s, not ~540 ms, with no
`Server-Timing` to separate server from network time). Phase 1 step 0 added the spans.

Fixed in PR #7 (workstream 1B): `runSearch` in `src/search.js` starts the pin lookup, the
lexical query and embed→Vectorize together and waits on all three (`Promise.all`), then runs
one hydrate query for only the columns and rows the response renders. Every public D1 read
(`/search`, `/module`, `/facets`) goes through `env.DB.withSession('first-unconstrained')`,
which works with or without read replication; admin routes stay on `env.DB` (primary).
Vectorize is asked for ids only (`returnMetadata` dropped); depth stays 50. Enabling read
replication itself (ADR 0002) and the deployed SC7 measurement are separate Phase 1 steps.

### B5 · No upstream timeouts, no top-level try/catch

**Status:** fixed

**Claim:** No upstream timeouts and no top-level try/catch; `/module/%E0%A4%A` → error 1101.

**Evidence:**
- test `[B5 fixed] /module/%E0%A4%A is a 400 naming the bad encoding, not an exception out of fetch`
- test `[B5 fixed] a hanging %s call times out at 1.5 s and the search answers keyword-only` (run for `ai` and `vectorize`): still pending at 1.35 s, settled by 1.7 s, 200 with `degraded.reason: "timeout"`.
- test `[B5 fixed] a hanging D1 query times out at 3 s with a 502 naming D1`
- test `[B5 fixed] a throwing rate limiter fails open, and the failure is logged`
- test `[B5 fixed] an exception no route handles is a JSON 500 carrying the request id, and is logged`
- `docs/evidence/phase0/raw/B5_module.headers`: live `HTTP/2 500`, `text/plain`, body `error code: 1101` (before the fix).

**Notes:** Was: `decodeURIComponent` outside any try, no catch in `fetch()`, no timeout on
AI or Vectorize (`src/index.js:461`, `:583-628`, `:329`, `:336` at `7ac9841`). `/search` with
the same bytes did not crash: `URLSearchParams` decodes leniently to U+FFFD.

Fixed in PR #7: `fetch` catches anything a route throws and answers
`500 { "error": "internal", "requestId" }` (the `cf-ray`, else a random UUID), logged as
`"event":"unhandled"`. `/module` guards `decodeURIComponent` (400). `src/upstream.js`
races every Workers AI (1.5 s, also aborted through its `signal` option), Vectorize (1.5 s)
and D1 (3 s) call against a timer. The rate limiter call fails open and logs
`"event":"limiter_error"`.

### B6 · No keyword fallback when AI or Vectorize fails

**Status:** fixed

**Claim:** A Vectorize/AI failure fails the whole search; there's no keyword fallback.

**Evidence:**
- test `[B6 fixed] %s throwing in hybrid mode returns the keyword results, flagged degraded and cached for 60 s` (run for `ai` and `vectorize`): 200, `degraded: { source, reason: "error" }`, the same codes as `mode=lexical`, `cache-control: public, max-age=60`, `Server-Timing` span `degraded`, and the log line's `degraded`.
- test `[B6 fixed] mode=vector still fails loudly with a 502 from the failing binding`
- test `[B6 fixed] after 3 consecutive dense failures the dense half is skipped for 30 s, then retried`

**Notes:** Was: `src/index.js:319-345` at `7ac9841` returned `upstream(...)` from inside the
vector half, deliberately (R7: "never an empty or quietly degraded 200"). SC7 requires the
fallback, so it is now explicit instead of quiet: in hybrid mode an AI or Vectorize failure
or timeout returns the lexical results with `degraded: { source, reason }` in the body
(`reason` is `error`, `timeout` or `circuit-open`), a `degraded;desc=<source>-<reason>`
Server-Timing span, and a 60 s cache lifetime. A per-isolate circuit breaker
(`denseCircuit` in `src/upstream.js`) skips the dense half for 30 s after 3 consecutive
failures. `mode=vector` (the eval's dense-only mode) never falls back and is never
short-circuited. Fixed in PR #7.

### B7 · Cache key is the raw URL

**Status:** fixed

**Claim:** The cache key is the raw URL: case, parameter order and junk parameters all miss.

**Evidence:**
- test `[B7 fixed] the cache key is canonical: order, case, whitespace, defaults and junk params share one entry`: five spellings of one query make one entry and one embedding; hits read no D1 row; parameters that change the answer still get their own entry.
- test `[B7 evidence] every stage is case- and whitespace-insensitive, so the key may lower-case q`
- `docs/evidence/phase0/raw/B7conn.headers`: live, `cf-cache-status: HIT` only on the identical repeat; reordered, re-cased and `&_r=` variants miss (`docs/evidence/phase0/raw/B7conn.timing`).

**Notes:** Was: `src/index.js:596` at `7ac9841` (`new Request(url.toString())`). A junk
parameter let anyone bypass the cache and spend metered quota.

Fixed in PR #7: `canonicalCacheKey` in `src/search.js` builds the key from the validated
parameters only: `q` trimmed, whitespace runs collapsed and lower-cased; `sem`, `level`,
`credits`, `faculty`, `ng` in parsed form; `mode` and `topK` only when not the default
(`topK` after clamping); unknown parameters dropped; sorted; plus `v=<DATA_VERSION>` from
the committed `src/data-version.json` (seeded with the pinned corpus sha256 prefix
`2d138795d387`). Nothing reads D1 before the lookup. Invalid requests are answered before
the cache is touched and never stored. Lower-casing is safe because every stage already
ignores case: the FTS tokens are lower-cased, the pin upper-cases, the fake embedder
lower-cases (tested), and bge-small-en-v1.5 is uncased (its `BertTokenizer` has
`do_lower_case: true` in the model's `tokenizer_config.json`, so the real model sees the
same token ids; not tested live). The body echoes the canonical query, so a cached answer
is the same whichever spelling stored it.

### B8 · topK, hydration and tokeniser defects

**Status:** fixed

**Claim:** `?topK=` (empty) → 1 result; hydration reads up to 77 rows for 50 results and
selects unused columns; `returnMetadata:'indexed'` is unused and caps topK at 50 (100 without
it); the ASCII-only tokeniser splits "naïve".

**Evidence:**
- test `[B8 fixed] an empty topK= returns the default 20 results`; live (before the fix) `docs/evidence/phase0/raw/B8_emptyTopK.body` (`count: 1`).
- test `[B8 fixed] hydration reads only the rows and columns the response renders`
- test `[B8 fixed] a candidate missing from D1 (stale vector) is skipped and the next one hydrated`
- test `[B8 fixed] Vectorize is asked for ids only; the candidate depth stays 50`
- test `[B8 fixed] "naïve" stays one token, and D1's FTS5 folds it to the same term as "naive"` (`test/findings/backend.test.js`): MATCH is `"naïve" OR "bayes"` (was `"na" OR "ve" OR "bayes"`).
- test `[B8 fixed] the separator table equals the unicode61 separators probed from SQLite, for every code point` (`test/fts-tokenizer.node.test.js`)
- test `[B8 fixed] every query token is at most one FTS5 term, and together they are the FTS5 terms of the query`
- test `[B8 fixed] ASCII queries keep byte-identical MATCH strings (differential over every query fixture)`: the 440 lexical fixture queries, the 98 dev eval queries and every ASCII character; no fixture query's MATCH string changes.

**Notes:** Was: `Number('') === 0` clamped to 1 (`src/index.js:298-302` at `7ac9841`);
hydration `:262-269` read every fused candidate with `SELECT_COLUMNS`; `returnMetadata`
`:338` with only `m.id` read; tokeniser `:158`. Live hydration was 66 rows for 20 results.

PR #7 (workstream 1B) fixes three of the four sub-claims: an empty `topK=` is the default;
hydration selects only `RESULT_COLUMNS` and reads only as many fused candidates as the page
shows, topping up in order when a candidate is missing from D1, so the page is the same as
before (`test/differential.test.js`); Vectorize no longer gets `returnMetadata`. The topK
ceiling stays 50 on purpose (Phase 1 plan r2: a deeper list would change rankings). The
Unicode tokeniser landed with workstream 1C: `queryTokens` in `src/lexical.js` splits on
`src/fts-separators.js`, the exact separator set of the table's `porter unicode61` tokenizer,
generated from SQLite by `scripts/gen-fts-separators.mjs`. A character class such as
`[^\p{L}\p{N}]` would not match it: unicode61 classifies by Unicode 6.1 (later code points are
token characters), treats the diacritics it can strip as token characters and splits on all
other marks. Folding and stemming stay with FTS5, which applies them to each quoted token as
it does to the index, so `"naïve"` matches what `"naive"` matches. Stopwords are tested on
the diacritic-stripped token. ASCII MATCH strings are unchanged, so only non-ASCII queries
can rank differently.

### B9 · README names the wrong binding limit

**Status:** fixed

**Claim:** README says D1 is the binding limit, but Vectorize's ~71k queries/month runs out
first.

**Evidence:**
- test `[B9 fixed] README names the binding limit with its arithmetic (Vectorize queried dims before 3-0; since 3-0, Workers CPU, the smaller of CPU and neurons, B2-8), and states the per-search D1 rows read measured with SC7` (`test/findings/source.node.test.js`)

**Notes:** Was `README.md:169` versus its own table (`:175-178`). D1 allows 5M rows/day ÷ ~50
per search ≈ 3M searches/month. Vectorize allows 30M queried dims/month ÷ 384 − 6,771 stored ≈
71,354 searches/month, about 42× fewer. The claim's arithmetic holds.

Fixed in workstream 1C: the README's cost section now names Vectorize queried dimensions as
the binding limit with this arithmetic, states the break-even (D1 binds first only if
uncached searches average more than ~2,100 rows read, which filtered searches can approach
since B1 made them exact) and marks the per-search D1 numbers as pending until they are
measured on the Phase 1 deploy, quoting only the local grid meanwhile.

## Search

Restated for Workers Paid on 2026-11-04 (ADR 0004): 50M queried dims/month ≈ 123,400 uncached
searches against D1's 25 billion rows read/month. Vectorize is still the binding limit.

Phase 3 3-0 takes Vectorize off the search path (in-Worker exact vectors, Vectorize as a
standby), so queried dims fall to ~0 per search and the README names Workers CPU, the smaller
of CPU and neurons (plan B2-8), with its arithmetic. B9's arithmetic stays in the README as
the pre-3-0 limit.

### S1 · The eval is circular and mis-scoped

**Status:** reproduced

**Claim:** Relevance is title regexes written from the query words; recall@10 ignores order;
only tidy queries; topK=10 versus production depth 50; `ORDER BY rank` never re-measured;
hybrid MRR 0.820 < lexical 0.903.

**Evidence:**
- test `[S1 known-bug] held-out relevance is a regex over titles, recall@10 ignores order, and hybrid MRR trails lexical`: 11 of 12 held-out rules are a regex over `m.title`; `K` defaults to 10; recall is `h / |relevant|`; EVAL.md's held-out MRR row reads 0.833 / 0.674 / 0.903 / 0.820 and states `ORDER BY rank` was not re-run.

**Notes:** `eval/v1/judge-holdout.mjs:13-49`, `eval/v1/eval.mjs:34,104` (moved from `scripts/` by Phase 2), `EVAL.md:94` and
`:41`. Production returns 20 of a 50-deep candidate list (`src/index.js:28-29,317`). "Tidy
queries only" is a judgement, but it mostly holds. Across `eval/v1/queries.json` and
`eval/v1/holdout.json` (27 queries), the three code queries are exact codes (`CS3244`, `cs2040s`,
`EC4308`), and none has a space in a code, a partial code, a typo, or an exam/S/U/workload
constraint. One query, `machine learning for beginners`, does carry level intent.

### S2 · Equal-weight RRF drops correct vector answers

**Status:** reproduced

**Claim:** Equal-weight RRF with a hash tiebreak pushes correct vector answers down
(`intro to psych`, `learn korean`).

**Evidence:**
- `docs/evidence/phase0/raw/S2_psych_vector.body`: vector #1 PL1101E (Introduction to Psychology). `docs/evidence/phase0/raw/S2_psych_hybrid.body`: hybrid #1 CE5316QA, PL1101E #2; lexical found only 4.
- `docs/evidence/phase0/raw/S2_korean_vector.body`: vector #1 LAK1201 (Korean 1). `docs/evidence/phase0/raw/S2_korean_hybrid.body`: hybrid #1 LAK2201 (Korean 2), LAK1201 #2.

**Notes:** `fuse()` at `src/index.js:235-255`. A document ranked #1 in one list only ties with
any other #1-in-one-list document, and the hash tiebreak (`:247-253`) decides it. The real
embedding model is required, so this has no local test; fakes would only test the fake.

### S3 · Vector half set up badly

**Status:** reproduced

**Claim:** No bge query instruction prefix; embedded text lacks code and level and leads with
department/faculty boilerplate; a 768-d model won't fit the free stored-dims cap.

**Evidence:**
- test `[S3 known-bug] the query is embedded verbatim, with no bge query instruction prefix` (`test/findings/search.test.js`)
- test `[S3 3A-2] the embedded text is the selected 3A-2 variant, with the code's level and its label` (`test/findings/ingest.node.test.js`)

**Notes:** Query `src/index.js:329`; passage text `scripts/lib.mjs` `embeddingText`. The
passage-text half is 3A-2's: the text is the pre-registered variant `EMBEDDING_TEXT_VARIANT`
selects (`EMBEDDING_TEXT_VERSION` 2; `docs/plans/phase3-prereg.md` §2). v1 and v2 lead with the
code, all three carry the level and its label and put the description before department and
faculty, and the test pins the selected variant's exact text. The query-prefix half still
reproduces (3A-1 is dropped). The finding as raised: the text started with the **title**, then
department and faculty, then the description, so the boilerplate sat between title and
description.
768-d: 6,771 × 768 = 5.2M > the 5M stored-dims cap (README cost table), arithmetic only.

### S4 · Keyword half is brittle

**Status:** reproduced

**Claim:** No prefix or fuzzy matching; the stopword list lacks "modules", "teach", "intro",
"something"; the code column is UNINDEXED, so `CS32` and `GEA` get 0 keyword hits.

**Evidence:**
- test `[S4 known-bug] "%s" gets 0 lexical hits because the code column is UNINDEXED` (CS32, GEA)
- test `[S4 fixed] stopwords-v2 drops "modules", "teach" and "something"; "intro" stays (it goes to 3D)`: candidate `stopwords-v2`
- test `[S4 known-bug] no fuzzy or prefix matching: "%s" gets 0 lexical hits` (`machne`, `progr`)
- `docs/evidence/phase0/raw/S4_CS32.body` and `docs/evidence/phase0/raw/S4_GEA.body`: live `retrieval.lexical: 0`; no GEA module in GEA's top 20.

**Notes:** Stopwords `src/index.js:150-151`; `migrations/0002_fts.sql:5`. The keyword half has
no fuzzy matching, but hybrid `machne learning` is **not** broken in production: the vector
half carries it (`raw/S5_machne.body`, 15 of 20 titles are ML). So SC4's typo case is already
met by hybrid; the keyword-half claim still stands.

### S5 · Code handling is exact-only

**Status:** reproduced

**Claim:** `cs 1010s` puts CS1010S at #14; partial codes get no route.

**Evidence:**
- test `[S5 known-bug] "cs 1010s" is not recognised as the code CS1010S`
- test `[S5 known-bug] the partial code "CS101" has no route: no pin, 0 lexical hits`
- `docs/evidence/phase0/raw/S4_cs1010s.body`: live CS1010S at #14.

**Notes:** The pin tests the whole query against `MODULE_CODE_RE` (`src/index.js:307-308`);
`cs 1010s` fails it because of the space, and `1010s` is not a word in any indexed text.

### S6 · Graduate courses flood undergraduate queries

**Status:** reproduced

**Claim:** 46% of the corpus is level ≥ 5; `machine learning for beginners` puts CS2109S at
#18; `AI` returns 13/20 at level 5–6.

**Evidence:**
- test `[S6 evidence] 46% of offered modules are level 5 or above` (`test/full/findings.test.js`): 3,098 of 6,771 (45.8%).
- `docs/evidence/phase0/raw/S6_ml_beginners.body`: CS2109S at #18; 9 of 20 at level ≥ 5.
- `docs/evidence/phase0/raw/S6_AI.body`: 14 of 20 at level 5–6.

**Notes:** Nothing in ranking uses level or "beginner" intent. The claim said 13/20 for `AI`;
the recorded run shows 14/20. Same finding, slightly worse.

### S7 · Intent data downloaded but unused

**Status:** reproduced

**Claim:** Exam dates, workload, `attributes.su`, grading basis, prereqs and the GE pillar
(from the code prefix) are downloaded but unused.

**Evidence:**
- test `[S7 known-bug] the schema has no exam, S/U, grading-basis or attributes columns`
- test `[S7 known-bug] /search accepts no workload, exam, S/U or prerequisite filter: they are ignored`

**Notes:** In the pinned `moduleInfo.json`, 1,633 offered modules carry
`semesterData[].examDate`, 933 carry `attributes.su: true`, and every record has
`gradingBasisDescription`. `normalise()` (`scripts/lib.mjs:138-169`) drops all three.
`workload` and `prerequisite` are stored (`migrations/0001_init.sql`) but nothing filters or
ranks on them.

### S8 · No "no match" state; near-duplicates crowd lists

**Status:** reproduced

**Claim:** `xqzvbnm flurble` returns 20 results; near-duplicate variants (TR3202I/S/T) crowd
lists.

**Evidence:**
- test `[S8 known-bug] gibberish returns a full page of results in hybrid mode`
- test `[S8 known-bug] near-duplicate variants (TR3202*) crowd the top of the list`
- `docs/evidence/phase0/raw/S8_nonsense.body`: live 20 results, `retrieval.lexical: 0`. `docs/evidence/phase0/raw/S8_startup_intern.body`: TR3202N, TR3202I, TR3202T, TR3202S at #5–#8.

**Notes:** Vector search always returns its topK nearest neighbours and there's no score floor
(`src/index.js:358-387`). The TR3202 variants share a title and description.

## Product (exchange mode)

### P1 · Exchange filter is a yearly boolean

**Status:** reproduced

**Claim:** `ng=1&sem=1` `machine learning` shows CS3244 and CG3201, which are NG-open in Sem 2
only; 934 of 1,207 NG courses are open in one semester only; per-semester data is already in
D1 as `ng_semesters`.

**Evidence:**
- test `[P1 known-bug] ng=1&sem=1 returns modules that are open to exchange students only in Sem 2`
- test `[P1 known-bug] the Vectorize filter is the yearly ng boolean, not per semester`
- test `[P1 evidence] 934 of the 1,207 NG courses are open to exchange students in one semester only`
- `docs/evidence/phase0/raw/P1_ml_ng_sem1.body`: live CG3201 #2 and CS3244 #4, both `ngSemesters: [2]`.

**Notes:** `src/index.js:124-128` (yearly `ng`), `:139` (sem checked against `semesters`, not
`ng_semesters`), `:544` (`ng` metadata). The README documents this as a known caveat. It also
understates the problem: about 2.5% of rows *disagree*, but 934 of 1,207 NG courses (77%) are
single-semester, and any of those can leak into the other semester. A further data issue
turned up: PC3270 has `semesters: [2]` but `ngSemesters: [1]` (NUSMods and the Registrar PDF
disagree).

### P2 · Graduate courses shown to undergraduate exchange students

**Status:** partially-reproduced

**Claim:** Undergraduate exchange students can't take 5000-level courses (NUS BBA incoming
exchange FAQ Q11), but the filter shows them.

**Evidence:**
- test `[P2 known-bug] ng=1 returns a level-5 module (LI5202) to an undergraduate exchange student`
- test `[P2 evidence] 28 NG courses are level 5 or above`
- `docs/evidence/phase0/raw/P2_ml_ng.body`: live `machine learning&ng=1` top 20, max level 4. Not reproduced on that query.

**Notes:** The behaviour is reproduced. Nothing stops `ng=1` returning level ≥ 5 (there's no
study-level input), and the Registrar's NG list itself contains 28 codes at level 5+ (e.g.
LI5202, PP5288). Two things keep this partial. First, the recorded live query didn't surface
any. Second, the policy premise comes from one faculty's FAQ (BBA) and was not re-checked
here. Because the Registrar's own NG list includes graduate courses, hiding all of them would
be wrong too. The correct rule depends on the student's study level, which SC1 already
requires as an input.

### P3 · No source links; reads as official NUSMods

**Status:** reproduced

**Claim:** No source links (NG PDF, Registrar vacancy report, course-restrictions list); the
title "NUSMods semantic search" reads as official NUSMods.

**Evidence:**
- test `[P3 known-bug] no source links anywhere, and the title reads as official NUSMods` (`test/findings/source.node.test.js`): `src/page.html` has no `<a>` or `href` at all.

**Notes:** `src/page.html:6,84-85`. The hint says "NUS Registrar list" (`:139`) as plain text
with no link. The subtitle says "unofficial NUSMods API", but the title and `<h1>` don't.

## Frontend

### F1 · Result cards are dead ends

**Status:** reproduced

**Claim:** No links or focusables in cards; `/module/:code` is never called; no description
snippet; the raw RRF score (`0.030`) sits in the prime spot.

**Evidence:**
- test `[F1 known-bug] result cards are dead ends: no link, button or tabindex, no description, raw score`
- `docs/evidence/phase0/fe-results.json`: `dom.linksInResults: 0`, `focusableInResults: 0`, `resultsWithTabIndex: 0`.

**Notes:** Card template `src/page.html:167-179`; score `:172`.

### F2 · No abort or timeout on search requests

**Status:** reproduced

**Claim:** No AbortController or timeout.

**Evidence:**
- test `[F2 known-bug] search fetches have no AbortController and no timeout`

**Notes:** `src/page.html:197`. Stale responses are dropped by the `ticket` check (`:199`), but
they still run to completion, and a hung request leaves the button disabled indefinitely
(combined with B5's missing server timeouts).

### F3 · History is broken

**Status:** reproduced

**Claim:** `replaceState`, no `popstate`; Back leaves the site; clearing the query leaves a
stale URL.

**Evidence:**
- test `[F3 known-bug] history uses replaceState only, never pushState, and nothing handles popstate`
- `docs/evidence/phase0/fe-results.json`: `historyAfterSearch3.length: 2` after three searches; `afterBack.url: "about:blank"`.

**Notes:** `src/page.html:190` (`replaceState`); `:185` returns before touching the URL when
the query is cleared.

### F4 · Shared links lose filters when /facets fails

**Status:** reproduced

**Claim:** Shared links lose filters when `/facets` fails; the first search waits for
`/facets`.

**Evidence:**
- test `[F4 known-bug] a failed /facets is swallowed and the shared-link search waits on it`
- `docs/evidence/phase0/fe-results.json`: `requests` shows `/facets` at +499 ms and the first `/search` only at +934 ms after page load.

**Notes:** `src/page.html:132-143` and `:224-235`. Level and faculty `<option>`s exist only if
`/facets` succeeded, and assigning `.value` to a `<select>` with no matching option is a
silent no-op, so `level=`/`faculty=` from the URL are dropped. Shown at source level (DOM
semantics); a failing `/facets` was not browser-exercised.

### F5 · Accessibility gaps

**Status:** reproduced

**Claim:** `#status` has no `aria-live`, results have no `aria-busy`, disabling the focused
button drops focus to BODY, no `<main>`, no `role="search"`.

**Evidence:**
- test `[F5 known-bug] no aria-live status, no aria-busy, no <main>, no role="search"; the focused button is disabled`
- `docs/evidence/phase0/fe-results.json`: `statusAriaLive: null`, `mainCount: 0`, `roleSearchCount: 0`, `focusDuringSearch.active: "go"` → `focusAfterSearch.active: "BODY"`.
- `docs/evidence/phase0/axe-1280-light.json`: `landmark-one-main` ×1, `region` ×6.

**Notes:** `src/page.html:117`, `:193`.

### F6 · Contrast failures

**Status:** reproduced

**Claim:** Dark-mode button 2.08:1; light `<code>` and NG badges 4.44:1.

**Evidence:**
- test `[F6 known-bug] colour tokens fail WCAG AA: dark button 2.08:1, light <code>/NG badge 4.44:1`: recomputes the ratios from the `src/page.html` tokens.
- `docs/evidence/phase0/axe-1280-dark.json`: `#go` 2.08 (#fff on #ff9a62). `docs/evidence/phase0/axe-1280-light.json`: `code` and `.ng` 4.44 (#b4541f on #fdf0e8).

**Notes:** Tokens `src/page.html:11,16`; button `:40`.

### F7 · Raw error states

**Status:** reproduced

**Claim:** Errors show raw codes (`rate_limited`, `upstream_failure`); `Retry-After` is
ignored; an HTML error page makes `res.json()` throw.

**Evidence:**
- test `[F7 known-bug] errors show raw codes, ignore Retry-After, and parse JSON before checking res.ok`
- `docs/evidence/phase0/raw/B5_module.headers`: Cloudflare error pages are `text/plain` (`error code: 1101`), which `res.json()` cannot parse.

**Notes:** `src/page.html:198-209`. A non-JSON error lands in the `catch`, which shows "Could
not reach the search service" plus a JSON `SyntaxError` message. That is wrong: the service was
reached.

### F8 · Unescaped innerHTML interpolation

**Status:** reproduced

**Claim:** `credits`, `semesters` and the `ngSemesters` title attribute are interpolated into
`innerHTML` without escaping.

**Evidence:**
- test `[F8 known-bug] credits, semesters and the NG title attribute are interpolated into innerHTML unescaped`

**Notes:** `src/page.html:171`, `:176`, `:177`. Today these values are numbers from the
Worker's own D1, so this isn't exploitable without a poisoned row. It's an injection seam all
the same, and `esc` already exists (`:154`).

### F9 · Enter during IME composition fires a search

**Status:** reproduced

**Claim:** Enter during IME composition fires a search.

**Evidence:**
- test `[F9 known-bug] Enter fires a search even during IME composition`

**Notes:** `src/page.html:219-221` checks only `e.key === 'Enter'`, not `e.isComposing` or
keyCode 229, so confirming a CJK candidate submits a half-typed query.

### F10 · Mobile layout

**Status:** reproduced

**Claim:** On mobile the first result sits at y≈500/844, the score wraps, and the 15px input
triggers iOS zoom.

**Evidence:**
- test `[F10 known-bug] 15px inputs (iOS zooms below 16px) and a score pushed to its own line on narrow cards`
- `docs/evidence/phase0/fe-results.json`: `mobile.firstResultTopY: 499` at 390×844, `inputFontSize: "15px"`.
- `docs/evidence/phase0/shots/390x844-light.png`: the score wraps to its own line, and so does "Sem 1, Sem 2".

**Notes:** `src/page.html:22`, `:33-36`, `:69`, `:72`. At y=499 the first card's top is
technically above the fold (`firstResultVisibleAboveFold: true`), but less than one card fits;
SC8 needs the first result readable above the fold.

## Visual design

### V1 · Visual design 4/10

**Status:** partially-reproduced

**Claim:** Template look; off-brand orange `#b4541f`; accent everywhere; inconsistent filter
labels ("2", "2000 (1016)", "sem: Sem 2"); non-removable chips; dead-end no-results; data-source
notes fill the hero.

**Evidence:**
- test `[V1 known-bug] orange accent everywhere, inconsistent filter labels, non-removable chips, dead-end empty state`
- `docs/evidence/phase0/shots/1280x800-light.png` and `docs/evidence/phase0/shots/390x844-light.png`

**Notes:** Every factual sub-claim holds: accent `#b4541f` with ≥ 8 `var(--accent)` uses;
option "2" (`src/page.html:95`), level labels `${level}000 (${count})` (`:135`), chip
`sem: Sem 2` (`:160`); chips are plain spans; the empty state is text only (`:163`); data notes
in `.sub` (`:85`). "4/10", "template look" and "off-brand" are judgements, not reproducible
claims, hence partial. The Phase 5 design gate decides those.

## Ops

### O1 · Database not rebuildable from the README

**Status:** fixed

**Claim:** The README skips 0003/0005, has no 0001, the ALTERs are not idempotent, and the
metadata-index loop omits `ng`.

**Evidence:**
- test `[O1 fixed] the README rebuilds the schema from migrations/, which start at 0001 and include ng in the metadata loop`
- `scripts/schema-snapshot.mjs` (`npm run db:rebuild-check`, run by `.github/workflows/ci.yml`): rebuilds from empty and diffs against `test/fixtures/remote-schema.json`.
- `docs/decisions/0001-migrations-and-remote-bootstrap.md`

**Notes:** Fixed by PR #1 (`7ac9841`). ALTER idempotency comes from migration tracking (ADR
0001). The remote `d1_migrations` bootstrap is still pending (Phase 1), but that's an ops step,
not this finding.

### O2 · No tests, CI, lint or types

**Status:** fixed

**Claim:** No tests, CI, lint or types.

**Evidence:**
- test `[O2 fixed] lint, typecheck, tests and the schema rebuild run in CI`
- `.github/workflows/ci.yml`, `eslint.config.mjs`, `tsconfig.json`, `vitest.config.mjs`

**Notes:** Fixed by PR #1 (`7ac9841`). An eval gate in CI (SC9) is still open; Phase 2.

### O3 · NG_LIST_UPDATED kept in two places

**Status:** fixed

**Claim:** `NG_LIST_UPDATED` is maintained by hand in `src/index.js` and in the NG JSON.

**Evidence:**
- test `[O3 fixed] the NG list date has one source: ingest posts it from data/ng-courses-*.json, no copy is kept by hand`
- test `[O3 fixed] /facets reports the NG list date ingest recorded from data/ng-courses-*.json`

**Notes:** Was: a constant in `src/modules.js` (`src/index.js:38` at `7ac9841`) versus
`data/ng-courses-2026-2027.json` `updatedAsAt`, with the README asking for a manual bump.
Fixed in PR #7: `scripts/ingest.mjs` posts `{ ngList: { updatedAsAt, source, count } }`
(from `loadNgCourses`) to `/admin/facets`, which stores it as `meta('ng_list')` before
rebuilding the facets row; `/facets` (precomputed or live) reads the date from there. The
constant and the README instruction are gone. Until the next ingest records it, the live
`/facets` row keeps the date it was built with.

### O4 · No scheduled refresh

**Status:** reproduced

**Claim:** No scheduled refresh.

**Evidence:**
- test `[O4 known-bug] the Worker has no scheduled handler, so nothing refreshes the data`
- test `[O4 known-bug] wrangler.jsonc declares no cron trigger`

**Notes:** The default export has only `fetch` (`src/index.js:577-629`); `wrangler.jsonc` has
no `triggers`. The README lists it as a known limitation.
