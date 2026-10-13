# Measured match patterns

PitchLens derives patterns deterministically from synthetic recorded events. This is application code, not a model prediction. Both audience modes receive identical measurements and evidence. Nothing beyond the selected playback time is used; seeking backwards recomputes every measurement.

- **Turnover to shot:** a turnover with outcome `won`, followed only by that team's completed passes (and optional formation changes), then that team's shot. Any other event interrupts the chain. Duration is exactly shot strike time minus turnover resolution time, in milliseconds. No goal result or causal claim is inferred. The two latest sequences are retained.
- **Repeated flank actions:** at least three completed passes or shots whose start coordinates lie in the team's attacking half and the same outer third across the pitch, within the last 30 seconds (or available opening window). The attacking half includes x = 52.5 m. Top means y < 68/3 m; bottom means y > 136/3 m; these are fixed screen coordinates, not a player's left/right. Only start locations count; this does not establish possession dominance or successful attacks.
- **Shot locations:** for every retained shot at or before the selected time with a recorded start and a known team, `shotLocations` gives the event ID; `distanceToGoalM`, the straight-line distance from the start to the centre of the goal that team attacks (x = 105 m for `increasing-x`, x = 0 for `decreasing-x`; y = 34 m), rounded to 0.1 m; `insidePenaltyArea`, whether the start lies within 16.5 m of that goal line and 20.16 m either side of centre, boundaries inclusive; and `channel`, `top-outer-third` (y < 68/3 m), `bottom-outer-third` (y > 136/3 m) or `central` (boundaries included). These describe only where the shot started. They never use the shot's outcome or end coordinates and are not a chance-quality or expected-goals metric. Because each value depends on one event, shot locations are also supplied for `retained-events-only` windows.
- **Activity comparison:** shots and completed passes in two equal, adjacent five-second windows, `(selected-10000, selected-5000]` and `(selected-5000, selected]`. A card appears only when a count changes and ten seconds of complete event coverage are available. This measures activity, not pressure or momentum. It is supplied to the model only; the Tactics panel shows no card for it, because a window-to-window count change means little to a viewer on its own.

The Tactics panel shows turnover-to-shot and repeated flank cards, using complete cutoff-bound events for the last 30 seconds. Cards show the calculation, time range and supporting events. Replay seeks to the beginning of the evidence; individual events can also be replayed. Team/player focus filters visible cards after derivation, preserving their underlying evidence.

The model's `measurements` field is computed inside the context payload builder from its **final retained events**, including after byte-budget trimming. Counts are scoped to the context window, with the contributing event IDs. Filtering or truncation changes coverage to `retained-events-only` and suppresses patterns: missing events could otherwise hide an interruption or make window comparisons incorrect. These partial counts must never be presented as match totals or proof of no activity. Tools can supply additional events, but the base measurements continue to describe the base retained window. Every supporting ID remains present in the model evidence and uses existing event citation validation. Citation existence alone does not validate a derived claim; model grounding and verifier checks still apply.

## Derived measurements for the analyst

Besides patterns, the model's `measurements` carry deterministic measurements from `src/playback/derivedEvidence.ts`. They follow the same rules: pure functions, nothing after the selected time, identical for both audiences, recomputed from scratch after seeking backwards. Units are in the field name (`M` metres, `Ms` milliseconds, `Mps` metres per second) and values are rounded to 0.1. Distances are measured on the pitch surface (x, y); ball height is ignored. Missing data gives `null` and a reason, never an estimate. Every value lists the supplied events or snapshots it comes from, so a claim can cite them; a value with nothing citable behind it is left out.

Each distance is labelled with the kind of measurement it is, and no kind is ever reported as another:

| Name | What it is |
| --- | --- |
| `straightLineDistanceM` (pass) | Displacement of the ball from the strike point to where the pass ended. Not the ball's path. |
| `displacementM` (movement) | Straight line between the first and last snapshot used. Not distance run. |
| `sampledPathM` (movement) | Sum of the straight lines between consecutive supplied snapshots. A lower bound on distance covered, because the subject may have moved further between samples. |
| `averageStraightLineSpeedMps`, `averageSampledPathSpeedMps` | The matching distance divided by its elapsed time. An average, not a speed at any instant, and not a sprint or top speed. |

- **Pass completion** (`statistics[].passesPlayed`, `completedPasses`, `completionPercent`): passes counted once they resolve, of any outcome (complete, intercepted, missed). A pass still in flight is not counted, so its recipient and result stay hidden. The denominator is the passes in the window, never the whole match or later passes. `completionPercent` is a whole percentage and is `null` when there are no attempts or the coverage is `retained-events-only`.
- **Passes** (`passes`, latest 8; `passesOmittedOlder`): `straightLineDistanceM`; `travelMs` (`t − startT`, strike to resolution); `averageStraightLineSpeedMps`; and `forwardProgressM`, the gain along the pitch towards the goal the team attacks, negative for a backward pass. `unavailable` lists missing `start`, `end` or `startT` (older fixtures). These say nothing about pass difficulty or quality.
- **Formation changes** (`formationChanges`): each change whose `formation-change` event is supplied gives `from`, `to`, its time `t` and `activeForMs` up to the selected time. Changes scheduled for later never appear. Fixtures without formation data give none. A formation change records a change of shape only; it is never presented as the cause of a later event.
- **Possession spells** (`possessionSpells`, latest 4; `possessionSpellsOmitted`): runs of one team's possession, read from every snapshot in `[windowStartMs, selectedMs]`. Snapshots with no possession (the team's own pass in flight, a dead ball) do not end a spell. The opponent gaining the ball (`opponent-gained-possession`) or a reset (`reset`) does. Until then the spell is `ongoing`, which means it has not ended by the selected time, not that it will continue. `fromMs` and `toMs` are the first and last snapshots showing the team on the ball, and `durationMs = toMs − fromMs`. A spell already running when the window starts is clipped to the window and marked `startsBeforeWindow`. `eventIds` lists the team's supplied events from `fromMs` until the opponent gains the ball, so a shot struck after the last touch is included. `snapshotTimes` lists the supplied snapshots inside the spell. `cite` holds the earliest and latest of that evidence, and a claim that states the spell's duration must cite both (checked by grounding). A spell with no supplied evidence inside it is counted as `uncitable` and left out.
- **Movement** (`movement`): the ball, then the player on the ball, then players in the latest supplied events, up to four players. Measured across the supplied snapshots. Only the latest continuous segment counts: a reset ends it, including one between two supplied snapshots, and so does a snapshot that lacks the player. Positions are never interpolated. With fewer than two snapshots the values are `null` with `unavailable: "single-sample"`. A movement claim cites every time in `snapshotTimes`.
- **Nearby opponents** (`proximity`): in the snapshot at the selected time, the number of opponents within 5 m and within 10 m of the player controlling the ball (boundary included), and the distance to the nearest opponent. This is `null` when nobody controls the ball. It is a proximity count only. It is not a pressure rating, and it does not show that anyone is closing the player down.

### Integration examples

Reading the measurements of a paused moment, server-side:

```ts
import { extractMatchContext } from "@/explain/context";

const context = extractMatchContext(fixture, timeMs);
const { passes, possessionSpells, movement } = context.measurements;
// `claim(text, evidence)` stands for adding a claim to an explanation response.

// "The pass travelled 18.9 m in 1.9 s": copy the values, cite the pass event.
const latest = passes.at(-1);
if (latest?.straightLineDistanceM != null)
  claim(`The pass covered ${latest.straightLineDistanceM} m in a straight line`, [{ kind: "event", id: latest.eventId }]);

// A possession duration cites the spell's earliest and latest evidence.
const spell = possessionSpells.at(-1);
if (spell) claim(`Possession lasted ${spell.durationMs / 1000} s`, spell.cite);

// Movement cites every snapshot it used.
const ball = movement.find((m) => m.subject.kind === "ball");
if (ball?.displacementM != null)
  claim(`The ball moved ${ball.displacementM} m between the first and last snapshot`,
    ball.snapshotTimes.map((t) => ({ kind: "snapshot" as const, t })));
```

Using the pure functions directly, for example in a tool or test, where the caller supplies only data up to the cutoff:

```ts
import { measurePasses, measureMovement, measureProximity } from "@/playback/derivedEvidence";
import { eventsAt } from "@/playback/derive";

const { passes } = measurePasses(eventsAt(fixture, t), fixture.teams);
const upToT = fixture.snapshots.filter((s) => s.t <= t);
const resets = upToT.filter((s) => s.discontinuity).map((s) => s.t);
const [ball] = measureMovement(upToT.slice(-5), resets, [{ kind: "ball" }]);
const near = measureProximity(upToT.at(-1)!, new Map(fixture.roster.map((p) => [p.id, p.teamId])));
```

Citation validation proves that a cited event or snapshot exists. It does not prove that a claim is true. Grounding and the verifier still check the wording.
