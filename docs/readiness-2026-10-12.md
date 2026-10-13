# Implementation and verification — October 12, 2026

## October 13 final-revision follow-up

The citation-replay cutoff is fixed for manual answers, automatic cards and
recap navigation, with saved-answer restoration at the cutoff. The final
offline run passed 1,314 tests, type checking and build; it required a
15-second test-runner timeout on this host. Default-timeout stability under
load remains a limitation.

Live release readiness is **not established**. All 36 cases were attempted
on base `482a824dee7585a0f2911c0f6c1908b271558ad7`, working-tree fingerprint
`80f04c5471b14542664ee809de551e0127dca1bfea7cde0f9c43e83c1dc8f1d5`:
26 reviewed explanations, eight fallbacks, one timeout and one provider rate
limit. The strict gate failed. Manual review identified seven accepted answers
with incorrect claims and one additional unsupported directional label.
Two independent judge sessions and same-session admission recovery were
exercised locally; public judge-deployment verification remains outstanding.
Known aggregate usage was 101 model calls and 703,724 tokens, excluding
unreported usage from the two failed workflows. No merge or deployment occurred.

See [final revision, complete matrix, manual findings and reproducible commands](replay-reliability-2026-10-12.md).
This follow-up supersedes the earlier verification and remaining-work status
below; those sections record the preceding implementation history.

This update implements AI reliability, measured patterns, and team/player
personalization. Hosting and deployment remain deferred. The submission guide
contains the elevator pitch, recording script, and remaining submission tasks.

## Delivered

- Per-deployment process pacing, shared provider cooldowns, and one bounded
  retry for short rate limits, without expanding call, token, or time budgets.
- Stronger claim-level action and timestamp grounding, concise verifier output,
  and prompts that prefer measured significance over invented tactical causes.
- Deterministic turnover-to-shot sequences, repeated flank activity, adjacent
  activity windows, and shot-start geometry. Measurements use only final
  retained evidence; incomplete windows suppress sequence/comparison patterns.
- Tactics cards with supporting events and replay controls.
- Match-scoped team/player focus, cutoff-bound focused counts, filtered
  automatic insights and recap highlights, and an explicit whole-match reset.
- Neutral pending-shot labels until a result is revealed.
- Offline CI checks and documentation distinguishing live integration,
  mocked tests, and technologies actually used.

## Verification scope

Offline tests cover backward seeking, future evidence exclusion, invalid
citations, model failure handling, bounded retries, pattern interruptions,
geometry boundaries, partial windows, and preference changes.

The final offline check passed 40 suites and 1,142 tests, TypeScript checking,
and the Next.js production build. Git whitespace validation passed.
CI is configured in the working tree; this does not claim
that a remote GitHub Actions run has executed these uncommitted changes.

Browser interaction checks confirmed focused counts, pattern support/replay,
and earlier-time recomputation. Screenshot capture was unavailable, so these
checks do not establish visual layout quality across viewport sizes.

## Live evaluation

An initial six-case run covered the scripted shot in flight, recorded goal,
and full-time recap in both audiences. It returned no provider errors but
failed the strict quality gate: three fallbacks and one answer flagged for a
missing shot citation. Manual review also found incorrect geography and
unsupported chance-quality language. The fixes above address those findings;
the initial result is not evidence of release readiness.

A second six-case run returned three usable explanations, one fallback, and
two unnecessary insufficient-evidence recaps, again with no provider errors.
It used 13 model calls and failed the strict gate. Shot geography and citation
coverage improved, but this run still did not establish release readiness.

After tightening instructions for filtered recaps and measured accounts, a
four-case goal/recap run passed the strict gate (10 model calls, no errors or
fallbacks). Manual review nevertheless found an unsupported right-side label
in the analyst goal explanation. A new deterministic check rejects undefined
left/right zone mappings, and the final two-case goal run passed both audiences
(six model calls, no errors or fallbacks). Manual inspection confirmed the
final goal accounts use the supplied central-channel geometry and recorded
sequence. Goal response times were 7.0 and 14.5 seconds.

The two in-flight-shot cases passed in the second six-case run, and the two
recaps passed in the later four-case run. Those are results from different
revisions, not one complete six-case pass of the final tree. The broader live
scenario matrix and repeatability under concurrent use remain unverified.

Live reports retain final redacted answers and verification in ignored local
files. A small smoke test establishes only its listed coverage. A passing
automated verifier is not proof that every natural-language claim is true.

## Remaining work

- Validate broader generated-match scenarios and deployment capacity before
  claiming general live reliability; in-process pacing is not a distributed
  quota gateway.
- Complete visual review alongside the separate redesign work.
- Add judge-access hosting and operational controls in the deferred hosting
  phase, then record the under-two-minute demonstration and finish submission.

See [AI evaluation](ai-evaluation.md), [pattern definitions](match-patterns.md),
[service bounds](explain-service.md), and [submission guide](submission.md).
