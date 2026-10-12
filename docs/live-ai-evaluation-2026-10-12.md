# Live AI evaluation — October 12, 2026

## Conclusion

Partial confirmation only. The live Microsoft Foundry integration produces reviewed explanations, but the broad evaluation is not complete enough for release sign-off. The 36-case run returned two answers and 34 rate-limit errors. A subsequent two-case demo-goal smoke check, with a 65-second gap between workflows, returned two explanations that passed the automated safety and quality checks.

These runs used the current checkout at commit `fe5a192`, including existing uncommitted rendering work. No production implementation was changed for the evaluation. All football data is synthetic.

## Findings

- The initial sandboxed attempt could not reach the provider. The reports below are from runs with network access.
- The broad run produced one automatically usable answer and one answer flagged for review. Its remaining 34 cases returned `rate-limited`; goals, offsides, formation changes, sparse evidence and recaps therefore were not validated by that run.
- The broad run flagged the Analyst pass-in-flight answer: `facts[2] gives the time 2.8 s, which matches nothing it cites`. The original answer was not retained, so this flag is unresolved rather than a confirmed false claim.
- The paced goal check passed both audience smoke gates. Actual workflow latency was 10.5 s for Casual Fan and 16.0 s for Analyst, excluding the deliberate 65-second cooldown. These two samples are not a latency benchmark.
- The Casual Fan draft was rejected for claiming a swift counter left opponents little time to reorganise; the revision removed that interpretation. The Analyst draft was rejected for describing a snapshot as "in the net" without a cited shot result; its revision passed.
- Manual review of the final Analyst answer found a residual citation concern missed by the automated assessment and verifier: an interpretation says progression from midfield to goal took "approximately 7 seconds", but cites only the turnover at 2.4 s and final completed pass at 8.1 s (5.7 s apart). The goal at 9.4 s would support the seven-second interval, but is absent from that claim's citations. Treat this as needing review despite automated `usable` status.
- These evaluations invoke the server workflow directly. They do not establish browser behavior or deployed endpoint reliability.
- Vitest reports provider-error cases as passing because the suite deliberately records provider errors without failing assertions. Consequently, `36 passed` is not evidence of 36 successful explanations. The outcome tables below are authoritative for completion.
- Failed workflows may have consumed model tokens before a later call failed. Their usage is absent from the report totals; the broad run's totals are a lower bound. No prices were configured, so cost was not estimated.

## Next actions before release sign-off

1. Repeat the representative live scenarios with quota-aware pacing and retained answers for manual review; inspect retry guidance or increase deployment quota before another unpaced full run.
2. Review and correct the timestamp/citation issues, then rerun the affected cases.
3. Require coverage and useful outcomes explicitly for release sign-off rather than relying on the live suite's process exit code.
4. Validate the judge-facing browser and endpoint flow separately.

## Broad run (unpaced)

## Live evaluation

- Commit: `fe5a192`, run 2026-10-12T09:37:41.101Z
- Model settings: deployment=Kimi-K2.6, verifierDeployment=Kimi-K2.6, structuredOutput=json_schema, reasoningEffort=none, temperature=0
- Bounds: 36 cases, 288 model calls; scenarios all

| Scenario | Audience | Outcome | Safety | Quality | Flags | Seconds | Model calls | Tool calls | Input tokens | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| demo-pass-in-flight | casual | verified | pass | usable | - | 5.7 | 2 | 0 | 6722 | 412 | - |
| demo-pass-in-flight | analyst | verified | pass | needs-review | 1 | 5.6 | 2 | 0 | 6818 | 558 | - |
| demo-shot-in-flight | casual | error (rate-limited) | - | - | - | 10.0 | - | - | - | - | - |
| demo-shot-in-flight | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| demo-goal-before | casual | error (rate-limited) | - | - | - | 1.2 | - | - | - | - | - |
| demo-goal-before | analyst | error (rate-limited) | - | - | - | 6.0 | - | - | - | - | - |
| demo-goal-recorded | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| demo-goal-recorded | analyst | error (rate-limited) | - | - | - | 0.2 | - | - | - | - | - |
| demo-sparse | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| demo-sparse | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| demo-recap | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| demo-recap | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed2-offside-recorded | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed2-offside-recorded | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed2-offside-kick-frame | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed2-offside-kick-frame | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed24-offside-recorded | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed24-offside-recorded | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-goal-before | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-goal-before | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-goal-recorded | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-goal-recorded | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-formation-before | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-formation-before | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-formation-recorded | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed9-formation-recorded | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed3-zero-goal-moment | casual | error (rate-limited) | - | - | - | 0.2 | - | - | - | - | - |
| seed3-zero-goal-moment | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed3-zero-goal-recap | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed3-zero-goal-recap | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed20-recap-two-goals | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed20-recap-two-goals | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed28-recap-two-goals | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed28-recap-two-goals | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed28-second-goal | casual | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |
| seed28-second-goal | analyst | error (rate-limited) | - | - | - | 0.1 | - | - | - | - | - |

Outcomes: verified 2 · revised 0 · insufficient evidence 0 · fallback 0 · error 34 · skipped 0
Safety (no release blocker): 2 passed, 0 failed. Usable explanations: 1; honest insufficient evidence: 0; flagged for review: 1.
Totals: 4 model calls, 0 tool calls, 13540 input and 970 output tokens; median 0.1 s, max 10.0 s.
Estimated cost: not estimated (no prices configured).

Safety passing means no deterministic release blocker was found; it does not make an answer usable or true. Model review is not proof of factual correctness.

### Flags for human review

- demo-pass-in-flight (analyst): unsupported? facts[2] gives the time 2.8 s, which matches nothing it cites

## Paced demo-goal smoke check

## Live evaluation

- Commit: `fe5a192`, run 2026-10-12T09:40:58.974Z
- Model settings: deployment=Kimi-K2.6, verifierDeployment=Kimi-K2.6, structuredOutput=json_schema, reasoningEffort=none, temperature=0
- Bounds: 2 cases, 16 model calls; scenarios demo-goal-recorded

| Scenario | Audience | Outcome | Safety | Quality | Flags | Seconds | Model calls | Tool calls | Input tokens | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| demo-goal-recorded | casual | revised | pass | usable | - | 10.5 | 4 | 0 | 23239 | 926 | - |
| demo-goal-recorded | analyst | revised | pass | usable | - | 16.0 | 3 | 0 | 18243 | 1338 | - |

Outcomes: verified 0 · revised 2 · insufficient evidence 0 · fallback 0 · error 0 · skipped 0
Safety (no release blocker): 2 passed, 0 failed. Usable explanations: 2; honest insufficient evidence: 0; flagged for review: 0.
Totals: 7 model calls, 0 tool calls, 41482 input and 2264 output tokens; median 10.5 s, max 16.0 s.
Estimated cost: not estimated (no prices configured).

Safety passing means no deterministic release blocker was found; it does not make an answer usable or true. Model review is not proof of factual correctness.

