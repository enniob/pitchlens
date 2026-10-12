# 3D match presentation

PitchLens uses Three.js for interactive playback and an original footballer
asset authored with the bundled Blender script. No third-party player models,
club logos, likenesses, or textures are included.

## Player assets and animation

- `assets/blender/footballer.blend` is the editable, assembled neutral model.
- `public/models/footballer.glb` is the runtime mesh library (approximately
  294 KiB), exported with Blender 5.2.2 LTS's built-in glTF exporter.
- `scripts/build-football-assets.py` rebuilds both files. For example:

  ```powershell
  & 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python scripts/build-football-assets.py
  ```

The model follows the player reference's faceted silhouette, shaped jaw and
facial features, swept hair, short sleeves, individual fingers, and studded boots.
Ten named joint-local mesh types share instanced geometry across the squad.
Team kit and skin colours come from the existing fictional fixture and stable
player identifiers; vertex colours add collar, cuff, and boot details.

This is an articulated model, not a skinned character with motion-capture clips.
The existing rig and poses still animate running, kicks, tackles, dives and
restarts directly from recorded motion and selected playback time. Loading a
new mesh does not change joint matrices, player positions, or the clock. The
procedural player geometry displays immediately and remains on fetch or parse
failure. Disposal aborts pending requests and frees late-arriving geometry.

Blender's glTF export and Three.js GLTFLoader are compatible for this asset's
positions, normals, vertex colours, and transforms. No compression decoder or
external texture is required. Blender 5.2 warns that Material.use_nodes will be
removed in Blender 6; the script currently targets Blender 5.2.

## Broadcast presentation

- Turf grain and mowing variation are generated once from a fixed seed, with
  pitch markings painted on the same texture.
- Rough grass and kit materials, warm directional lighting, ACES tone mapping,
  and a single 2048px PCF shadow map provide depth. Players and goal frames cast
  shadows; a faint contact shadow remains under players. Netting uses square
  line cells instead of triangle wireframes.
- A narrower field of view, elevated sideline angle and initial 1.2x crop give a
  closer broadcast view. Zoom out/reset reaches full-pitch framing, including
  the rotated portrait view. A continuous grass surround fills the background.
- Turf blade streaks and worn goal mouths add surface detail.
- Goal frames keep the simulation's 7.32 m post-centre spacing and 2.44 m
  crossbar-centre height. The reference's 2 m depth, sloped rear uprights,
  base rails, dark mounts and gently sagging square cord net replace box nets.
  Four instanced meshes per goal keep the extra detail to four draw calls;
  net cords use fewer than 30,000 triangles per goal and skip shadow casting.
- The ball has 12 charcoal pentagons and 20 warm-white hexagons, curved panels,
  inset seams and generated leather grain. Its 22 cm physical diameter and
  existing camera-dependent enlargement are preserved. Position-derived spin
  is a visual approximation that reconstructs identically after seeking;
  it does not change the simulated ball or infer angular momentum.
- Number badges appear in Top view and when Tactics is enabled.
- A mint ring identifies the current recorded ball carrier. Tactics shows a
  brief dashed trail of the latest completed pass, after reception. Later
  actions clear it; it never previews a future pass or implies a planned action.

Walking blends into running between 2 and 3.2 m/s. Gait phase uses accumulated
speed-dependent stride cycles; running dips at stance and rises during flight.
Kicks align to the outgoing ball direction during the first 15% of the approach,
brace the support leg, and scale the swing and follow-through by power and loft.
The support leg is braced relative to the moving player; recorded trajectories
are preserved, so this is not a world-space foot lock.

Simulation, fixture contracts, and playback timing are unchanged. Poses
derive from recorded state and selected playback time, preserving
pause and backward seeking. These changes introduce no model service or Azure
dependency.

Animation-only kick preparation reads up to 300 ms ahead to contact and one
additional snapshot (normally 100 ms) for outgoing ball direction, power and
loft. This bounded positional look-ahead is not passed to explanations or the
event feed and does not reveal the outcome of a pass or shot.

## Validation and limits

Tests parse the actual exported GLB, check axes and joint-local dimensions,
bound its triangle count, and exercise missing/malformed/cancelled asset loads.
Field asset tests check 32-panel topology, outward surface winding, net geometry
budgets, goal mirroring, the open mouth, and ball placement/spin after seeking.
Camera tests project pitch corners and goal height across screen shapes. Trail
tests check event-time boundaries, expiry, and backward seeking. Existing
animation, playback, offside and evidence tests cover match behavior.

Run `node scripts/preview-field-assets.mjs` to inspect the procedural runtime
meshes in Blender. It writes `goal-preview.blend`, `ball-preview.blend` and PNG
close-ups under `assets/blender`; use `--ball` to render only the ball. Set
`BLENDER_PATH` for a different executable. These are inspection files; Three.js
constructs the runtime goal and ball directly without asset downloads. The
preview uses the same geometry, colours and normals; Blender adds its own
lighting and a procedural leather grain rather than the runtime bump texture.

Run `npm run typecheck`, `npx vitest run --maxWorkers=2 --testTimeout=60000`, and
`npm run build` before handoff. The longer test timeout accommodates the
simulation suite on slower machines.

The full pitch can occupy less horizontal space in a very short, wide canvas.
Stage layout belongs to the UI redesign; zoom is available for closer views.
Shadow rendering adds a pass for player geometry and goal frames. Mobile GPU
performance still needs measurement on real devices.

The reference is a visual target rather than an exact recreation. Fixture kits,
teams and positions remain their recorded values. Skinned animation, richer
cloth detail and higher fidelity faces remain possible later improvements.
