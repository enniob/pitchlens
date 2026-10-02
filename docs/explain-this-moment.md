# Explain this moment: evidence and response contract

"Explain this moment" will let a viewer pause on any time in a match and get a
short, grounded explanation of what is happening. This document covers the
first, backend-only part of that feature:

- **`extractMatchContext`** (`src/explain/context.ts`): a deterministic
  extractor that turns a fixture and a playback time into a compact evidence
  package.
- **`ExplanationResponse`** and **`validateExplanation`**
  (`src/explain/response.ts`): the structured response an explanation must
  follow, and a runtime validator that checks it against the evidence package.

> **Live AI integration is not implemented yet.** Nothing in this code calls a
> model or any network service, needs credentials, or changes the UI. The
> contract is plain JSON and names no provider, so a hosted model can be
> connected in a later change without altering it.

Both modules are pure TypeScript with no rendering, React or network
dependencies, like `src/match` and `src/playback`.

## The evidence package

```ts
import { extractMatchContext } from "@/explain/context";

const context = extractMatchContext(fixture, engine.status.timeMs);
// or, with explicit bounds:
const narrow = extractMatchContext(fixture, 9_050, { lookbackMs: 2_000, maxSnapshots: 1 });
```

`extractMatchContext(fixture, t, options?)` returns a `MatchContext`. It is
plain JSON (no `undefined` values, class instances or `-0`), so
`JSON.parse(JSON.stringify(context))` gives back an equal object. The same
fixture, time and options always give the same package, and the fixture is not
modified.

| Field | Contents |
| --- | --- |
| `contextVersion` | `"1.0.0"` |
| `match` | `matchId`, `title`, fixture `schemaVersion`, `synthetic: true`, `durationMs`, and `generator` (seed, simulator version, config key) for generated fixtures |
| `time` | `selectedMs`, `positionsAtMs`, `lookbackMs`, `windowStartMs` (see below) |
| `score` | The score at the selected time: the starting score plus goals revealed by then |
| `teams` | ID, side, names and attacking direction of both teams |
| `players` | All 22 rostered players: ID, team, name, shirt number, roster role, and their formation `slot` (ID and tactical position) at the selected time when the fixture has formation data |
| `formations` | Each team's active formation, when it took effect (`since`) and, for a change, the `changeEventId` that applied it. `null` without formation data |
| `events` | Revealed events in the lookback window, oldest first, each with its stable fixture `id` and timestamps |
| `snapshots` | Position samples in the window, oldest first: ball, possession, and every player's `x`, `y` and `facing`. The last one is the current positions |
| `ball` | `control` at the current positions (`controlled`, `team` or `none`) and `lastControl`: the latest sample in the window in which a player had the ball |
| `limitations` | Coded caveats, always including `synthetic-data` and `no-player-attributes` (see below) |

Positions are rounded to 0.1 m and facings to 0.01 rad. Event `start` and `end`
positions are rounded to 0.1 m.

### Timestamp semantics

- `t` is playback time in milliseconds, the same clock as `PlaybackEngine`. It
  must be a finite number from 0 to `durationMs` inclusive; anything else
  throws a `RangeError`. Nothing is clamped silently.
- Fractional times are floored to whole milliseconds (`time.selectedMs`), so a
  time just short of an event never reveals it.
- **Events** are included when `t ≤ selectedMs`, exactly as in the playback
  event feed. Equal-time events keep their fixture order.
- **Actions that resolve later are not included.** An event's `t` is when it
  resolves (for a pass, the reception; for an offside, the call). A pass in
  flight, or an offside not yet called, is therefore absent even though its
  `startT` has passed: neither its recipient, its outcome nor its event ID
  appears. The package instead reports `ball.control: "none"`, the last player
  in control, and the `ball-not-controlled` limitation.
- **Unresolved shots** are included from the strike (that is when a shot event
  happens), but until a `goal` or `shot-result` for that shot has been
  revealed they are reported with outcome `pending`, no `end`, and a neutral
  description. This matters for the scripted 1.0.0 demo, whose shot event
  carries its destination and an `on-target` outcome from the moment it is
  struck.
- **Positions are never interpolated.** Playback interpolates between the
  snapshots either side of `t`, which uses the *next* snapshot. The package
  instead uses the latest snapshot at or before `selectedMs` and reports its
  time as `time.positionsAtMs`. When that is earlier than the selected time the
  `positions-sampled-earlier` limitation says so. As in playback, a snapshot
  marked as a discontinuity is not used until its own time.
- **Formations** are the starting formations plus applied changes with
  `t ≤ selectedMs` (`formationsAt`). A change at exactly the selected time is
  included. Scheduled changes (`tactics.scheduled`) are never included, and no
  slot or formation used only after the selected time appears.
- **Score** counts goals with `t ≤ selectedMs`, including those before the
  lookback window.

### Lookback window and payload limits

Events and snapshots come from `[windowStartMs, selectedMs]`, where
`windowStartMs = max(0, selectedMs − lookbackMs)`. The current positions are
always included, even when the window is empty.

| Option | Default | Allowed | Effect |
| --- | --- | --- | --- |
| `lookbackMs` | 10 000 | 0 – 30 000 | Length of the window |
| `maxEvents` | 20 | 1 – 50 | Most recent events kept from the window |
| `maxSnapshots` | 6 | 1 – 8 | Snapshots kept, including the current one, spread evenly back through the window (every 2 s by default) |
| `maxBytes` | 24 000 | 8 000 – 64 000 | Upper bound on the package as UTF-8 JSON |

Options outside these ranges, or not integers, throw a `RangeError`. If the
package is larger than `maxBytes`, the oldest earlier snapshots are dropped
first, then the oldest events, until it fits. The current snapshot is never
dropped. Everything left out is reported in `limitations`:

| Code | When |
| --- | --- |
| `synthetic-data` | Always |
| `no-player-attributes` | Always: the data has no attributes, fitness, instructions or intentions |
| `no-formation-data` | The fixture has no `tactics` (schema 1.0.0–1.2.0 and the scripted demo) |
| `positions-sampled-earlier` | The current positions are from before the selected time |
| `ball-not-controlled` | Nobody controls the ball: in flight, loose or dead |
| `events-before-window` | Revealed events fall before the window |
| `events-truncated`, `snapshots-truncated` | Items were dropped by `maxEvents` or `maxBytes` |

`contextSize(context)` returns the package size in bytes. With the defaults a
package is about 10–14 KB; the minimal package (one snapshot, no events) is
about 5.5 KB, mostly the 22 players.

The fixture is validated first (`validateFixture`); an invalid fixture throws.

### Example

The scripted demo, 250 ms after the shot and before the goal, with
`{ lookbackMs: 2_000, maxSnapshots: 1 }` (players shortened):

```json
{
  "contextVersion": "1.0.0",
  "match": { "matchId": "synthetic-mvp1-sample-001", "title": "Synthetic sample: turnover to goal", "schemaVersion": "1.0.0", "synthetic": true, "durationMs": 24000 },
  "time": { "selectedMs": 9050, "positionsAtMs": 9000, "lookbackMs": 2000, "windowStartMs": 7050 },
  "score": { "home": 0, "away": 0 },
  "teams": [
    { "id": "hcf", "side": "home", "name": "Harbor City FC", "shortName": "HCF", "attacksTowards": "increasing-x" },
    { "id": "nvr", "side": "away", "name": "Northvale Rovers", "shortName": "NVR", "attacksTowards": "decreasing-x" }
  ],
  "players": [{ "id": "hcf-1", "teamId": "hcf", "name": "T. Varga", "number": 1, "role": "GK" }],
  "formations": null,
  "events": [
    {
      "id": "e4-pass", "t": 8100, "type": "pass", "teamId": "hcf", "outcome": "complete",
      "description": "Pass #10 I. Moreau → #9 R. Castell", "playerId": "hcf-10", "recipientId": "hcf-9",
      "startT": 7300, "start": { "x": 84.6, "y": 38.4, "z": 0.1 }, "end": { "x": 91.1, "y": 31.1, "z": 0.1 }
    },
    {
      "id": "e5-shot", "t": 8800, "type": "shot", "teamId": "hcf", "outcome": "pending",
      "description": "Shot by R. Castell (#9); result not yet known", "playerId": "hcf-9",
      "start": { "x": 93, "y": 32.2, "z": 0.1 }
    }
  ],
  "snapshots": [
    { "t": 9000, "ball": { "x": 97, "y": 33.3, "z": 1.2 }, "possession": null, "players": [{ "playerId": "hcf-1", "x": 8, "y": 33.6, "facing": 0 }] }
  ],
  "ball": { "control": "none", "lastControl": { "t": 8700, "teamId": "hcf", "playerId": "hcf-9" } },
  "limitations": [
    { "code": "synthetic-data", "message": "Synthetic match from a simplified simulation or a scripted demo. …" },
    { "code": "no-player-attributes", "message": "The data has no player attributes, fitness, instructions or intentions; …" },
    { "code": "no-formation-data", "message": "This fixture has no formation data, so formations and player slots are unknown." },
    { "code": "positions-sampled-earlier", "message": "Positions are from the snapshot at 9000 ms, the latest at or before the selected time (9050 ms)." },
    { "code": "ball-not-controlled", "message": "No player controls the ball (in flight, loose or dead). …" },
    { "code": "events-before-window", "message": "3 earlier event(s) before 7050 ms are outside the lookback window; the score still counts them." }
  ]
}
```

The shot is shown as `pending` with no destination; the goal at 9.4 s, the
score change and the shot's `on-target` outcome are absent.

## The explanation response

```ts
type EvidenceRef = { kind: "event"; id: string } | { kind: "snapshot"; t: number };

interface Claim {
  text: string;            // 1–300 characters
  evidence: EvidenceRef[]; // 1–8 distinct references
}

interface ExplanationResponse {
  explanationVersion: "1.0.0";
  matchId: string;         // must equal context.match.matchId
  timeMs: number;          // must equal context.time.selectedMs
  status: "explained" | "insufficient-evidence";
  headline: string;        // 1–100 characters
  explanation: string;     // plain language, 1–1200 characters
  facts: Claim[];          // observable facts, up to 8
  interpretation: Claim[]; // tactical reading, up to 5
  limitations: string[];   // up to 8, each 1–300 characters
}
```

### Rules

`validateExplanation(value, context)` returns `{ ok: true, response }` or
`{ ok: false, errors }` with readable messages. `parseExplanation(text,
context)` does the same for raw JSON text. A response is rejected when:

- it is not an object, has a missing or unknown field (at any level), a wrong
  type, or a string that is empty or too long
- `explanationVersion`, `matchId` or `timeMs` does not match the context, so a
  response cannot be shown against a different match or moment
- any claim, fact or interpretation, cites nothing
- **any reference does not resolve to the context**: an event ID not in
  `context.events`, or a snapshot time not in `context.snapshots`. This rejects
  invented IDs, real events after the selected time, events outside the
  lookback window, and interpolated or future snapshot times
- a reference is malformed or duplicated within a claim
- `status` is `explained` with no facts
- `status` is `insufficient-evidence` with any interpretation, or with no
  limitation saying what is missing

### Facts and interpretation

`facts` are observable: what happened, where, when and who, as recorded in the
cited events and snapshots. `interpretation` is a tactical reading of those
facts, and must also cite them.

A fact must not assert intent or cause. The validator rejects facts containing
wording such as *because*, *due to*, *caused*, *tried*, *wanted*, *intended*,
*decided* or *deliberately* (`FACT_SPECULATION`). That wording is allowed in
`interpretation`, where it is presented as a reading. The check is lexical and
deliberately conservative; it cannot prove a claim is supported. The prompt
used with a model must also tell it not to invent intent, player attributes
(the data has none) or causal claims the evidence does not show.

### Insufficient evidence

When the evidence cannot support an explanation, a response uses
`status: "insufficient-evidence"`, no interpretation, and at least one
limitation. `insufficientEvidence(context, reason)` builds a valid response of
that kind, for example as the fallback after a response fails validation.

### JSON Schema

`EXPLANATION_JSON_SCHEMA` describes the response's shape as JSON Schema
(2020-12), for providers that support structured output. It cannot express
the checks against the context (citations, `matchId`, `timeMs`, status rules),
so `validateExplanation` remains the authority.

### Example

A valid response for the scripted demo at 9 400 ms (the goal) with the default
options:

```json
{
  "explanationVersion": "1.0.0",
  "matchId": "synthetic-mvp1-sample-001",
  "timeMs": 9400,
  "status": "explained",
  "headline": "Harbor City score after a three-pass move",
  "explanation": "Harbor City won the ball, passed it forward three times and their number 9 shot from inside the area. The ball crossed the line, making it 1–0.",
  "facts": [
    { "text": "Harbor City #6 won the ball at 2.4 s.", "evidence": [{ "kind": "event", "id": "e1-turnover" }] },
    { "text": "#9 shot at 8.8 s and the ball crossed the line at 9.4 s.", "evidence": [{ "kind": "event", "id": "e5-shot" }, { "kind": "event", "id": "e6-goal" }] },
    { "text": "The score is 1–0.", "evidence": [{ "kind": "snapshot", "t": 9400 }, { "kind": "event", "id": "e6-goal" }] }
  ],
  "interpretation": [
    { "text": "Quick forward passing after the turnover left little time to defend the move.", "evidence": [{ "kind": "event", "id": "e2-pass" }, { "kind": "event", "id": "e4-pass" }] }
  ],
  "limitations": ["Synthetic scripted sequence; not real football."]
}
```

Citing `e7-kickoff` (which happens at 19.5 s) or a snapshot at 9 450 ms would
be rejected.

## Tests

`tests/explain-context.test.ts` and `tests/explain-response.test.ts` cover:

- a goal before, at and after it happens, in the scripted demo and a simulated
  match, including the shot's withheld result
- an offside before and after it is called
- a formation change before, at and after its time, including slot assignments
- seeking backwards, and a sweep over every event time (and 1 ms before) in
  four fixtures checking that no later event ID, timestamp, formation or
  scheduled change appears
- a pass and a shot still in flight, positions taken from the earlier snapshot
  rather than interpolated, and discontinuities
- the scripted 1.0.0 demo and an older generated fixture without tactics
- invalid times and options, fractional times, invalid fixtures, the payload
  bound across a 180 s match, and trimming order
- determinism, JSON round trips and that the fixture is not modified
- valid responses, fabricated, future, out-of-window and interpolated
  references, malformed references, intent and cause in facts, status rules
  and malformed responses

## Not implemented yet

- No model is called. There is no prompt, provider client, credentials,
  retry policy, rate limiting or caching.
- There is no UI. The viewer does not show or request explanations.
- Validation checks structure and citations; it cannot prove that the text of
  a claim is supported by what it cites.
