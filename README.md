# PitchLens

## Playback statistics (MVP 4)

The match statistics panel compares possession, completed passes, shots, saves,
and goals for both teams at the current playback time. Seeking backwards removes
later totals; restarting or generating a match resets the panel. Both fixture
schemas are supported, and statistics also work without WebGL.

Possession measures controlled time using snapshot intervals, excluding ball
flight and dead-ball time. Percentages remain blank until there is controlled
time and are rounded to sum to 100%. Completed passes count only successful
receptions. Shots count at the strike; saves count only when the result arrives
and are credited to the defending team. Goals count goals in this sequence,
excluding any score carried into its starting state. These are synthetic sequence
statistics, not full-match or predictive metrics.

`statisticsAt` in `src/playback/statistics.ts` derives totals without modifying
the fixture or keeping counters, so playback speed does not affect results.

PitchLens is a prototype for the MS and Premier League hackathon. **MVP 1** is a 3D match viewer that plays back a short, scripted football sequence on a 3D pitch. The default camera looks down from above.

> **Everything shown is synthetic.** The teams (Harbor City FC and Northvale Rovers), the players, their movement and the events are made up for the demo. The app uses no real match data, footage or club branding, and it makes no network calls at runtime.

![Overhead view just after the goal](docs/screenshots/mvp5-desktop-goal.jpg)

![Zoomed, angled view of a kick at the moment of contact](docs/screenshots/mvp5-desktop-kick-zoom.jpg)

## Getting started

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev        # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build |
| `npm start` | Serve the production build (run `npm run build` first) |
| `npm test` | Unit tests (Vitest): playback clock, seeking and event navigation, statistics, fixture validity, ball physics, simulator replay and event/contact alignment, animation poses |
| `npm run typecheck` | `tsc --noEmit` |

### Using the viewer

- **Play / Pause** and **Restart**. Pressing Play at the end starts the sequence again.
- **Speeds:** 0.5×, 1×, 2× and 4×.
- **Angled view** switches between the default overhead camera and a broadcast-style angle.
- **Zoom:** use the − / + buttons, the mouse wheel, or a pinch. When zoomed in, drag to pan. **Fit** resets the view.
- The **Recent events** panel shows an event only after playback reaches its timestamp. The score works the same way.
- On portrait screens (phones) the camera turns 90° so the pitch runs from top to bottom.
- If WebGL isn't available, a message replaces the 3D view. Playback, the clock, the score and the events panel still work.

## Architecture

```
src/
  match/                  Data. Has no rendering or React dependencies.
    contract.ts           Versioned TypeScript data contract (schema 1.0.0)
    fixture.ts            Deterministic scripted sample fixture and the builder that makes it
    validate.ts           Structural validation of any fixture
  playback/               Playback logic. Has no rendering dependencies.
    derive.ts             Pure functions: positions, score and events at time t
    statistics.ts         Pure function: match statistics at time t
    animation.ts          Pure functions: player speed, distance travelled and kick timing at time t
    engine.ts             PlaybackEngine: the single simulation clock
  simulation/             Seeded match producer. Has no rendering or playback dependencies.
    ball.ts               Deterministic ball physics: flight, bounce, roll
    generate.ts           Fixed-timestep simulator that records snapshots and events
  scene/                  Three.js only. Has no clock of its own.
    coords.ts             Conversion from pitch space to scene space
    Pitch.ts              Grass, markings and goals (static)
    pose.ts               Joint angles for idle, running and kicking
    rig.ts                Footballer skeleton: one matrix per body part from a pose
    Player.ts             Procedural footballers, instanced across all 22 players
    Ball.ts               Ball and its height shadow; sized to the camera zoom
    MatchScene.ts         Puts the scene together: lights, cameras, zoom/pan, resize, dispose
  components/             React UI
    MatchViewer.tsx       Runs the one requestAnimationFrame loop and connects engine → scene → UI
    PlaybackControls.tsx, Scoreboard.tsx, EventFeed.tsx
  app/                    Next.js App Router page and layout
tests/                    Vitest suites
```

How data moves through one animation frame:

1. `MatchViewer`'s `requestAnimationFrame` loop measures the real time since the last frame (capped at 250 ms so a backgrounded tab doesn't jump ahead) and calls `engine.advance(delta)`.
2. The engine multiplies that time by the playback speed and moves its clock forward, stopping at the end of the fixture. While paused, it doesn't move.
3. `engine.frame()` derives the interpolated player and ball positions, possession, score and revealed events, using only the fixture and the current time.
4. `MatchScene.update(frame)` sets every player and ball transform from that frame, poses each player from `motionAt(fixture, time)`, then draws the scene. The player and ball models have no timers and keep no state between frames.
5. React re-renders only when something it displays changes: the clock (to 0.1 s), the score, the event count, play/pause or the speed.

Because everything is derived from the current time, results don't depend on frame rate. When one frame crosses several event timestamps, all of those events appear together, in order. Restarting returns to the fixture's starting state.

### Cleanup

When `MatchViewer` unmounts, it cancels the animation frame and calls `MatchScene.dispose()`. That call:

- removes all DOM listeners through an `AbortController`
- disconnects the `ResizeObserver`
- disposes every geometry, material and texture in the scene
- disposes the renderer, forces the WebGL context to be released, and removes the canvas

In dev mode, React StrictMode mounts and unmounts the viewer twice, which exercises this path.

## Data format

The full contract is in [`src/match/contract.ts`](src/match/contract.ts). In summary:

- **`MatchFixture`**:
  - `schemaVersion` (`"1.0.0"`), `matchId`, `title`, `synthetic: true`, and `durationMs`.
  - `teams`: two `Team`s, each with a stable `id`, a `side` (home or away), names, kit colours and attacking direction.
  - `roster`: 22 `Player`s, each with a stable `id`, a `teamId`, a shirt number and a role.
  - `startingState`: the score and possession at t = 0. The displayed score is always this plus the goals revealed so far. The final result is never stored or shown in advance.
  - `snapshots`: ordered position samples (every 100 ms in the sample fixture), each with `t` in ms, all 22 players (`x`, `y`, `facing`), the ball (`x`, `y`, `z`) and `possession`. Possession is `null` while the ball is in flight or dead.
  - `events`: ordered `MatchEvent`s, each with a unique `id`, `t` in ms, a `type` (`kickoff | turnover | pass | shot | goal`), a team, an optional player, an `outcome`, start and end positions, and a description. Passes name their `recipientId`.
- **When events appear:** an event's `t` is the moment it resolves and becomes visible. For a pass that is the moment of reception, and `startT` records when the ball was struck. For a shot it is the strike, and for a goal it is the ball crossing the line.
- **Discontinuities:** a snapshot with `discontinuity: true` starts a new continuous segment, such as the kickoff reset after a goal. Playback holds the previous snapshot until that instant and then jumps to the new one. It never interpolates between them, so neither the ball nor the players slide across the pitch.

### Coordinates

The pitch is 105 × 68 m:

- `x` runs from 0 to 105 along the length (from the left goal line to the right one).
- `y` runs from 0 to 68 across the width (from the top touchline to the bottom one).
- `z` is height in metres.
- `facing` is in radians: 0 points along +x and π/2 along +y.

Three.js scene space is y-up, with 1 unit = 1 m and the centre spot at the origin (see `src/scene/coords.ts`):

```
scene.x = x − 52.5      scene.y = z      scene.z = y − 34      rotation.y = −facing
```

### The sample sequence

| t (s) | Event |
| --- | --- |
| 2.4 | Turnover: Harbor City #6 wins the ball from Northvale #8 |
| 4.0 | Pass #6 → #8 (ground) |
| 6.5 | Pass #8 → #10 (lofted) |
| 8.1 | Pass #10 → #9 |
| 8.8 | Shot on target by #9 |
| 9.4 | Goal, making it 1–0. The ball crosses the line, then hits the net |
| 10.5–19.0 | Players walk back to their kickoff positions |
| 19.5 | Kickoff by Northvale (a discontinuity snapshot moves the ball to the centre spot) |
| 21.0 | Pass from the kickoff, #9 → #8 |

`buildSampleFixture()` builds the sequence from keyframes. Players involved in the play follow scripted paths. Off-ball players hold a 4-3-3 formation that shifts toward a slightly delayed track of where the ball is, with a small deterministic sway. Ball contact points come from the touching player's position and facing, so passes, receptions and the shot line up with their events. The builder uses no randomness, so building the fixture twice gives identical output; the tests check this.

## Validation

| Check | Result |
| --- | --- |
| `npm test` | 251 tests pass. As well as the MVP 1–4 suites (fixture validity, clock, speeds, seeking, no early reveals, restart, statistics, validator and viewer error handling), MVP 5 adds ball trajectories, deterministic replay, pitch boundaries, event/contact alignment, statistics compatibility and animation poses (see below) |
| `npm run typecheck` | Passes |
| `npm run build` | Passes. The `/` route is prerendered as static content |

For MVP 1 I also checked the app by hand in headless Chromium (SwiftShader WebGL) at 1440×900 and 390×844 (the MVP 5 visual checks are listed in that section):

- The 3D view, all controls, and pause freezing the clock work.
- Restart resets the score, events and clock.
- There is no horizontal scroll on mobile.
- After an unmount, no canvas, live WebGL context or animation-frame callback remains.

## Known limitations

- There is one hard-coded fixture and no loader for external fixture files yet. Any data that follows the contract can be passed to `MatchViewer`.
- The number badges stay the same size on screen, and players are drawn larger than life (1.4×) so they stay readable from the overhead camera. The ball is drawn much larger from the full-pitch view and shrinks to the players' scale as you zoom in.
- Playback is linear between snapshots. The scripted demo is keyframed and has no physics; only the seeded simulator does. There is no tactical logic.
- The kickoff reset is an instant cut. Players walk back beforehand, so in practice only the ball jumps.
- There are no global keyboard shortcuts. All controls are standard buttons and a native slider, and work with Tab, Enter, Space and the arrow keys.
- Pinch zoom and pan on the canvas turn off the browser's touch scrolling over the 3D view. On mobile, scroll the page using the area outside the view.
- Shadows are simple discs. No real-time shadow maps are used.

## Seeded simulator (MVP 2)

Use **Generate match** with an integer seed (0–4294967295) and a duration.
The same seed, duration, and simulator version reproduce the same match.
**Scripted demo** restores the original MVP 1 fixture. Generation resets playback
and starts paused; playback speed does not change simulation outcomes.

`generateMatch({ seed, durationMs })` in `src/simulation/generate.ts` is a pure
TypeScript producer, independent of the renderer. It uses a fixed timestep
(20 ms since MVP 5, with snapshots every 100 ms plus one at each ball contact),
a seeded PRNG, speed-limited formation movement, carrying, passes, interceptions,
shots, saves, goals, and simplified dead-ball restarts. Since MVP 5 those
outcomes come from simulated ball movement; see the MVP 5 section below.

Generated fixtures use schema **1.1.0**; the original **1.0.0** fixture remains
supported. New event types are `shot-result` and `goal-kick`; new outcomes are
`pending`, `intercepted`, `saved`, and `missed`. A `shot` is published at the strike
with outcome `pending`, with no future destination. Its result appears only on
arrival as `goal` or `shot-result`. Failed passes preserve the intended recipient;
a following turnover identifies the interceptor. Equal-time events retain array
order. Results are simplified sampled outcomes, not predictions of real football.

After a goal the conceding team kicks off. Misses lead to a simplified goal kick.
Dead-ball periods last two seconds, followed by an explicit discontinuity cut to
restart positions. The viewer never interpolates through this cut. There are no
real throw-ins, corners, fouls, offsides, substitutions or fatigue yet.
Durations are 10–180 seconds in 100 ms increments through the API; the UI offers
30, 60, and 120 seconds. A sequence can end during a ball flight, with no invented
completion event. This is a synthetic demo generator, not a calibrated tactical model.

Tests cover multiple seeds, deterministic replay, bounded player speed, valid
fixtures, possession at reception, goal scoring, conceding-team kickoffs, and
coverage of goals, saves, misses, and interceptions. Original demo tests remain.

## Seeking and event navigation (MVP 3)

`PlaybackEngine` gained `seek(t)`, `seekToPreviousEvent()` and `seekToNextEvent()`.
Seeking only moves the clock (clamped to the fixture; non-finite values are ignored).
Positions, ball, possession, score and the event feed are all pure functions of that
time (`frameAt`), so a seek gives exactly the same frame as playing to that time and
never reveals later events — including when scrubbing backwards, where the score and
feed shrink again. Seeking does not emit crossed events, and playing on afterwards
reports only events after the new position. The discontinuity rule still applies:
a seek into a kickoff reset never interpolates across the cut.

Event navigation uses distinct event timestamps (equal-time events share one stop),
strictly before/after the current time. Landing on an event includes it in the feed
and score. Both fixture schemas (1.0.0 and 1.1.0) are covered by `tests/seek.test.tsx`.
Statistics and match import/export are not part of this milestone.

## Footballers and ball physics (MVP 5)

### Player models and animation

The capsules are replaced by procedural footballers: head and hair, shirt, shorts,
arms, and legs with socks and boots, coloured from the team kit in the fixture
(goalkeepers wear the secondary colour with long sleeves and dark shorts). Skin and
hair tones vary per player from a hash of the player ID.

**Asset sources:** there are none to license. Every shape is built in
`src/scene/Player.ts` from Three.js primitives (capsules, cylinders, spheres, a
box for each boot), and the shirt numbers are drawn at runtime onto canvas
textures with the system font. No models, textures, fonts or animation clips are
downloaded or bundled. Three.js itself is MIT licensed.

Animation is derived, not simulated. `src/playback/animation.ts` reads the recorded
snapshots and returns, for any time, each player's speed, the distance they have
travelled and their offset from a ball strike. `src/scene/pose.ts` turns that into
joint angles:

- **Idle:** a slow sway and breathing bob when a player is nearly stationary.
- **Running:** the stride phase comes from distance travelled (one cycle per 2.8 m),
  so feet keep pace with the ground at any playback speed; stride length, knee lift,
  arm swing and forward lean grow with speed.
- **Kicking:** a backswing starting 220 ms before contact, the boot meeting the ball
  at the contact instant, and a follow-through that blends out over 380 ms.

A strike is recognised from snapshots alone: the instant a player's possession ends
with nobody on the ball. That is the same instant the simulator releases the ball
from the foot, and it works for the scripted demo too. Events are never read, and
the pose is a pure function of the fixture and the time, so seeking, restarting and
changing speed show identical poses. The only look-ahead is the 220 ms wind-up,
which reads upcoming snapshots; it never touches the feed, score, timeline or
statistics.

**Shirt numbers** appear on the back of each shirt and on the camera-facing badge
above the head, which keeps a constant on-screen size.

**Ball size:** from the full-pitch view the ball is drawn at 0.38 m radius so it
can be seen at all. As the camera zooms in it shrinks, reaching a real ball at the
players' scale from 2.2× zoom, so it stays in proportion with the players. This is
presentation only; recorded ball positions are unchanged.

**Mobile performance:** each body part is one `InstancedMesh` shared by all 22
players with per-instance kit colours, so every body on the pitch costs 10 draw
calls (the capsule version used 5 meshes per player, 110 in total). Badges and back
numbers add 2 per player. A footballer is roughly 1,000 triangles, materials are
Lambert, and there are still no shadow maps. These numbers are counted from the
scene structure; I have not profiled on a physical phone.

### Ball physics

`src/simulation/ball.ts` is a small deterministic model, not a rigid-body engine:

- **In the air:** constant gravity, no drag, integrated exactly per step.
- **Bounces:** vertical speed × 0.55 and horizontal speed × 0.8 at each impact; a
  bounce that would rebound slower than 0.9 m/s settles into a roll.
- **On the ground:** constant 1.8 m/s² deceleration until the ball stops.

The simulator advances players and ball in fixed 20 ms steps from one seeded PRNG
stream. Outcomes are read off the ball's path rather than decided in advance:

- A pass or shot leaves from the kicker's foot (0.55 m ahead of them along their
  facing) once they have turned to face it. Ground passes are weighted to arrive
  at about 9 m/s; long or blocked passes are chipped at a fixed launch angle.
  About 6% of passes are mishit off line and overhit.
- A pass is **received** when the ball comes within 1.1 m of the receiver below
  1.4 m, and **intercepted** when an opponent gets within 1 m below 1.2 m and wins
  a seeded 50% roll. The nearest opponent to the pass's path moves to cut it out.
- A shot is aimed at a seeded point around the frame. It is **saved** when it comes
  within the goalkeeper's reach (1.3 m, below 2.6 m) and they hold it (seeded 65%),
  a **goal** when the whole ball crosses the line inside the posts and under the
  bar, and **missed** when it crosses the goal line anywhere else.
- A tackle needs the tackler within 1.8 m of the ball. A newly won ball is drawn in
  to the new owner's foot at a bounded speed instead of jumping there.
- After a goal the ball carries on into the net; out of play it runs on until a
  3 m run-off stops it.

Goal and miss events record the point where the ball crossed the line. A snapshot
is recorded at every contact step, so every event has a snapshot at exactly its
timestamp.

Physics lives only in the producer. The viewer replays recorded snapshots, so
seeking, restart and playback speed cannot change a result.

Generated fixtures are still schema **1.1.0** and the scripted demo is still
**1.0.0**; no fields, event types or outcomes were added. Two existing values are
used in a new combination: a pass that runs out of play is a `pass` with outcome
`missed`, and the simplified restart that follows is a `turnover` for the other
team at a discontinuity snapshot. Match IDs are now `sim-v2-…` because the same
seed produces a different match than the MVP 2–4 simulator did.

### Not in this milestone

- No player collisions: players pass through each other, and a shot can only be
  stopped by the goalkeeper, not blocked by an outfield player. The ball does not
  rebound off posts, the bar or bodies.
- No air drag, spin or wind.
- Out-of-play restarts are simplified. A ball over the touchline is restarted at
  the feet of the nearest opponent rather than thrown in, and a ball over the goal
  line always gives a goal kick, never a corner.
- No save, tackle or receiving animations; goalkeepers use the same three poses.
- The scripted demo's facing was authored before the models had legs, so one of
  its passes (the kickoff pass at 20.0 s) is struck backwards relative to the way
  the player faces.
- Results are bit-identical for a seed on one JavaScript engine. Ball physics uses
  only `Math.sqrt` and arithmetic, but player movement uses `Math.sin`, `cos`,
  `atan2` and `hypot`, whose last bits are allowed to differ between engines.

### Validation

Across 200 seeds at 120 s every fixture passed validation; passes were about 80%
complete, and shots split roughly 29% goals, 45% saved, 26% missed.

New tests (`tests/ball.test.ts`, `tests/ball-simulation.test.ts`,
`tests/animation.test.ts`):

- **Ball trajectories:** flight matches the analytic parabola; bounce heights decay
  by restitution²; rolling stops after v²/2a; results are independent of step size;
  recorded pass flights obey gravity in the air and friction on the ground.
- **Deterministic replay:** byte-identical fixtures per seed; a longer run starts
  with the shorter one; frames and poses are identical at every speed and frame
  size, and after seek and restart.
- **Pitch boundaries:** players stay on the pitch; the ball is never below the
  grass or beyond the run-off; the first snapshot out of play is the one carrying
  the goal or miss; the ball stays in the net until the kickoff cut.
- **Event/contact alignment:** every pass and shot starts at the kicker's foot at
  the moment possession ends; receptions, interceptions, tackles and saves happen
  within reach of the ball; goals cross the line inside the frame and misses
  outside it.
- **Statistics compatibility:** totals match the events and the score for eight
  seeds and never decrease over time; the existing statistics suite runs unchanged
  on both schemas.
- **Animation:** motion is a pure function of time and needs no events; legs run in
  antiphase; the kicking boot is behind the body in the backswing and at the ball
  at contact.

`npm run typecheck` and `npm run build` pass. I checked the viewer in Chrome at
desktop width and in a 390 px wide viewport: both camera views, zoom, the kick
frames around a strike, the scripted demo and a generated match, with no console
errors and no horizontal scroll on the narrow layout. The older PNGs in
`docs/screenshots` still show the capsule models.
