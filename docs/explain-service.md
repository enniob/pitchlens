# Explain this moment: the analyst service

This document covers the server-side workflow that turns the evidence
foundation ([explain-this-moment.md](explain-this-moment.md)) into
explanations written by a model on Microsoft Foundry. It describes the HTTP
contract the viewer will call, how a match is named safely, the analyst and
verifier steps, their limits, and how to set up and evaluate it.

The viewer calls the service from the **Live insights** panel (the **Game
moments** tab) docked beside the pitch. No Azure resources are created by this code.

## Testing from the viewer

1. Fill in the server-only Foundry settings in `.env` or `.env.local` and run
   `npm run dev`. Use the resource root endpoint, without `/api/projects/...`.
2. Configure the access code and signing secret described under [Setup](#setup),
   then open `http://localhost:3000`, open **AI access** in the header,
   and unlock explanations with that code.
   Play. The **Live insights** panel is
   docked beside the pitch. When play reaches a key moment, an insight card
   for it appears there on its own (see [Live insights](#live-insights)).
3. Select a moment in the strip under the controls to pause at its timestamp,
   or use the current playback time. Choose **Casual Fan** or **Analyst**, then,
   under **Ask about any moment**, **Pause and explain** (while playing) or **Explain this moment** (when paused
   or at full time).
4. The request calls the live Foundry deployment. The answer shows a headline,
   a short explanation and **See the evidence**: one card per cited event or
   snapshot, with a drawing of the positions at that time and a replay button
   starting three seconds earlier. Observable facts, tactical interpretation and
   evidence limitations stay separate under **Facts, reading and limits**.
5. At full time the **Recap** view unlocks. It requests one full-time summary
   (`focus: "match"`, below) and shows it as **How the match unfolded**, beside
   up to three defining moments and final statistics, which are computed in code.
   The highlights favor goals and other significant events, combine events within
   three seconds into one passage, and appear in match order. They are a selected
   recap, rather than a list of every key event. The summary and supporting evidence
   share the viewer's navy palette.

### Live insights

Automatic insight cards use the same request, server workflow, checks and
client validation as an explicit request; only the trigger differs
(`src/components/LiveInsights.tsx`):

- **Which moments.** Goals, shot results (a shot that is scored is covered by
  its goal), every foul and offside, and formation changes (`isInsightMoment` in `src/playback/moments.ts`). Each is
  judged from the event alone, so choosing it needs nothing later in the match.
- **Cut-off.** Each request uses the moment's own time as `timeMs`, so the
  answer can only cite evidence up to that moment, wherever playback is when it
  arrives. A card shows only once playback has reached its moment.
- **Only during play.** A moment triggers when the clock runs into it while
  playing, in steps of at most 2 s. Moments skipped by seeking, or reached
  while paused or by selecting them, are not explained automatically.
- **Bounded.** One automatic request at a time, with at most one waiting (the
  newest); a moment passed over while busy keeps a card with an explicit
  **Explain for …** button. The service's own rate limits still apply; a
  refused request shows a safe error with **Try again**.
- **Late by design.** Answers take roughly 10–20 s, so they arrive after the
  moment and are labelled with its time. Play is never paused for them.
- **Backward seeks.** Seeking back before a moment abandons its request (or its
  place in the queue) and hides its card; reaching it again shows the saved
  card, or asks again if none was saved.
- **Audiences.** New moments are explained for the selected audience. Switching
  shows the saved version for that audience, or an **Explain for …** button
  for the same moment, so both versions use the same evidence.

The newest card is open, with evidence replay and the check row; older cards
show their headline and open on click.

Explicit moment requests (under **Ask about any moment**) are never automatic; the recap summary is requested
the first time the recap opens for each audience and reused after that.

**Browser request scheduling.** The server runs one explanation per session, so
the viewer sends its requests one at a time through a shared browser-side
scheduler (`src/explain/scheduler.ts`, provided per match by
`ExplanationSchedulerScope` in `src/components/ExplanationScheduler.tsx`).
Waiting explicit requests and the recap summary go before a waiting automatic
insight; a request already running is never interrupted for priority. A waiting
insight is replaced by a newer one. A request is never sent once it is
cancelled, playback has moved back before its time, access is locked, or the
viewer has closed or changed match. The match viewer waits three seconds after
each completed, failed or cancelled request before starting the next one.
Provider throttling extends that shared queue's cooldown using the greater of
the response's `retryAfterMs` and `Retry-After`, including on a failed browser
retry. The shared hold is capped at 60 seconds, so an hour-long quota cooldown
fails that request without freezing every later one behind "Queued". A
cancelled request cannot erase a known cooldown. Waiting requests are
rechecked for cancellation and playback relevance before sending; no new HTTP
request is sent during the gap. This reduces bursts and needless `busy`
refusals but cannot guarantee provider capacity: the server's
concurrency, access, quota, budget and response checks are unchanged, and the
client still validates every answer.
Changing the audience or match cancels a pending browser request. Every answer
is kept for the current match: the panel lists earlier ones asked for explicitly under **Your
explanations**, and the recap lists them, with automatic insights, under **Explained moments**,
each opening back in the match at its time. Playing on keeps an answer, marked
as out of date. Seeking back before the explained time hides it, and the list
leaves out any answer asked later than the current time, except while
replaying that answer's own cited evidence; it shows again once playback
reaches that time. Late responses cannot replace the new moment's explanation.
Cancel is also available during loading. A model-service busy error gets one
automatic browser retry after the server's cooldown (ten seconds if none is
provided, and no automatic retry for waits longer than one minute). The retry
keeps the original moment, audience and scheduler slot, and is cancelled with
the original request, including when an automatic insight is hidden by seeking
back before its moment. Quota, access and other errors are not automatically
retried. Errors remaining after the retry offer an explicit retry;
insufficient evidence is displayed as a valid outcome. Both audiences use the
same evidence rules. Browser-side validation repeats the response contract and
checks citations against evidence reachable at the selected time; server-side
validation remains authoritative for what the model was actually shown.

The viewer exchanges a judge access code for a signed, HttpOnly, 30-minute
session cookie. It never receives a Foundry key or the optional machine bearer
token. Without access, playback and deterministic patterns remain available;
manual, automatic and recap AI requests stay locked. An explicit
`PITCHLENS_ACCESS_MODE=local` bypass is available outside production only.

`tests/explain-client.test.ts` and `tests/explanation-panel.test.tsx` use mocked
HTTP responses to cover requests, audience changes, safe errors, retries,
unsupported/future citations, backward seeking, cancellation and evidence replay.
The DOM test dependency is development-only. Live evaluations remain opt-in.

### Kimi deployment compatibility observed during viewer testing

The Kimi-K2.6 deployment initially exhausted the 2,000-token analyst cap with
`finishReason: "length"`, without returning valid JSON. Setting the server-only
`FOUNDRY_REASONING_EFFORT=none` made it return complete answers within the same
budget. `FOUNDRY_TEMPERATURE=0` reduces sampling variability for this factual
task. Both parameters are optional and omitted by default; configure them only
when supported by both deployed models. Restart a running server after editing
its environment if it does not reload the setting automatically.

The [official Kimi model card](https://huggingface.co/moonshotai/Kimi-K2.6#6-model-usage)
documents a `thinking: { type: "disabled" }` parameter for its own API. A
separate small probe through the Foundry v1 endpoint rejected that parameter
with HTTP 400 (`unrecognized_request_argument`); it is therefore not added to
the application client. A live probe confirmed `reasoning_effort: "none"`
works on this deployment; that result should not be assumed for other models.

The verifier schema enumerates the exact targets in each draft, and its prompt
lists them explicitly, so it cannot group a review under a generic field such
as `limitations`. Both prompts explain the fixture's pitch coordinates and
recorded event semantics. Revision instructions ask the model to remove
unsupported optional claims, rather than invent replacements. Token, time,
tool and revision limits are unchanged, as are the cutoff and evidence checks.
Fresh live demo-goal requests passed the quality smoke gate in both audiences.
Earlier trials also showed unsupported wording and quota errors; these settings
do not guarantee every moment will yield a usable answer. Model reviews reduce
errors but do not prove factual correctness.

Verification fallbacks are not cached. On a fallback the service also
supplies an optional `recordedSummary` when one passes the response and
grounding checks: a deterministic account built from the same bounded context
the analyst was given (`recordedAccount` in `src/explain/recorded.ts`). For a
moment it describes the latest supported event. For a full-time summary it
states the final score in the headline and explanation only (no event can be
cited for a score without goals) and lists each recorded goal, then the latest
shots, as single-citation facts; it gives no totals, since the key-event
package may be truncated. A result takes precedence over a turnover recorded at the same instant.
Linked shots are cited alongside their result; goal scores use the existing
bounded score. The analyst receives this account as a factual starting point.
The browser independently recomputes it; one that differs (an altered summary,
or a server on another build) is dropped and the ordinary fallback is shown.
It is shown as a separate kind of card wherever it appears: the open answer,
the collapsed insight card, **Your explanations** and the recap's **Explained
moments**. Each carries a **Match facts, not AI** chip with the list icon
(never the AI spark), dashed edges and a muted title, with a note that no AI
explanation passed the checks and a **Get AI explanation** button. It never
displays rejected model prose or describes this summary as model-reviewed. The AI `explanation`, verification
failure and trace remain unchanged for diagnostics. Without a supported event,
the existing failed-check card remains. Provider errors retain their existing
behavior. This path is covered by scripted tests, not a live model
success-rate measurement.
Genuine insufficient-evidence responses remain distinct. Successful answer
cache keys include deployment, output, reasoning and sampling settings, without keys or
credentials, so a configuration change cannot reuse an old answer.

For a live quality smoke check in PowerShell, using the local `.env` file:

```powershell
$env:PITCHLENS_LIVE_EVAL = '1'
$env:PITCHLENS_LIVE_REQUIRE_EXPLANATION = '1'
node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.live.config.mts -t 'demo-goal-recorded'
```

The extra smoke gate requires reviewed, usable demo-goal explanations in both
audiences; without it the live suite continues to assert safety and report
quality separately. These commands make paid calls to the configured deployment.

## Approach

### Foundry inference over the v1 API

The service calls a model deployed in a Microsoft Foundry resource through the
**Azure OpenAI v1 API** that Foundry exposes:

```
POST https://<resource>.openai.azure.com/openai/v1/chat/completions
api-key: <key>
{ "model": "<deployment name>", "messages": [...], "tools": [...], "response_format": {...} }
```

- The v1 API takes the deployment name as `model` and needs no `api-version`
  parameter. The same path works on `https://<resource>.services.ai.azure.com`.
- It supports function calling (the analyst's evidence tools) and JSON Schema
  structured output (`response_format: { type: "json_schema", strict: true }`).
- It is called with plain `fetch` from a Next.js route handler on the Node.js
  runtime (`src/server/foundry.ts`), so the project needs no new dependency.
  The official `openai` JavaScript SDK also works against this endpoint
  (`baseURL` set to `…/openai/v1/`) and could replace the client later
  without changing anything else.

Microsoft documentation consulted:

- [Azure OpenAI in Microsoft Foundry Models v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Work with chat completion models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/chatgpt)
- [How to use structured outputs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs)
- [Get started with Microsoft Foundry SDKs and endpoints](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview)
- [Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/) and its [repository](https://github.com/microsoft/agent-framework)

### Why not Microsoft Agent Framework

Agent Framework provides agents, tools, workflows and OpenTelemetry tracing,
but its SDKs are for **.NET and Python** (Go is a separate SDK). There is no
TypeScript SDK, and PitchLens is a single Next.js/TypeScript application. Using
the framework would mean running and deploying a second service in another
language, with the evidence tools and the cutoff rules either duplicated there
or called back over the network.

This workflow needs a small part of what the framework offers: one tool loop
with two tools, one verifier call and fixed limits. That is under 300 lines in
`src/server/analyst.ts`, runs in the same process as the evidence code and is
fully covered by mocked tests. If PitchLens later needs multi-agent
orchestration, durable runs or hosted agents, the analyst can move to a
Python or .NET Agent Framework service behind the same HTTP contract. The
browser contract and the evidence tools would not change.

## HTTP contract

`POST /api/explain`, JSON in and out. The types are in `src/explain/api.ts`
and are safe to import in the browser.

### Request

```json
{
  "requestId": "b7f3c2d1-viewer-42",
  "match": { "kind": "sample", "matchId": "synthetic-mvp1-sample-001" },
  "timeMs": 9050,
  "audience": "casual",
  "focus": "moment"
}
```

| Field | Rules |
| --- | --- |
| `requestId` | Optional, 8–64 of `A–Z a–z 0–9 _ -`. Echoed in the answer and the `X-Request-ID` header. The server makes one when it is absent. For correlation only; it is not an idempotency key |
| `match` | A match reference (below). Never a fixture |
| `timeMs` | Playback time in ms, 0 to the match duration. Floored to whole ms |
| `audience` | `casual` (Casual Fan) or `analyst` (Analyst) |
| `focus` | Optional. `moment` (default) explains the selected time. `match` is a full-time summary of the whole match and is only accepted when `timeMs` equals the match duration; anything earlier is rejected with `invalid-request`, so a summary can never describe play the viewer has not reached |

A `match` focus uses the same response contract, validation, grounding checks,
verifier and limits as a moment. Its evidence starts from the key events of the
whole match (goals, shots, set pieces, stoppages and formation changes; ordinary
passes are left out and noted as a limitation) instead of the last 30 seconds,
and its tools can reach back to kickoff. Grounding accepts any score the match
passed through, rebuilt from the goal events, rather than only the final one.

The body must be `application/json` and at most 4 KB. Unknown fields are
rejected.

### Match references: how browser fixtures are resolved

The browser never uploads match data. It names the match, and the server
rebuilds it (`src/explain/matchRef.ts`, `src/server/resolveMatch.ts`):

```jsonc
// The scripted demo
{ "kind": "sample", "matchId": "synthetic-mvp1-sample-001" }

// A match from the set-up drawer: the recipe that produced it
{
  "kind": "generated",
  "matchId": "sim-v5-42-60000-1a2b3c4d",
  "seed": 42,
  "durationMs": 60000,
  "tactics": {
    "home": { "formation": "4-3-3", "changes": [] },
    "away": { "formation": "4-4-2", "changes": [{ "t": 30000, "formation": "4-2-3-1" }] }
  }
}
```

- `matchReferenceOf(fixture, sampleFixture.matchId)` builds the reference for
  the fixture the viewer has loaded. It returns `null` for a fixture the server
  cannot rebuild (older fixtures without generator metadata), and the UI
  should not offer an explanation for those.
- The server checks the reference's shape and bounds (seed, duration 10–180 s,
  known formations, at most 3 changes per team, change times inside the match),
  reruns the deterministic simulator and **accepts the match only if the
  rebuilt `matchId` equals the claimed one**. `matchId` includes the simulator
  version and a hash of the resolved tactics, so a forged or edited recipe, or
  one from another simulator version, is refused with `unknown-match`.
- No text, events or positions from the browser reach the model. Fixture text
  comes only from the server's own simulator and scripted demo, and it is still
  passed to the model as data (see "Prompt safety").
- Rebuilding a 180 s match takes well under a second. The last 8 rebuilt
  fixtures are cached in memory.

### Success (200)

```jsonc
{
  "apiVersion": "1.0.0",
  "ok": true,
  "requestId": "b7f3c2d1-viewer-42",
  "matchId": "synthetic-mvp1-sample-001",
  "timeMs": 9050,
  "audience": "casual",
  "focus": "moment",
  "explanation": { /* ExplanationResponse, see explain-this-moment.md */ },
  "verification": {
    "outcome": "verified",        // verified | revised | insufficient-evidence | fallback
    "revisions": 0,
    "schema": "passed",           // contract and citations
    "grounding": "passed",        // deterministic wording checks
    "modelReview": "passed",      // verifier model; "skipped" when not reached
    "issues": []                  // why drafts were rejected, shortened
  },
  "trace": { "totalMs": 5210, "modelCalls": 2, "toolCalls": 0, "tokens": { "prompt": 9100, "completion": 640 }, "steps": [ /* ... */ ] },
  "cached": false
}
```

The explanation always passes `validateExplanation` against the evidence the
model was given. With `outcome: "fallback"` it is the standard
`insufficient-evidence` response ("Not enough evidence to explain this
moment"), which the UI should show as "could not be explained" rather than as
an error. The UI can show `verification` in the Pro data view, but should
never present it as proof (see "Verification").

### Errors

```json
{
  "apiVersion": "1.0.0",
  "ok": false,
  "requestId": "b7f3c2d1-viewer-42",
  "error": { "code": "rate-limited", "message": "Too many explanation requests. Try again shortly.", "retryable": true, "retryAfterMs": 41000 }
}
```

| Code | HTTP | Retryable | When |
| --- | --- | --- | --- |
| `invalid-request` | 400 | no | Bad JSON, unknown or missing field, bad reference, time, audience or request ID |
| `unauthorized` | 401 | no | A valid judge session or machine bearer token is required |
| `explanations-disabled` | 503 | no | Operator kill switch is enabled |
| `budget-exhausted` | 503 | yes | Daily instance token allowance cannot admit another workflow |
| `session-quota-exhausted` | 429 | no | Session workflow allowance is exhausted |
| `forbidden-origin` | 403 | no | `Origin` is neither this site nor an allowed origin |
| `unknown-match` | 404 | no | The reference does not rebuild to the claimed match |
| `payload-too-large` | 413 | no | Body over 4 KB |
| `unsupported-media-type` | 415 | no | Not `application/json` |
| `rate-limited` | 429 | yes | This client or the instance is over its limit (`Retry-After` set) |
| `busy` | 429 | yes | Too many explanations running at once |
| `internal-error` | 500 | yes | Unexpected failure; details stay in the server log |
| `upstream-error` | 502 | yes | Foundry failed, was unreachable or returned something unusable |
| `not-configured` | 503 | no | Foundry settings are missing or invalid |
| `upstream-rate-limited` | 503 | yes | Foundry is throttling (`Retry-After` passed on) |
| `timeout` | 504 | yes | A model call or the whole workflow ran out of time |

Messages are plain words and safe to show. They never contain credentials,
setting values or provider responses.

## The workflow

`explainMoment` in `src/server/analyst.ts`:

1. **Evidence.** An `EvidenceSession` (`src/explain/evidence.ts`) is built for
   the fixture and selected time. The analyst's first message carries the
   default evidence package from `extractMatchContext`, with player positions
   for the latest snapshot only (every snapshot can still be cited), and its
   **verified facts** (`src/explain/factCatalog.ts`).

   Verified facts are short sentences that application code builds from the
   package's structured fields, never from event descriptions, each with the
   citations it needs: each recent event (who, what, when, and the half for
   turnovers, fouls and free kicks), the measured interval from the latest
   turnover or kickoff to each later shot, goal or offside, shot location,
   pass direction and length, the latest possession spell and opponent
   proximity. Every one must pass `validateExplanation` and `checkGrounding`
   on its own, or it is left out. The model works out no number, interval,
   direction or half itself. Every fact in an answer must be a verified fact,
   copied exactly (spacing, a final full stop and dash style may differ), and
   an explained moment must include the verified fact for each event at the
   latest recorded instant. `list_events` returns verified facts for the
   earlier events it lists, which an answer may then use. The headline,
   explanation and interpretation remain the model's own words, under the
   checks below. A verifier rejection of a verified fact is not followed: it
   is computed from the evidence. An explained draft with an empty facts list
   gets the facts it needs added in code (the latest events' facts for a
   moment; the recorded goals' facts for a full-time summary), listed in
   `issues` as `added verified fact ...`, and is then checked and reviewed as
   usual; a draft that wrote facts of its own is never completed this way.
   The verifier is told whether it reviews a moment or a full-time summary,
   so a final score is not mistaken for a match in progress.
2. **Analyst.** The model may call two tools, at most 6 calls in total:
   - `list_events({ fromMs?, types? })`: revealed events up to the selected
     time, at most 40, from no earlier than 30 s before it
   - `get_positions({ atMs })`: the latest snapshot at or before `atMs`, which
     must be within the same 30 s and not after the selected time

   Both are answered by `extractMatchContext` and enforce the cutoff in code.
   A call for a later time, an earlier one, unknown arguments or an unknown
   tool returns an error to the model instead of data. The model never gets
   the fixture, the simulator or any way to run code. Each draft gets at most
   3 turns, and tools are switched off for the last one.
3. **Checks**, in order:
   1. `validateExplanation` against the evidence the model was actually given
      (the base package plus everything the tools returned): contract, matching
      `matchId` and `timeMs`, citations that resolve, no intent or cause in facts.
      Before this check, exact repeats of a citation within one claim are
      dropped from the model's output (a repeat adds no support); the
      validator itself, and the browser's check, still reject duplicates.
   2. `checkGrounding` (`src/explain/grounding.ts`): deterministic checks of
      the headline, explanation, every claim and every limitation (below).
   3. For an explained moment, a **verifier** model call reviews the
      headline, the explanation and every fact, interpretation and limitation
      against the evidence and returns `supported` or `unsupported` with a reason for each.
      A review that misses a target or is malformed counts as unusable.
4. **Removing rejected claims.** When every problem found, by the contract,
   grounding or verifier check, names an individual fact, interpretation claim
   or limitation, those entries are removed and the rest is checked again
   (`src/explain/prune.ts`). After grounding, the verifier then reviews only
   what is left; after review, every remaining field was already approved.
   Removing a claim adds nothing to the answer. It is not done when any
   problem concerns the headline, the explanation or the answer as a whole,
   when no fact would remain, or when the headline or explanation repeats a
   number that only a removed claim gives. The answer then has
   `outcome: "revised"` and lists each removal in `issues` as `removed: ...`.
5. **One revision.** Otherwise, if a check fails, the analyst gets the problems found
   and one chance to revise. The revision goes through the same checks.
   Where it can be determined exactly, a grounding problem names the evidence
   that would support the wording: the shot behind a cited shot result or
   goal, or the single uncited event that, with an event the claim already
   cites, spans a stated duration. Hints only name events already supplied for
   the selected time, never a pair the claim does not anchor, and do not change
   what passes.
   Revision instructions require removing unsupported event types throughout
   the answer, including its headline. A rejected duration must not be replaced
   with a timestamp calculated from the selected time; event times come from
   supplied event timestamps, never the evidence-window boundary. The model is
   also told to distinguish a penalty kick from a shot inside the penalty area.
   Structurally readable drafts also receive grounding diagnostics when a
   contract check fails, so a long headline does not hide a missing action
   citation until after the single revision. They are listed before the
   contract errors, as the revision request keeps only the first 12 problems.
   A duration hint names an endpoint only when exactly one cited/uncited pair
   fits. Both prompts say a score belongs in the headline or explanation unless
   a fact cites the goal events behind it. These diagnostics never make a
   rejected draft eligible for display or verifier approval. The headline's
   100-character limit is stated in the prompt and schema description because
   strict model schemas omit length-validation keywords.
6. **Fallback.** If the revision also fails, the verifier's answer is unusable,
   or the call or token budget runs out, the result is the
   `insufficient-evidence` fallback with `outcome: "fallback"`.

When the analyst itself answers `insufficient-evidence` and that answer passes
the first two checks, the workflow does not show it. It is not reviewed by
the verifier, so none of its model-written text is shown. It is replaced by
the application's fixed insufficient-evidence response ("The match data up to
this moment is not enough to explain it.") with
`outcome: "insufficient-evidence"`. Every model-written string the browser can
receive has therefore passed all three checks.

### Grounding checks

`validateExplanation` proves citations exist; it cannot read the text.
`checkGrounding` covers the commonest ways text goes further than its
evidence:

- times after the selected time ("at 12.4 s", "12000 ms", "the 3rd minute")
- a score other than the score at the selected time (formations such as
  4-3-3 are not mistaken for scores)
- a shirt number no player wears, or a player named in a claim whose cited
  events do not involve or name them (a cited snapshot shows everyone).
  A shirt number followed by an initial ("#6 S. Okafor") is not read as a time
- events not in the evidence: scoring, a shot's result ("went in", "beat the
  keeper", "on target"), offside, foul, penalty, corner,
  throw-in and save wording must be backed by an event of that kind in the
  claim's citations (for the headline and explanation, in the evidence as a
  whole). A goal earlier than the evidence window is allowed when the score
  shows it. Ordinary phrases such as "a shot on goal", "the penalty area" and
  "the corner of the box" are not treated as events
- a duration in a clause that names two kinds of event (goal, shot, turnover,
  pass, kickoff, offside) must equal the gap between two such events in the
  evidence. A goal counts when it is recorded, not when the shot was struck,
  so "the goal came 6.4 s after the turnover" is rejected when 6.4 s is
  turnover to shot
- a pass called forward or backward must have moved that way, judged from
  its start and end x and its team's `attacksTowards`. Play placed in a
  team's half ("deep in Harbor City's half") must be there by the recorded x
  of the events concerned (halfway line x = 52.5)
- left/right labels for a side, half-space, touchline, flank or wing are
  rejected: the measurements do not define them
- a count of filtered events of one type ("22 ordinary passes were filtered
  out") is rejected anywhere, including limitations: the evidence gives one
  total of mixed types
- limitations get the time, score, player and filtered-count checks, but not
  the event-word check: they describe what is unknown ("whether the shot was
  saved")
- audience limits: Casual Fan explanations are at most 600 characters, 4 facts
  and 2 interpretation claims; Analyst ones use the contract's limits (1 200, 8, 5)

These are string checks with narrow word lists. Passing them does not prove
the text is right.

### Verification is not proof

The verifier is another model reading the same evidence. Its approval lowers
the chance that unsupported text is shown. It does not establish that the
explanation is true, and two models can share the same mistake. The
deterministic checks are narrow by design. The response therefore always
carries its `limitations`, the UI must keep the synthetic-data label visible,
and `verification` must not be shown as a guarantee.

### Audience wording

`casual` asks for plain everyday words, no tactical jargon, names or shirt
numbers, and two or three short sentences. `analyst` asks for precise tactical
vocabulary where the evidence supports it (formations and slots, lines, width,
distances in metres, times to 0.1 s) and strict separation of observations
from readings. Both use the same evidence, tools and checks. The instructions
are in `src/explain/prompts.ts`.

### Limits

| Limit | Value | Where |
| --- | --- | --- |
| Whole workflow | 60 s | `WORKFLOW_LIMITS.totalMs` |
| One model call | 25 s; a call that times out is retried once if at least 15 s of the workflow remain | `modelCallMs`, `timeoutRetryMinMs` |
| Model calls | 8 (analyst turns, reviews and the revision) | `modelCalls` |
| Tool calls | 6 | `toolCalls` |
| Analyst turns per draft | 3, the last without tools | `analystTurns` |
| Completion tokens per call | 2 000 analyst, 1 200 verifier | `analystCompletionTokens`, `verifierCompletionTokens` |
| Tokens in total | 80 000 prompt + completion, enforced as below | `totalTokens` |
| Revisions | 1 | fixed |
| Tool lookback | 30 s before the selected time, 40 events per call | `TOOL_LOOKBACK_MS`, `TOOL_MAX_EVENTS` |
| Route duration | 75 s | `maxDuration` in the route |

The token budget is enforced around every call, the verifier's included:

- **Before** a call, the workflow reserves an estimate of its prompt (one token
  per 3 bytes of the JSON sent, plus overhead, deliberately high) plus its
  whole completion allowance. If that does not fit in what is left, the call
  is not made.
- **After** a call, the provider's reported usage is charged. A call that
  reports no usage is charged its full reservation.
- If the charged total is then over the budget, that call's answer is
  discarded. An over-budget review therefore cannot produce `verified`; the
  result is the fallback.

The trace reports both the provider's `tokens` and the `chargedTokens`
counted against the budget.

A moment explained at the first attempt takes 2 model calls (analyst and
verifier), each sent the evidence package (10–14 KB of JSON with the default
options). The worst case is bounded by the limits above. When the
browser disconnects, the request's abort signal cancels the model call in
progress.

### Prompt safety

- Evidence and the draft under review are sent as JSON between explicit
  `EVIDENCE` / `END EVIDENCE` and `DRAFT` / `END DRAFT` markers. Both prompts
  say they are data and that instructions inside them must be ignored. The
  system instructions contain no fixture text.
- The fixture's free-text `title` and generator metadata are not in the
  evidence (see explain-this-moment.md).
- Tool arguments are parsed and checked in code. Tool results are produced by
  the extractor, never by the model.
- Whatever the model writes, nothing reaches the browser unless it passes
  `validateExplanation` against the evidence that was supplied.

## Credentials and abuse controls

- Foundry settings are read from server environment variables only
  (`src/server/foundry.ts`). The route runs on the Node.js runtime, and no
  `NEXT_PUBLIC_` variable is involved, so nothing reaches the browser bundle.
  Error messages and logs never include the key, the endpoint or provider
  response bodies.
- A request that names a match the server cannot rebuild, or is malformed,
  is rejected before any model call.
- **Rate limits** (`src/server/guard.ts`): 6 uncached requests per authenticated
  identity per minute, 60 per instance and 4 workflows at once. One workflow
  per session is allowed. Forwarded headers never define identity. A separate
  ingress guard admits bounded body reads before parsing (60 per identity,
  240 per instance per minute, 16 at once), with a five-second deadline.
- **Cache:** finished answers are kept for 10 minutes (200 entries) by match
  reference, time and audience, so a repeated request costs no model calls and
  does not spend model tokens or workflow allowance. It still requires access
  and passes the ingress limits.
- **Origin:** a request with an `Origin` header from another site is refused
  unless listed in `PITCHLENS_ALLOWED_ORIGINS`.
- **Access:** defaults closed. Browser users exchange the configured judge code
  for a signed cookie. An optional `PITCHLENS_EXPLAIN_ACCESS_TOKEN` allows machine
  clients using `Authorization: Bearer <token>`; keep it out of browser code.
- **Allowances:** reserve up to 80,000 tokens before each workflow. Defaults are
  1,000,000 tokens per UTC day per instance and 30 workflows per session.
  `PITCHLENS_EXPLANATIONS_DISABLED=1` blocks all explanations immediately on
  subsequent requests, including cache hits; it does not cancel active calls.
- The limits are in memory and per server instance. **Before exposing the
  endpoint publicly**, also put it behind the hosting platform's rate limiting
  or a gateway (for example Azure API Management or Front Door rules), set a
  deployment quotas and billing alerts, and monitor the per-request log.
  See [security controls and hosting limits](security-controls.md).

## Tracing

Each request writes one JSON line to the server log (`console.info`):

```json
{"event":"explain","requestId":"…","status":200,"matchId":"…","timeMs":9050,"audience":"casual","cached":false,"outcome":"verified",
 "trace":{"totalMs":5210,"modelCalls":2,"toolCalls":1,"tokens":{"prompt":9100,"completion":640},"chargedTokens":9740,
  "steps":[{"kind":"model","role":"analyst","ms":2100,"finishReason":"tool_calls","toolCalls":1,"tokens":{"prompt":4200,"completion":40}},
           {"kind":"tool","name":"list_events","ok":true,"ms":3,"events":["e2-pass","e4-pass"],"snapshots":[]},
           {"kind":"model","role":"analyst","ms":1800,"finishReason":"stop","toolCalls":0,"tokens":{"prompt":4700,"completion":420}},
           {"kind":"model","role":"verifier","ms":1300,"finishReason":"stop","toolCalls":0,"tokens":{"prompt":3900,"completion":180}},
           {"kind":"check","stage":"draft","schema":true,"grounding":true,"modelReview":true,"issues":0}]}}
```

The trace records each model call (role, duration, finish reason, token
counts), the tokens charged against the budget, each tool call (name, outcome, duration, the event IDs and snapshot
times it returned) and each check's outcome. It never includes prompts, model
text or reasoning, request bodies, credentials or the endpoint. The same
`trace` is returned to the browser.

## Setup

Copy `.env.example` to `.env.local` (git-ignored) and fill in your own values:

```sh
FOUNDRY_ENDPOINT=https://<your-resource>.openai.azure.com
FOUNDRY_API_KEY=<your-api-key>
FOUNDRY_DEPLOYMENT=<your-analyst-deployment>
PITCHLENS_JUDGE_ACCESS_CODE=<random-access-code>
PITCHLENS_SESSION_SECRET=<separate-random-signing-secret>
# Optional
FOUNDRY_VERIFIER_DEPLOYMENT=<your-verifier-deployment>
FOUNDRY_STRUCTURED_OUTPUT=json_schema
PITCHLENS_ALLOWED_ORIGINS=https://<your-preview-host>
# Machine clients only:
# PITCHLENS_EXPLAIN_ACCESS_TOKEN=<random-token>
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `FOUNDRY_ENDPOINT` | yes | Resource endpoint, `https://<resource>.openai.azure.com` or `https://<resource>.services.ai.azure.com`. `/openai/v1` is added when missing. Must be https |
| `FOUNDRY_API_KEY` | yes | Resource key. Server-side only |
| `FOUNDRY_DEPLOYMENT` | yes | Deployment name of the analyst model. It must support function calling, and JSON Schema structured output unless `json_object` is set |
| `FOUNDRY_VERIFIER_DEPLOYMENT` | no | Deployment for the verifier; defaults to the analyst's. A different model gives a more independent review |
| `FOUNDRY_REASONING_EFFORT` | no | `none`, `minimal`, `low`, `medium` or `high`, sent only when set, for deployments that support it. Applies to the analyst, and to the verifier unless set separately |
| `FOUNDRY_VERIFIER_REASONING_EFFORT` | no | The verifier's reasoning setting, when it should differ from the analyst's |
| `FOUNDRY_STRUCTURED_OUTPUT` | no | `json_schema` (default, strict) or `json_object` for models without strict structured output. The validator enforces the contract either way |
| `PITCHLENS_ALLOWED_ORIGINS` | no | Comma-separated extra origins allowed to call the endpoint |
| `PITCHLENS_JUDGE_ACCESS_CODE` | browser access | Random code, 16–256 characters, exchanged at `/api/session` |
| `PITCHLENS_SESSION_SECRET` | browser access | Independent random signing secret, at least 32 characters |
| `PITCHLENS_ACCESS_MODE` | no | `local` explicitly bypasses access checks outside production only |
| `PITCHLENS_EXPLAIN_ACCESS_TOKEN` | no | Optional machine bearer credential, independent of judge access |
| `PITCHLENS_DAILY_TOKEN_BUDGET` | no | Positive integer token allowance per UTC day per instance; default 1,000,000 |
| `PITCHLENS_SESSION_EXPLANATIONS` | no | Positive integer workflow allowance per session; default 30 |
| `PITCHLENS_EXPLANATIONS_DISABLED` | no | `1` blocks explanation requests before reading bodies or serving cache |

Without the three required variables the endpoint answers `503
not-configured`, and everything else (viewer, simulator, tests) works as before.

Authentication uses the resource key. Microsoft Entra ID (keyless) access
would need a token provider such as `@azure/identity` and is not implemented.

## Tests and evaluation

Two kinds of test, reported separately:

| Command | Kind | Network | What it shows |
| --- | --- | --- | --- |
| `npm test` | Mocked | None | The workflow's logic, with a scripted fake model and a fake `fetch` |
| `npm run test:live` | **Live** | Foundry | How a real deployment behaves on fixed moments. Opt-in and paid |

Mocked suites:

- `tests/explain-matchref.test.ts`: references for the demo and for set-up
  drawer matches (with a formation change) rebuild the same fixture; forged
  seeds, tactics and IDs are refused; malformed references are rejected
- `tests/explain-evidence.test.ts`: at every event time and 1 ms before, in
  four fixtures, no tool returns anything after the selected time; refusals for
  later and too-early times and malformed calls; pending shots stay pending;
  citations to tool results are accepted only after the tool returned them
- `tests/explain-grounding.test.ts`: future times, wrong scores, unknown or
  uncited players, events that are not in the evidence, formations that look
  like scores, goals outside the window and audience limits
- `tests/explain-workflow.test.ts`: verified, revised and fallback paths;
  the analyst's own insufficient-evidence answer replaced by the fixed one;
  reviewed limitations; token reservation, over-budget reviews and missing usage;
  verifier rejections and unusable reviews; tool use and refusals; the tool
  loop, call, token and time limits; timeouts, aborts and provider errors;
  only pre-cutoff evidence in prompts; nothing sensitive in the trace
- `tests/explain-foundry.test.ts`: configuration and endpoint normalisation,
  the request sent to Foundry, the strict schema, tool calls, and mapping of
  429/5xx/timeouts/malformed bodies without leaking the key
- `tests/explain-api.test.ts`: the HTTP contract, request IDs, caching, every
  rejection, the origin and token checks, rate and concurrency limits, and
  error mapping
- `tests/explain-eval-scenarios.test.ts`, `tests/explain-eval-failures.test.ts`
  and `tests/explain-eval-report.test.ts`: the scenario evaluation described in
  [ai-evaluation.md](ai-evaluation.md)

Live evaluation (`tests-live/explain.live.test.ts`) runs the evaluation
scenarios from `tests/support/scenarios.ts` for both audiences. By default it
runs the 7 scenarios marked `live` (14 workflows, at most 112 model calls). It
runs only with `PITCHLENS_LIVE_EVAL=1` and the Foundry variables set:

```sh
PITCHLENS_LIVE_EVAL=1 FOUNDRY_ENDPOINT=https://<your-resource>.openai.azure.com \
  FOUNDRY_API_KEY=<your-api-key> FOUNDRY_DEPLOYMENT=<your-deployment> npm run test:live
```

It **asserts** the deterministic release blockers, which must hold
whatever the model writes: the response validates against evidence the tools
could have returned, no later event, time, score or formation appears, and
`matchId` and `timeMs` match. It **reports** a Markdown table and summary:
outcome counts, scenario and audience, safety separately from a usable
explanation, latency, model and tool calls, input and output tokens, and an
estimated cost when prices are configured. Bounds, prices and the report file
are described in [ai-evaluation.md](ai-evaluation.md). Model output varies
between runs, so treat the summary as a sample, not a benchmark.

## Not implemented yet

- Rate limits and the answer cache are per instance and in memory.
- Keyless (Entra ID) authentication, streaming and response caching across
  instances are not implemented.
- Grounding checks are lexical. The verifier is a model. Neither proves an
  explanation is correct.

## Deployment pacing and bounded retries

`FOUNDRY_REQUESTS_PER_MINUTE` optionally spaces model requests according to the
deployment's allocated request quota. Analyst and verifier clients share the
same per-process scheduler when they use the same endpoint and deployment.
The scheduler honors a provider's `retry-after-ms` or `retry-after` cooldown
across subsequent workflows, and queued waits cancel with the workflow signal.
Token quota and other server instances can still cause throttling; this is not
a replacement for deployment quota management or a distributed gateway.

Queue waits count inside the existing 25-second model-call and 60-second
workflow deadlines. Very low quotas (for example one or two requests per
minute on a shared analyst/verifier deployment) cannot reliably complete a
reviewed workflow within those bounds. Contention can also exhaust a deadline;
the in-process scheduler does not promise FIFO fairness. Configure adequate
capacity or a separate verifier deployment rather than extending deadlines
without measurement. An aborted queued request is reported as a timeout and
its conservative reservation still counts against the workflow budget.

A workflow retries a 429 at most once per logical call, only for cooldowns
under five seconds that fit its remaining call and workflow deadlines. Each
attempt counts toward the existing eight-call ceiling; a failed attempt is
charged its conservative token reservation. Longer cooldowns are returned to
the caller as actionable rate limits. Retries do not expand time or token
budgets. Other provider errors are not automatically retried.

This follows Microsoft's documented request pacing and retry headers:
[Manage Azure OpenAI quota](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota).
Configuration must reflect the resource's actual quota; these changes have
offline regression coverage and do not establish a live deployment's capacity.

Claim-level grounding now checks numeric timestamps against the claim's own
event/snapshot citations. Elapsed durations require two cited endpoints; whole
seconds may round by half a second. Explicit activity windows must match a
supplied measurement and cite all of its supporting events. A possession
duration must match a supplied possession spell and cite both entries of its
`cite` list, because the spell is read from snapshots between them. These checks catch
the previously observed missing goal citation for a seven-second interval,
but remain heuristics rather than proof of every natural-language claim.
