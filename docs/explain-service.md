# Explain this moment: the analyst service

This document covers the server-side workflow that turns the evidence
foundation ([explain-this-moment.md](explain-this-moment.md)) into
explanations written by a model on Microsoft Foundry. It describes the HTTP
contract the viewer will call, how a match is named safely, the analyst and
verifier steps, their limits, and how to set up and evaluate it.

The UI does not call the service yet; wiring it into the viewer belongs to
the integration work. No Azure resources are created by this code.

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
  "audience": "casual"
}
```

| Field | Rules |
| --- | --- |
| `requestId` | Optional, 8–64 of `A–Z a–z 0–9 _ -`. Echoed in the answer and the `X-Request-ID` header. The server makes one when it is absent. For correlation only; it is not an idempotency key |
| `match` | A match reference (below). Never a fixture |
| `timeMs` | Playback time in ms, 0 to the match duration. Floored to whole ms |
| `audience` | `casual` (Casual Fan) or `analyst` (Analyst) |

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
  "matchId": "sim-v4-42-60000-1a2b3c4d",
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
| `unauthorized` | 401 | no | An access token is configured and missing or wrong |
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
   default evidence package from `extractMatchContext`.
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
   2. `checkGrounding` (`src/explain/grounding.ts`): deterministic checks of
      the headline, explanation, every claim and every limitation (below).
   3. For an explained moment, a **verifier** model call reviews the
      headline, the explanation and every fact, interpretation and limitation
      against the evidence and returns `supported` or `unsupported` with a reason for each.
      A review that misses a target or is malformed counts as unusable.
4. **One revision.** If a check fails, the analyst gets the problems found
   and one chance to revise. The revision goes through the same checks.
5. **Fallback.** If the revision also fails, the verifier's answer is unusable,
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
  events do not involve them (a cited snapshot shows everyone)
- events not in the evidence: scoring, offside, foul, penalty, corner,
  throw-in and save wording must be backed by an event of that kind in the
  claim's citations (for the headline and explanation, in the evidence as a
  whole). A goal earlier than the evidence window is allowed when the score
  shows it. Ordinary phrases such as "a shot on goal", "the penalty area" and
  "the corner of the box" are not treated as events
- limitations get the time, score and player checks, but not the event-word
  check: they describe what is unknown ("whether the shot was saved")
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
| One model call | 25 s | `modelCallMs` |
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
- **Rate limits** (`src/server/guard.ts`): 6 requests per client per minute,
  60 per instance per minute and 4 workflows at once. The client is identified
  by the first `X-Forwarded-For` address, which a client can forge unless the
  hosting platform overwrites it, so the per-instance limit also applies.
- **Cache:** finished answers are kept for 10 minutes (200 entries) by match
  reference, time and audience, so a repeated request costs no model calls and
  does not count against the limits.
- **Origin:** a request with an `Origin` header from another site is refused
  unless listed in `PITCHLENS_ALLOWED_ORIGINS`.
- **Access token:** with `PITCHLENS_EXPLAIN_ACCESS_TOKEN` set, requests must
  send `Authorization: Bearer <token>`. Use it for private previews. A token
  shipped to browsers is not a secret, so a public deployment needs real user
  authentication or gateway controls instead.
- The limits are in memory and per server instance. **Before exposing the
  endpoint publicly**, also put it behind the hosting platform's rate limiting
  or a gateway (for example Azure API Management or Front Door rules), set a
  spending cap or quota on the Foundry deployment, and monitor the per-request
  log.

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
# Optional
FOUNDRY_VERIFIER_DEPLOYMENT=<your-verifier-deployment>
FOUNDRY_STRUCTURED_OUTPUT=json_schema
PITCHLENS_ALLOWED_ORIGINS=https://<your-preview-host>
PITCHLENS_EXPLAIN_ACCESS_TOKEN=<random-token>
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `FOUNDRY_ENDPOINT` | yes | Resource endpoint, `https://<resource>.openai.azure.com` or `https://<resource>.services.ai.azure.com`. `/openai/v1` is added when missing. Must be https |
| `FOUNDRY_API_KEY` | yes | Resource key. Server-side only |
| `FOUNDRY_DEPLOYMENT` | yes | Deployment name of the analyst model. It must support function calling, and JSON Schema structured output unless `json_object` is set |
| `FOUNDRY_VERIFIER_DEPLOYMENT` | no | Deployment for the verifier; defaults to the analyst's. A different model gives a more independent review |
| `FOUNDRY_STRUCTURED_OUTPUT` | no | `json_schema` (default, strict) or `json_object` for models without strict structured output. The validator enforces the contract either way |
| `PITCHLENS_ALLOWED_ORIGINS` | no | Comma-separated extra origins allowed to call the endpoint |
| `PITCHLENS_EXPLAIN_ACCESS_TOKEN` | no | When set, requests need `Authorization: Bearer <token>` |

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

Live evaluation (`tests-live/explain.live.test.ts`) runs five moments (the
scripted shot before its result is known, the scripted goal, and a generated
offside, goal and formation change) for both audiences: 10 workflows of up to
8 model calls each. It runs only with `PITCHLENS_LIVE_EVAL=1` and the Foundry
variables set:

```sh
PITCHLENS_LIVE_EVAL=1 FOUNDRY_ENDPOINT=https://<your-resource>.openai.azure.com \
  FOUNDRY_API_KEY=<your-api-key> FOUNDRY_DEPLOYMENT=<your-deployment> npm run test:live
```

It **asserts** only properties that must hold whatever the model writes: the
response validates against evidence the tools could have returned, no later
event is cited, and `matchId` and `timeMs` match. It **reports** quality as a
`LIVE` table and summary (verified, revised, insufficient, fallback, errors,
calls, tokens and time per case). Model output varies between runs, so treat
the summary as a sample, not a benchmark.

## Not implemented yet

- The viewer does not call the endpoint; controls, loading and error states
  belong to the integration work.
- Rate limits and the answer cache are per instance and in memory.
- Keyless (Entra ID) authentication, streaming and response caching across
  instances are not implemented.
- Grounding checks are lexical. The verifier is a model. Neither proves an
  explanation is correct.
