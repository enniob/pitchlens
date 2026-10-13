# Playback cutoff and final-revision reliability — October 12–13, 2026

## Status

The playback cutoff fix passed regression and local browser checks. Live
readiness is **not established**: all 36 cases were attempted, but only 26
returned reviewed explanations; eight fell back and two returned errors.
The strict release gate failed. Seven accepted matrix answers contain
confirmed incorrect claims, and an eighth has an unsupported directional
label. Additional HTTP samples also failed manual grounding review. All
football evidence is synthetic.

> **Simulator version.** This run used simulator v4 (`sim-v4-…` match IDs).
> Simulator v5 changed how goalkeepers meet a carrier who is in on goal, so
> generated matches no longer reproduce these exact cases. Seeds 3, 9, 20 and
> 24 play out unchanged. The `seed2-*` and `seed28-*` scenarios below were
> replaced by `seed6-*` and `seed16-*`, which have not yet been run live.

The matrix ran from October 12 at 11:38 p.m. to October 13 at 12:24 a.m.
America/New_York (finish: `2026-10-13T04:24:19.916Z`). Every successful response
was retained and manually compared with selected-time evidence. No confirmed
future-event leak was found in returned final text; the one automated leak flag
was a false positive. This is bounded sample evidence, not proof of factual
correctness or general live reliability.

Remaining release criteria: resolve the confirmed grounding errors and
unnecessary fallbacks, successfully rerun the two provider-error cases, and
obtain a representative strict and manual pass on the resulting revision.
Public judge-deployment verification and repeatable capacity measurements
remain outstanding. No merge or deployment was performed.

## Revision and implementation

Base commit: `482a824dee7585a0f2911c0f6c1908b271558ad7`.
The evaluated working tree includes the existing uncommitted animation,
pose, rig and animation-test changes. They were preserved.
The cutoff fix itself was later committed as `5e3384c` and merged to `main`
with PR #25. The live results below describe the fingerprinted working tree,
not that commit, and were recorded on simulator v4.

Implementation/test SHA-256:
`80f04c5471b14542664ee809de551e0127dca1bfea7cde0f9c43e83c1dc8f1d5`.
This is a working-tree fingerprint, not a new Git commit. The reproducible
algorithm is `evaluationRevision()` in `tests/support/revision.ts`: sorted
tracked and nonignored untracked implementation/test/configuration paths,
each followed by NUL, its raw file bytes and NUL. Documentation and credentials
are excluded. The matrix records its fingerprint before starting and refuses
to pass if the implementation changes during the run.

Manual explanations and automatic cards now use the selected playback cutoff
even when replaying a citation. An answer's headline, body, claims, citations
and history entry stay hidden before its cutoff. Saved answers and the selected
answer survive rewinds and audience changes and can reappear at their cutoff.
Late responses must still satisfy the current cutoff and access state before
being saved. Queued requests retain their original cutoff and cancel on a
backward seek. Recap access now depends on currently being at full time,
including after returning from recap replay.

The installed Next.js Server and Client Components and route-handler guides
were read before changes. Model credentials and calls remain server-side.
Microsoft Foundry's existing Azure OpenAI v1 HTTP integration and bounded
analyst/verifier workflow are used; no SDK or orchestration platform changed.
The configured analyst and verifier deployment for this run was
`DeepSeek-V4-Flash`, with `json_schema`, reasoning effort `none` and temperature
`0`. These results do not describe the older Kimi deployment's behavior.

## Offline and browser evidence

- Full offline suite: 54 suites, 1,314 tests passed.
- Type checking and production build passed.
- A final full run used `node node_modules/vitest/vitest.mjs run --maxWorkers=2
  --testTimeout=15000`, followed by type checking and build. The initial default
  offline run passed; later sandbox temporary-module failures and two simulator
  tests exceeding the default five-second timeout under host load required this
  rerun. The npm wrapper did not forward the attempted timeout flags, so the
  successful final run invoked the installed runner directly. Assertions and
  application/model time limits were not changed. Default-timeout stability
  under load remains a limitation.
- Focused interaction suites: 43 tests passed, including citation replay,
  backward seeking, audience changes, queued requests, late responses and
  recap-to-match replay. The old replay exceptions were replaced by regressions.
- Local production browser checks verified judge sign-in, a checked cached
  API answer, manual and automatic citation replay, audience switching while
  earlier than the cutoff, saved-answer restoration and retained replay buttons.
- A recap replay restored the earlier 0–0 score, removed the full-time recap
  and disabled Recap until full time. The 3D view rendered in this browser.
- Browser answer checks reused results from the HTTP concurrency test; they
  made no additional paid model calls.

There was no PitchLens project in the connected Netlify project search, no
GitHub deployment record for the repository, and no judge URL in repository
documentation/configuration. Verification used a local
production server at `http://127.0.0.1:3100`. Verification of an existing public
judge deployment remains outstanding. No deployment or merge was performed.

## Live bounds and reproducibility

The matrix selects all 18 existing scenarios in both audiences: 36 workflows,
at most 288 model calls. Independent HTTP sessions permit at most four
uncached workflows (32 calls), for an aggregate ceiling of 40 workflows and
320 model calls. Every workflow retains the existing 60-second deadline,
25-second call deadline, eight-call and 80,000-token ceilings. Calls use the
configured server-side credentials. Matrix cooldown is 65 seconds after each
workflow, with the configured deployment pacing of 10 requests per minute.
The concurrent-session test ran while the matrix was active, so these results
include shared-provider contention across two local server processes.

```powershell
$env:PITCHLENS_LIVE_EVAL = '1'
$env:PITCHLENS_LIVE_SCENARIOS = 'all'
$env:PITCHLENS_LIVE_MAX_CASES = '36'
$env:PITCHLENS_LIVE_MAX_MODEL_CALLS = '288'
$env:PITCHLENS_LIVE_COOLDOWN_MS = '65000'
$env:PITCHLENS_LIVE_REPORT = '.local/final-revision-live.md'
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.live.config.mts tests-live/explain.live.test.ts --reporter=verbose
```

Start the production build with `next start --hostname 127.0.0.1 --port 3100`,
loading the same server environment. For the HTTP test, in a separate shell:

```powershell
$env:PITCHLENS_LIVE_SESSIONS = '1'
$env:PITCHLENS_LIVE_BASE_URL = 'http://127.0.0.1:3100'
$env:PITCHLENS_LIVE_SESSION_REPORT = '.local/final-sessions.json'
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.live.config.mts tests-live/sessions.live.test.ts --reporter=verbose
```

Do not set `PITCHLENS_LIVE_EVAL=1` in the HTTP-test shell: the HTTP suite has its
own opt-in flag. Failed provider cases are findings even when collection
continues; the matrix's final release gate requires complete useful coverage.
Redacted final answers and verifier results are retained in the ignored local
reports; incremental matrix results are saved beside the report as
`.progress.json`. No endpoint, key, judge code or session cookie is included.
The local evidence archive `.local/final-evidence.zip` includes these reports,
manual adjudications, selected-time context, browser screenshots, runner logs,
the recovery probe, a per-file hash manifest and an exact-byte snapshot of all
fingerprinted source files. The snapshot permits reconstruction on the base
commit without relying on uncommitted-file descriptions or line-ending guesses.
Credential redaction and the final source fingerprint were checked at handoff.

## Concurrent independent sessions

Two signed judge sessions submitted the same demo-goal cutoff for different
audiences concurrently. Both uncached requests returned HTTP 200 and a checked
answer. Casual latency was 8.298 seconds (two model calls); Analyst latency
was 27.503 seconds (three model calls). After a 65-second cooldown, cache
repeats took 26 and 20 milliseconds, respectively, and made zero new calls.
Cached responses repeat the original trace: those trace counts must not be
added again to usage. Distinct session cookies were confirmed without logging
their values. Session logout succeeded.

No throttle occurred in that two-session sample. The bounded recovery branch
in its test retries each failed session at most once; it was not exercised.
This sample is not a capacity benchmark or proof of distributed quota enforcement.

Two additional one-workflow admission probes used the remaining reserved HTTP
allowance. A same-session overlapping request was refused as HTTP 429 `busy`
with `Retry-After: 2`, while the running explanation completed with HTTP 200;
the next request returned the cached answer. The first probe's assertion
incorrectly expected 503 `session-busy`; its retained data shows the correct
API behavior. The corrected probe passed: busy response 24 ms, running request
13.881 s, recovered cache request 12 ms. It used the demo pending-shot cutoff.
This establishes application admission recovery, separately from provider
throttle recovery. Probe scripts/configuration, both raw reports and logs are
retained under `.local/`; the corrected command is:
`node --env-file=.env.local node_modules/vitest/vitest.mjs run --config .local/recovery.config.mts`.
The scripts are diagnostics outside the committed offline suite.

The final matrix Casual Fan second-goal workflow returned provider
`rate-limited` after 6.1 seconds under this shared workload. After the normal
65-second cooldown, the Analyst workflow completed provider calls and returned
a fallback in 16.1 seconds. This is evidence that transport resumed after the
throttle; the failed Casual Fan case was not retried successfully and the next
answer was unusable. A second matrix error was the 29.2-second demo-goal
timeout. Provider retry behavior under every quota condition remains unproven.

## Usage and operational limits

The matrix reports 91 model calls, 617,670 input tokens and 20,946 output
tokens. The four uncached HTTP workflows report 10 calls, 62,816 input tokens
and 2,292 output tokens. Combined known usage is **101 calls, 680,486 input
tokens and 23,238 output tokens**. Cached responses were excluded from these
sums. Two failed matrix workflows have no returned trace; these totals are a
lower bound on billed usage. The runner conservatively allocates eight calls
per failed workflow; no case or call ceiling was expanded. No prices were
configured, so monetary cost was not estimated.

Matrix latency was median 12.0 seconds and maximum 29.2 seconds, excluding
deliberate cooldowns but including queue/model/revision time and errors. Local
offline checks and separate HTTP requests ran during parts of the matrix;
this is operational sample evidence under host/shared-provider load, not an
isolated latency benchmark. In-process pacing cannot coordinate separate
server processes or deployment instances.

## Manual grounding findings

1. **Confirmed unsupported elapsed-time claim:** the Casual Fan demo-goal
   answer in both the matrix and concurrent HTTP sample says the goal came
   6.4 seconds after the turnover. Recorded times are turnover 2.4 s, shot
   8.8 s, goal 9.4 s. The measured 6.4 s interval ends at the shot; the
   turnover-to-goal interval is 7.0 s. The facts correctly describe the
   turnover-to-shot interval, but the prose changes its endpoint. Schema,
   deterministic grounding, verifier and independent automated assessment all
   accepted the answer. These samples fail manual grounding review and cannot
   support readiness despite automated `usable` status.
   The same defect recurred in both generated seed-9 recorded-goal audiences,
   including a Casual Fan fact citing both shot and goal: each calls the
   turnover-to-goal interval 8.68 s. Actual times are turnover 6.86 s, shot
   15.54 s and goal 16.24 s, so turnover-to-goal is 9.38 s. This is a repeatable
   grounding gap across the scripted and generated fixtures, not just a
   citation-format problem.
2. **Unnecessary fallback:** the Analyst pass-in-flight case exhausted its
   revision after unsupported timestamp and score citations. The selected
   evidence contains a recorded turnover and current snapshot, so a useful
   account was possible. The fallback hides the rejected claims safely but
   fails the scenario's quality requirement.
3. **Provider/workflow timeout:** the matrix's Analyst demo-goal case returned
   `timeout`, even though an earlier concurrent HTTP sample completed that
   audience. The successful sample does not erase the timeout. Failed workflows
   may have consumed provider tokens; their usage is not returned by the current
   workflow error contract and successful-workflow totals are a lower bound.
4. **Evaluator false positive:** the sparse Casual Fan answer was flagged for
   a future scoring event because the scenario's `scor\w*` pattern matches
   "score" in "The score remains 0-0." The current score is 0–0 and this
   sentence reveals no later event. Retain the raw `needs-review` result and
   adjudicate this flag as a false positive; do not count it as a confirmed leak.
   The Analyst sparse case returned a safe fallback after malformed/unsupported
   drafts; the uncertainty is appropriate to sparse evidence, but the raw
   fallback still fails the strict release gate.
5. **Confirmed reversed pitch geography:** the Casual Fan seed-9 answer at
   29.999 s says Northvale won the ball "deep in Harbor City's half". The
   turnover is at x=94.5; Harbor attacks increasing x and Northvale attacks
   decreasing x. It is therefore near Northvale's own goal, in Northvale's
   defensive half. Automated checks accepted the final wording. The Analyst
   case fell back after contradictory verifier geography feedback across its
   drafts. This is another reason model review cannot establish claim truth.
6. **Undefined directional label:** the accepted Analyst formation-change
   answer describes the turnover as near the "right touchline". The evidence
   supplies x/y coordinates and attack direction but does not define that
   left/right label. The existing lexical check covers side/half-space wording,
   not touchline wording. Treat the label as unsupported geography; the formation
   and event ordering themselves match the evidence.
7. **Confirmed reversed pass progression:** the Analyst seed-3 ordinary moment
   says Novak's pass to Haddad moved play forward. The cited pass starts at
   x=78.3 and ends at x=58.4; Harbor attacks increasing x, so the pass moved
   backward. Player names, pass completion and timestamp are correct. The
   unsupported directional claim occurs in the prose and escaped the checks.
8. **Confirmed incorrect omission count:** the Casual Fan seed-3 recap says
   22 ordinary passes were filtered out. The context says 22 events of other
   types, such as ordinary passes, were filtered out. The full selected-time
   evidence contains 15 passes, six turnovers and one throw-in in that omitted
   set. The score and formation-change account are correct, but the limitation
   incorrectly turns a mixed event count into a pass count.
   The Analyst seed-28 recap repeats this error, calling 19 omitted mixed
   events "19 ordinary passes"; that fixture has only 10 pass events in total.
9. **Unsupported shot target:** the corrected admission probe's final answer
   says Castell was "aiming at the central channel". The supplied central
   channel measurement describes the shot's starting location, not its intended
   target. The API recovery assertions passed, but this answer fails manual
   grounding review. Transport recovery does not establish explanation quality.

The evaluated implementation was kept fixed while collecting these findings.
Any later grounding fix requires affected-case reruns and a representative
pass on the new revision before a readiness claim.


## Matrix results (raw automated assessment)

- Commit: `482a824dee7585a0f2911c0f6c1908b271558ad7; implementation/test SHA-256 80f04c5471b14542664ee809de551e0127dca1bfea7cde0f9c43e83c1dc8f1d5`, run 2026-10-13T04:24:19.916Z
- Model settings: deployment=DeepSeek-V4-Flash, verifierDeployment=DeepSeek-V4-Flash, structuredOutput=json_schema, reasoningEffort=none, temperature=0
- Bounds: 36 cases, 288 model calls; scenarios all

| Scenario | Audience | Outcome | Safety | Quality | Flags | Seconds | Model calls | Tool calls | Input tokens | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| demo-pass-in-flight | casual | verified | pass | usable | - | 7.6 | 2 | 0 | 8749 | 357 | - |
| demo-pass-in-flight | analyst | fallback | pass | not-explained | - | 15.8 | 3 | 0 | 14270 | 734 | - |
| demo-shot-in-flight | casual | verified | pass | usable | - | 7.8 | 2 | 0 | 13514 | 360 | - |
| demo-shot-in-flight | analyst | verified | pass | usable | - | 7.8 | 2 | 0 | 13713 | 628 | - |
| demo-goal-before | casual | verified | pass | usable | - | 7.6 | 2 | 0 | 13607 | 415 | - |
| demo-goal-before | analyst | verified | pass | usable | - | 10.4 | 2 | 0 | 13663 | 496 | - |
| demo-goal-recorded | casual | verified | pass | usable | - | 8.2 | 2 | 0 | 13789 | 444 | - |
| demo-goal-recorded | analyst | error (timeout) | - | - | - | 29.2 | - | - | - | - | - |
| demo-sparse | casual | revised | pass | needs-review | 1 | 13.6 | 3 | 0 | 11275 | 329 | - |
| demo-sparse | analyst | fallback | pass | honest-insufficient | - | 7.7 | 2 | 0 | 8422 | 297 | - |
| demo-recap | casual | verified | pass | usable | - | 7.4 | 2 | 0 | 11820 | 302 | - |
| demo-recap | analyst | verified | pass | usable | - | 8.0 | 2 | 0 | 11905 | 434 | - |
| seed2-offside-recorded | casual | verified | pass | usable | - | 7.7 | 2 | 0 | 13622 | 406 | - |
| seed2-offside-recorded | analyst | fallback | pass | not-explained | - | 9.0 | 2 | 0 | 15420 | 702 | - |
| seed2-offside-kick-frame | casual | revised | pass | usable | - | 15.4 | 3 | 0 | 21932 | 506 | - |
| seed2-offside-kick-frame | analyst | fallback | pass | honest-insufficient | - | 25.3 | 2 | 0 | 15846 | 726 | - |
| seed24-offside-recorded | casual | revised | pass | usable | - | 19.6 | 4 | 0 | 30852 | 699 | - |
| seed24-offside-recorded | analyst | revised | pass | usable | - | 13.7 | 3 | 0 | 23998 | 746 | - |
| seed9-goal-before | casual | verified | pass | usable | - | 7.9 | 2 | 0 | 14510 | 424 | - |
| seed9-goal-before | analyst | revised | pass | usable | - | 14.0 | 3 | 0 | 22949 | 811 | - |
| seed9-goal-recorded | casual | verified | pass | usable | - | 7.4 | 2 | 0 | 14645 | 368 | - |
| seed9-goal-recorded | analyst | verified | pass | usable | - | 9.3 | 2 | 0 | 14826 | 662 | - |
| seed9-formation-before | casual | revised | pass | usable | - | 19.9 | 4 | 0 | 28689 | 854 | - |
| seed9-formation-before | analyst | fallback | pass | honest-insufficient | - | 22.4 | 4 | 0 | 28731 | 896 | - |
| seed9-formation-recorded | casual | fallback | pass | not-explained | - | 20.1 | 4 | 0 | 31094 | 700 | - |
| seed9-formation-recorded | analyst | verified | pass | usable | - | 7.9 | 2 | 0 | 15435 | 451 | - |
| seed3-zero-goal-moment | casual | revised | pass | usable | - | 13.6 | 3 | 0 | 24135 | 450 | - |
| seed3-zero-goal-moment | analyst | revised | pass | usable | - | 16.6 | 3 | 0 | 24490 | 827 | - |
| seed3-zero-goal-recap | casual | revised | pass | usable | - | 13.6 | 3 | 0 | 18347 | 476 | - |
| seed3-zero-goal-recap | analyst | fallback | pass | not-explained | - | 14.0 | 3 | 0 | 18621 | 828 | - |
| seed20-recap-two-goals | casual | revised | pass | usable | - | 21.3 | 4 | 0 | 26443 | 994 | - |
| seed20-recap-two-goals | analyst | verified | pass | usable | - | 12.0 | 2 | 0 | 13203 | 782 | - |
| seed28-recap-two-goals | casual | verified | pass | usable | - | 7.7 | 2 | 0 | 13528 | 308 | - |
| seed28-recap-two-goals | analyst | revised | pass | usable | - | 27.8 | 5 | 0 | 28108 | 1203 | - |
| seed28-second-goal | casual | error (rate-limited) | - | - | - | 6.1 | - | - | - | - | - |
| seed28-second-goal | analyst | fallback | pass | not-explained | - | 16.1 | 3 | 0 | 23519 | 1331 | - |

Outcomes: verified 15 · revised 11 · insufficient evidence 0 · fallback 8 · error 2 · skipped 0
Safety (no release blocker): 34 passed, 0 failed. Usable explanations: 25; honest insufficient evidence: 3; flagged for review: 1.
Totals: 91 model calls, 0 tool calls, 617670 input and 20946 output tokens; median 12.0 s, max 29.2 s.
Estimated cost: not estimated (no prices configured).

Safety passing means no deterministic release blocker was found; it does not make an answer usable or true. Model review is not proof of factual correctness.


The strict release gate failed with 11 raw findings (eight fallbacks, two errors and one evaluator flag). The evaluator flag is manually adjudicated above; manual grounding findings add further failures beyond this gate.
