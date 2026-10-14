# PitchLens release readiness

## Current status

Azure hosting and deployment are complete, as confirmed by the project owner.
Deployment is distinct from verification of judge access and live AI behavior.

The [deployment workflow](https://github.com/enniob/pitchlens/actions/runs/38450685813)
successfully deployed `aaef1f3`. The public
[application](https://pitchlens-cubrekc4a8a0g8gp.westus3-01.azurewebsites.net/)
returned HTTPS 200. Browser checks confirmed the 3D scripted demo, measured
statistics/patterns and full-time recap. The judge-session API accepted the
configured access code, issued an authenticated session and supported logout.
The bounded deployed-session test passed for two independent judge sessions:
both audiences returned usable, checked explanations, and repeat requests
returned the correct cached audience versions. Browser recap replay restored
the earlier 0–0 score and disabled Recap before full time. Rewinding to kickoff
removed later markers and statistics; preference controls applied team/player
filters. Browser AI citation replay verification is still being collected.
Generated-match setup and playback were also checked with seed 9, a 60-second
sequence and 4-3-3 formations on both teams.

The implementation reviewed is based on `aaef1f3`, with a documentation-only
follow-up at `5f53884`. Offline verification of that implementation passed 62
suites and 1,532 tests, TypeScript checking and the production build.

After the pass-duration fix, all 62 suites / 1,533 tests passed with a
30-second test-runner timeout on this host. The default-timeout attempt was
stopped after three existing CPU-heavy suites exceeded five seconds under
host load. Application/model deadlines and assertions were unchanged.

## Final live matrix — October 13, 2026

The strict release gate passed for all 18 scenarios in both audiences:
**36/36 usable explanations**, no fallbacks, provider errors, skipped cases,
deterministic safety blockers or factual audience conflicts. Outcomes were
five verified and 31 revised; revised includes adding verified facts or
removing rejected claims in code, not necessarily another model draft.

The run finished at `2026-10-13T23:38:21.500Z` after 43.6 minutes, including
65-second cooldowns. Both roles used `DeepSeek-V4-Flash`, JSON schema output,
reasoning `none` and temperature 0. Existing bounds remained 36 workflows,
288 model calls maximum, 80,000 tokens and 60 seconds per workflow. Actual
usage was 80 model calls, no tool calls, 569,395 input and 13,171 output tokens.
Workflow latency excluding deliberate cooldowns was median 7.9 seconds and
maximum 20.0 seconds. Monetary cost was not estimated because no prices were
configured. This is one bounded sample, not a production capacity benchmark.

Evaluated base: `5f5388498a7f8736cb0f39d91a5bf03216c8801f` (a documentation-only
follow-up to deployed `aaef1f3`), with the pass-duration fix. Implementation/test
SHA-256: `0c3bb1fab2d9a486f1b0d1b87883fa1e29970015c64df46531553857f5cfb5ef`.
The fingerprint was unchanged throughout the run. Scenario version is
`2026-10-13`, fingerprint `4ef6d7b78331d548`.

Retained wording was reviewed alongside the checks, including interval
endpoints, backward-pass direction, pitch halves, offside timing, final scores,
formation boundaries and possession/proximity source measurements. The
full report and redacted answers are retained locally. This review and model
approval reduce risk; neither proves every natural-language claim true.

Informational audience heuristics flagged eight Casual Fan answers for number
density and one for snapshot wording; two Analyst answers cited fewer distinct
references than their Casual Fan counterparts. These are readability/detail
notes, not factual conflicts or failures of the strict gate, and remain useful
editorial polish items.

Two Analyst recaps included model-facing catalog labels such as `(F1, F2)`.
After the live matrix, the browser transport was updated to remove only those
parenthesized display labels, preserving facts and structured replay evidence.
All 36 retained answers then passed offline browser validation and cleanup.
The model/evidence/server workflow is unchanged by this display-only follow-up;
the live matrix's fingerprint predates that browser/test change.
Final validation after this follow-up passed 62 suites / 1,534 tests,
TypeScript checking and the production build, using the same 30-second
test-runner allowance. No model requests are made by the retained-answer replay.

## Remaining acceptance checks

- Merge and deploy the reviewed pass-duration fix and display cleanup after
  owner authorization. The last verified Azure deployment in this report is
  `aaef1f3`; check the live revision before submitting.
- Verify the deployed browser flow: judge sign-in, scripted demo, generated
  match, live explanation, audience switching, evidence replay, backward
  seeking, preferences and recap. Record the tested deployment URL and revision.
- Publish the functioning demonstration video under two minutes and add its
  public URL to the submission materials.
- Confirm registration, category, submission completion and access through
  the end of judging. Keep judge credentials out of public documentation.

The strict gate passed after the pass-duration fix and display cleanup described
above. Keep the retained evaluation reports and provider logs outside the public
repository; they are not needed for the judge walkthrough.

See [judge instructions](judge-instructions.md) and [submission guide](submission.md).
The [finished 1:56 demonstration](demo-recording.md) and exact narration are
included in the repository. Public video hosting and submission of its URL remain
outstanding. The recording used the local production build and live Foundry
requests; it does not establish verification of the latest Azure deployment.
