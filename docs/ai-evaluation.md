# AI evaluation of "Explain this moment"

This report covers the evaluation of the explanation service
([explain-service.md](explain-service.md)) on reproducible synthetic
scenarios. All match data is synthetic. Fictional teams and players only.

| | |
| --- | --- |
| Evaluated commit | `7bf89c8` (branch `feature/ai-evaluation`, on top of `fbe4c50`) |
| Scenarios | 18 scenarios × 2 audiences = 36 cases |
| Offline (mocked) results | Every case passes. No release blocker found after the three grounding fixes below |
| Live (Microsoft Foundry) results | **Not run**: the owner has not authorised paid calls for this change |
| Model and deployment settings | Not applicable without a live run. The workflow limits are unchanged (`WORKFLOW_LIMITS` in `src/server/analyst.ts`) |

Model verification does not prove that an explanation is factually correct.
Passing these checks reduces the risk of unsupported text. It does not rule it
out.

## Scenarios

`tests/support/scenarios.ts`. Times and event IDs are derived from the fixtures
rather than hard-coded, so a simulator change that moves an event fails the
suite instead of quietly testing a different moment. Generated matches use
60 s, seeds 2, 3, 9, 20, 24 and 28, and the away side switches from 4-3-3 to
4-2-3-1 at 30 s.

| Situation | Scenarios |
| --- | --- |
| Goal before and after it is recorded | `demo-goal-before` (1 ms before), `demo-goal-recorded`, `seed9-goal-before`, `seed9-goal-recorded`, `seed28-second-goal` (first goal outside the evidence window) |
| Pass and shot in flight | `demo-pass-in-flight`, `demo-shot-in-flight` |
| Offside with a recorded kick frame | `seed2-offside-kick-frame` (before the flag), `seed2-offside-recorded`, `seed24-offside-recorded` |
| Formation change | `seed9-formation-before` (1 ms before), `seed9-formation-recorded` |
| Sparse evidence, zero goals | `demo-sparse` (no event yet), `seed3-zero-goal-moment`, `seed3-zero-goal-recap` |
| End-of-sequence recaps | `demo-recap`, `seed3-zero-goal-recap`, `seed20-recap-two-goals`, `seed28-recap-two-goals` |

Each scenario defines:

- **Expected facts**: what a usable answer covers. Matched by the events it
  cites, or for a few facts by a loose pattern ("0–0", "goalless"). Exact
  wording is never matched.
- **Forbidden future facts**: added automatically for every scenario (later
  event IDs, times, scores and formations), plus scenario-specific wording
  such as a shot's result while it is in flight, an offside before the flag,
  or a restart before it happens. A sentence that also says the fact is
  unknown ("whether the shot went in is not known") is allowed.
- **Acceptable uncertainty**: whether insufficient evidence is an honest
  answer for the moment (`demo-sparse`, the kick frame, 1 ms before a
  formation change, an ordinary moment in a goalless match) or a failure to
  explain.

## How answers are judged

`tests/support/assess.ts` is an independent oracle. It does not reuse the
production grounding checks. It reports three levels separately:

1. **Release blockers** (deterministic). These are a contract or citation
   failure against everything the tools could have returned, a fabricated or
   later reference, the wrong match, time, audience or focus, a later event
   ID, time, score or formation anywhere in the text, or an outcome that
   claims verification without every check passing.
2. **Possible leaks** (wording heuristics). A sentence states a scenario's
   forbidden future fact.
3. **Unsupported claims** (wording heuristics). A claim's event wording, shot
   result, time, player, score or formation is not backed by what that claim
   cites, or the claim invents a metric or attribute the data does not have
   (xG, percentages, speeds, fatigue).

Valid JSON and resolvable citations are necessary, not sufficient. The suite
shows adversarial drafts that pass `validateExplanation` and are still
flagged. The resulting quality is one of `usable`, `incomplete`,
`honest-insufficient`, `not-explained` (safe, not useful), `needs-review` or
`unsafe`. In the live report, safety passing and a usable explanation are
counted separately.

## Offline results

All mocked tests, no network: `npm test`.

| Suite | What it shows |
| --- | --- |
| `tests/explain-eval-scenarios.test.ts` | Every scenario is well formed and its expected facts are reachable. Across all 36 cases, no later event ID, later score, later formation, fixture title or generator metadata reaches any prompt or tool result, even when tools are asked for the selected time + 1 ms. A grounded answer is `verified` and assessed `usable` (or `honest-insufficient` for sparse moments). 24 adversarial "future fact" probes pass JSON and citation checks but are flagged by the assessment. Each probe is removed by a revision when rejected |
| `tests/explain-eval-failures.test.ts` | For all 36 cases: 8–9 kinds of malformed answer (not JSON, cut off at the token limit, wrong shape, invented event, missing snapshot, later event, other match, other time, intent stated as fact) are rejected and replaced by a revision, or by the fallback when repeated. A double verifier rejection and three kinds of unusable review end in the fallback. Provider errors, rate limits, timeouts and a verifier failure after a good draft are errors, never an unreviewed answer. Call and token exhaustion ends in the fallback. Through the endpoint, errors map to 502/503/504 without the key, fallbacks are not cached, and the cache never serves another audience or time. The viewer client refuses answers for another match, time or audience |
| `tests/explain-eval-report.test.ts` | Live bounds and ceilings, cost arithmetic, outcome counting, safety vs. usable, secret redaction |

Validation on `7bf89c8`, in a clean worktree:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: 1 076 of 1 079 passed. The 3 failures are timeouts (5 s default)
  in existing simulator-heavy tests (`simulation.test.ts`,
  `formations.test.tsx`, `explain-evidence.test.ts`) under parallel load on
  the evaluation machine. Pristine `fbe4c50` fails the same 3 tests in the
  same way, and they pass when run alone (55/55). The new evaluation and
  grounding suites pass: 479 tests.
- `npm run test:live` without credentials: skipped (1 passed, 14 skipped).

## Findings and fixes

The evaluation found three defects in the deterministic grounding checks
(`src/explain/grounding.ts`). Each is fixed, with a regression test in
`tests/explain-grounding.test.ts`.

1. **Shirt number read as a time.** An event description such as
   `#6 S. Okafor` was read as "6 s". Early in a match, a fact that faithfully
   quoted a recorded event was rejected as a future time. That turned a
   usable answer into a fallback. Times are no longer matched straight after
   `#`.
2. **Players named in a cited event's own description.** The description
   "wins the ball from #8 F. Lindqvist" or "blocked by #6 M. Silvi" names a
   second player who is neither `playerId` nor `recipientId`. Repeating it
   was rejected. A player named in the cited event's recorded description now
   counts as part of that evidence.
3. **A shot's result before it is revealed.** With a verifier that approved
   everything, "the shot went in", "beat the keeper" or "on target" was shown
   as *verified* while the shot was still in flight. This is an unsupported
   claim accepted as verified, and it reads like a spoiler. That wording now
   needs a revealed goal, shot result, deflection or resolved shot in scope.

## Remaining risks and limitations

- **Verifier-dependent wording.** Five probe kinds are stopped only by the
  verifier: a pass completed while in flight, a restart or kickoff before it
  happens, winning the ball before any event, a formation change before it
  happens, and naming the later formation (4-2-3-1) before it applies. The
  model is never given this information (proven offline), so it can appear
  only as a guess. Grounding does not check formation names: doing so would
  change existing behaviour for fixtures without formation data. If a lenient
  verifier lets any of these through, the assessment marks the answer
  `needs-review` or `unsafe`. A live run reports it.
- The leak and support checks are narrow lexical heuristics. A passing answer
  is not proven true, and a flagged one needs a human to look at it.
- Offline results use a scripted model. They test the workflow's handling of
  answers, not the quality of a real model's answers.
- The existing simulator-heavy tests are close to their 5 s timeout on a busy
  machine (see above). This is not changed here.

## Release blockers

| Blocker | Status |
| --- | --- |
| Future-event leakage | No leakage into prompts or tool results in any of the 36 cases. Later IDs, times, scores and formations in text are deterministic blockers in the assessment. Guessed future wording: see "Verifier-dependent wording" |
| Accepted fabricated evidence references | None accepted: invented, missing and later references are rejected in every case, by the server and again by the viewer client |
| Unsupported claims accepted as verified | Fixed for pending shot results. Other kinds of guessed wording depend on the verifier. **Live behaviour not measured** |
| Secrets exposed | None found. Errors and reports never contain the key or endpoint, and the live report redacts error text. No environment files are committed |
| Responses shown for the wrong match/time/audience | Refused by the client in all 36 cases. The cache is separated by audience and time |

**Remaining blocker for release sign-off:** run the live evaluation with
owner authorisation and review its flagged answers.

## Running the live evaluation

Opt-in and paid. Load credentials from a local, git-ignored `.env` file. Never
print keys and never commit environment files. Run it only with the owner's
authorisation. In PowerShell:

```powershell
$env:PITCHLENS_LIVE_EVAL = '1'
# Optional: prices per million tokens from your deployment's price sheet, for the cost estimate.
$env:PITCHLENS_PRICE_INPUT_PER_MTOK = '<input price>'
$env:PITCHLENS_PRICE_OUTPUT_PER_MTOK = '<output price>'
# Optional: also write the Markdown report to a git-ignored path or one outside the repository.
$env:PITCHLENS_LIVE_REPORT = "$env:TEMP\pitchlens-live-report.md"
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.live.config.mts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PITCHLENS_LIVE_SCENARIOS` | `default` | `default` (the 7 scenarios marked `live`), `all`, or a comma-separated list of scenario IDs |
| `PITCHLENS_LIVE_AUDIENCES` | `casual,analyst` | Audiences to run |
| `PITCHLENS_LIVE_MAX_CASES` | 14 | Cases in the run, at most 40 |
| `PITCHLENS_LIVE_MAX_MODEL_CALLS` | cases × 8 | Model calls for the whole run, at most 320. A case starts only if a worst-case workflow (8 calls) still fits. A failed case counts as 8 |
| `PITCHLENS_PRICE_INPUT_PER_MTOK`, `PITCHLENS_PRICE_OUTPUT_PER_MTOK` | none | Analyst prices per million tokens. Without them, cost is "not estimated" |
| `PITCHLENS_PRICE_VERIFIER_INPUT_PER_MTOK`, `PITCHLENS_PRICE_VERIFIER_OUTPUT_PER_MTOK` | analyst prices | For a separate verifier deployment |
| `PITCHLENS_PRICE_CURRENCY` | `USD` | Label only |
| `PITCHLENS_LIVE_REPORT` | none | Also write the Markdown report to this file |
| `PITCHLENS_LIVE_REQUIRE_EXPLANATION` | off | Smoke gate: `demo-goal-recorded` must be a reviewed explanation |

The run asserts only the deterministic release blockers. It reports, for each
case:

- scenario and audience;
- outcome (verified, revised, insufficient evidence, fallback, error or
  skipped);
- safety and quality;
- flag count and latency;
- model calls, tool calls, and input and output tokens;
- estimated cost.

It then gives totals and lists every flagged answer for human review. The
report names deployments and model settings, never the endpoint or key.
