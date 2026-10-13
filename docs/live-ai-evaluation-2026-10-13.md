# October 13 live evaluation and follow-up

All match data is synthetic, with fictional teams and players. Microsoft
Foundry is the live model platform; the application uses its existing
server-side chat-completions client. No new SDK or orchestration platform was
introduced for this follow-up.

## Full merged-revision baseline

The full evaluation on merged commit
`533a82a3d1e950f2aa7ee38c540e5e719246b55a` attempted all 36 cases and took
47.2 minutes. Its implementation/test SHA-256 was
`cf93cffcdf0389124a637cfc6b86a07436a2ccc9012ae5cb7057bb0d7b8439d0`.
The release gate failed.

| Result | Cases |
| --- | ---: |
| Usable, unflagged explanations | 21 |
| Explained answers flagged for review | 2 |
| Fallbacks | 6 |
| Timeouts | 7 |
| Skipped | 0 |

Workflow outcomes were 16 verified, seven revised, six fallback and seven
error. Two fallbacks were assessed as honest insufficiency, but still failed
the release gate. The reported 29/36 answered coverage includes fallbacks
and flagged answers. Two audience pairs disagreed on explained versus
insufficient-evidence status. No deterministic safety blocker was detected
in retained answers; manual review still found unsupported possession claims.

Both analyst and verifier used deployment `DeepSeek-V4-Flash`, JSON schema
output, reasoning `none`, temperature 0. Bounds were 36 cases and 288 calls,
with a 65-second cooldown after each workflow. Recorded usage was 68 calls,
549,568 input tokens and 17,418 output tokens; failed-workflow usage was not
retained, so these are incomplete totals. No prices were configured.

## Changes driven by the findings

- Time parsing reads grouped numbers in full: `9,400 ms` is 9,400 ms,
  not 400 ms. Malformed grouping is rejected. Grouped future timestamps
  remain subject to the selected-time boundary in every response field.
  Millisecond intervals now receive named-endpoint checks too. An explicit
  `at` marks a timestamp even when followed by an `after` clause.
- Possession durations must match a supplied sampled spell and, within a
  fact or interpretation, cite its evidence anchors. An arbitrary gap between
  events cannot substitute for a possession duration. An offside, goal or
  foul occurring in a spell does not establish that it caused the spell to
  end. Model instructions explain the last-controlled-snapshot boundary and
  the meaning of `ongoing`; simulation and fixture contracts are unchanged.
- Provider failures retain safe local diagnostics identifying the model role,
  queue/request/body/HTTP stage, elapsed time, queue wait and HTTP status when
  present. Partial workflow traces preserve completed calls and reported
  tokens, with unknown usage on failed calls. No prompts, drafts, response
  bodies, headers, endpoints or credentials are added to diagnostics. HTTP
  error responses keep their existing public contract.

The independent evaluator shares lexical time parsing, but continues to
assess claims separately from the production grounding checks. Both paths
have regression coverage for the live possession defects.

## Targeted follow-up scope

Before another full matrix, rerun these 13 scenarios for both audiences
(26 cases, at most 208 calls), with normal pacing and the release gate enabled:

`demo-goal-before`, `demo-goal-recorded`, `demo-sparse`, `demo-recap`,
`seed6-offside-recorded`, `seed6-offside-kick-frame`,
`seed24-offside-recorded`, `seed9-goal-recorded`,
`seed9-formation-before`, `seed9-formation-recorded`,
`seed3-zero-goal-moment`, `seed3-zero-goal-recap`, `seed16-second-goal`.

This includes every baseline timeout and fallback, the two flagged answers,
and both manually identified possession claims. Pairing audiences permits
comparison on the same evidence. It is targeted coverage, not a full release
evaluation. The original timeout records cannot establish which model call
or provider stage failed; the follow-up diagnostics address that evidence gap.

## Targeted results

The follow-up completed all 26 cases in 34.2 minutes on base commit `533a82a`
with implementation/test SHA-256
`6b5160f618b0a4bb264f38a0567dd77ddbd6a7e7b8b62d1471c44bbabe82039d`.
The implementation stayed unchanged during the run. The scenario fingerprint
remained `4ef6d7b78331d548`. Model settings, workflow deadlines, pacing and
release gates were unchanged from the baseline. The release gate failed.

| Result | Baseline, same 26 cases | Follow-up |
| --- | ---: | ---: |
| Usable, unflagged explanations | 11 | 13 |
| Flagged answers | 2 | 0 |
| Fallbacks | 6 | 10 |
| Timeouts | 7 | 3 |
| Skipped | 0 | 0 |

Follow-up outcomes were six verified, seven revised, ten fallback and three
error. Four fallbacks were assessed as honest insufficiency but remain gate
failures. There were four audience-pair status conflicts. No deterministic
safety blocker was detected in the 23 retained responses. These are two
single samples, not proof of a stable quality or latency improvement.

Recorded usage, now including partial failed workflows: 64 calls, zero tool
calls, 527,045 input tokens and 17,881 output tokens. Failed calls have unknown
token usage, so these are still not complete billing totals. Cost was not
estimated. No extra retry, full-matrix evaluation, merge or deployment followed.

### Retained-evidence review

- The pre-goal Analyst answer and both demo recaps were unflagged. The recap
  still says kickoff occurred `at 19.5 s after the goal`: the explicit `at`
  refers to its recorded timestamp, not a 19.5-second elapsed interval.
  The actual goal-to-kickoff interval is 10.1 seconds. Clearer prose would help.
- Both seed-24 initial drafts repeated the unsupported offside-ended-spell
  claim. Production grounding rejected it. Casual revised to the recorded
  offside at 17.2 seconds and passed; Analyst removed that claim but fell back
  on other event/citation errors. No unchecked possession-end claim was shown.
- The Casual seed-3 moment revised successfully after its unsupported
  possession duration was rejected. The retained backward-pass direction
  agrees with the measured -19.9 m progress; Haddad's nearest-opponent distance
  of 2.1 m agrees with the selected-time proximity measurement. Its broader
  phrase `building from the back` remains interpretive wording rather than a
  supplied metric. Automated usable status is not exhaustive factual clearance.
- Remaining fallbacks include sparse-evidence contract/citation failures,
  wrong interval endpoints, unsupported zero-shot wording, mixed citation
  scopes and geography errors. Rejecting these is necessary, but repeated
  rejection still leaves incomplete useful coverage.

### Investigation of the seven baseline timeouts

All seven were rerun with their original deadlines. None timed out again:

| Baseline timeout | Follow-up |
| --- | --- |
| demo-sparse / Casual | Fallback |
| seed6-offside-kick-frame / Analyst | Revised, usable |
| seed9-goal-recorded / Analyst | Verified, usable |
| seed9-formation-before / Casual | Fallback |
| seed9-formation-before / Analyst | Verified, usable |
| seed9-formation-recorded / Analyst | Fallback |
| seed16-second-goal / Analyst | Fallback |

Three different Casual cases timed out in the follow-up:

| Case | Failed role | Stage | Call elapsed | Queue wait |
| --- | --- | --- | ---: | ---: |
| seed6-offside-kick-frame | Verifier of revision | Request | 25,016 ms | 2,552 ms |
| seed3-zero-goal-recap | Initial Analyst | Request | 25,019 ms | 0 ms |
| seed16-second-goal | Initial Verifier | Request | 25,010 ms | 2,026 ms |

Each failed while awaiting the provider response under the application's
25-second call deadline, before response-body parsing or validation. The
workflow totals were 42.1, 25.0 and 29.0 seconds respectively, below the
60-second workflow limit. The call deadline includes deployment queue wait;
pacing reduced request time for the two verifier failures, but the Analyst
failure had no queue delay. No HTTP timeout status was received. No draft
was returned as verified after a failed review.

The evidence establishes variable request latency exhausting the current
per-call budget; it does not identify a provider-internal cause. The original
seven records lack role/stage diagnostics, so their historical causes cannot
be reconstructed conclusively. No claim is made that the seven were fixed
or that a longer deadline would have succeeded.

### Verification and next evaluation decision

Before the live follow-up, `npm run check` passed 59 files / 1,460 offline
tests, type checking and the production build. New tests cover grouped and
malformed times, future times in all fields, grouped interval endpoints,
sampled-spell durations and citation anchors, both live possession defects,
failure-stage diagnostics, partial traces and local diagnostic reporting.
Existing future-data, failure-handling and backward-seeking suites still pass.

**Defer another full evaluation.** Targeted coverage still has ten fallbacks,
three timeouts and four audience conflicts. First address the remaining
revision/citation failure cases and evaluate latency policy with provider
metrics and the retained call-stage evidence. Any deadline or retry change
needs its own bounded validation; the current run is not evidence to make
such a change automatically. Full release readiness remains unestablished.

Redacted raw reports, structured progress/partial traces and offline logs are
retained in git-ignored `.local/goal-targeted-live-2026-10-13*` and
`.local/goal-offline-checks.log`. Credentials and endpoints are excluded.

## Follow-up: claim removal, timeout retry and wording fixes

The ten targeted fallbacks were reviewed from their retained check issues.
Most failed on individual facts while the headline and explanation passed,
and the one revision then failed on a different fact. Changes:

- **Removing rejected claims** (`src/explain/prune.ts`). When every problem
  found names an individual fact, interpretation claim or limitation, those
  entries are removed and the rest is checked again; the verifier reviews only
  what remains. Removal adds nothing to an answer. It is refused when a
  problem concerns the headline, explanation or the answer as a whole, when
  no fact would remain, or when the summary repeats a number only a removed
  claim gives. Such answers report `outcome: "revised"` and list each removal.
- **Timeout retry.** A model call that runs out its 25-second deadline is
  retried once with a fresh deadline when at least 15 seconds of the 60-second
  workflow remain. All three follow-up timeouts met that condition.
- **Negated event wording.** "No shots" or "without a shot" no longer counts
  as a claim that a shot happened; an unsupported positive mention is still
  rejected.
- **Prompt rules.** An explained answer needs a citable fact, otherwise it
  answers insufficient evidence; the score is not a citable event; a match
  time and an interval are never combined ("at 19.5 s after the goal").

Offline, `npm run check` passed 60 files / 1,469 tests, type checking and the
production build. A full 36-case live rerun on these changes was started
before merge; its results will be recorded separately. Until then, release
readiness remains unestablished.

## Verified facts: partial live run

Facts are now built in code (`src/explain/factCatalog.ts`); the analyst
chooses among them and writes the headline, explanation and interpretation.
A full 36-case run on commit `4aea640` (DeepSeek-V4-Flash for both roles,
`json_schema`, reasoning `none`, temperature 0, normal pacing) was stopped
after 24 cases because the evaluation machine ran low on memory. It is not
a completed release evaluation.

| Result (24 cases) | Cases |
| --- | ---: |
| Usable explanations | 21 |
| Fallbacks | 3 |
| Timeouts | 0 |

Cases that fell back or were incomplete in the earlier runs were usable:
`demo-goal-recorded` (Analyst), `seed6-offside-recorded` (both),
`seed6-offside-kick-frame` (Analyst) and `seed24-offside-recorded` (Analyst).
The three fallbacks:

- Both `demo-recap` answers: the verifier read the final score at 24 s, the
  demo's full time, as a match in progress, and the Casual draft also
  speculated about an equaliser, which the verifier rightly rejected.
- `seed9-formation-before` (Analyst): the explanation claimed a possession
  spell ended, which the evidence does not show; grounding rejected it in
  the draft and the revision.

Most first drafts were marked explained with an empty facts list and needed
a revision. Commit `583e367` adds the required verified facts to such a
draft in code (then checks and reviews it as usual) and tells the verifier
when it reviews a full-time summary. These two changes have offline tests
only; they have not been measured live. A full 36-case run on the merged
revision is still needed to establish release readiness.
