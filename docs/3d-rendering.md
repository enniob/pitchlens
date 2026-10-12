# 3D match presentation

The first visual upgrade uses the existing Three.js renderer and procedural
players. No Blender models or external texture assets are loaded yet.

- Turf grain and mowing variation are generated once from a fixed seed, with
  pitch markings painted on the same texture.
- Rough grass and kit materials, warm directional lighting, ACES tone mapping,
  and a single 2048px PCF shadow map provide depth. Players and goal frames cast
  shadows; a faint contact shadow remains under players. Netting uses square
  line cells instead of triangle wireframes.
- A narrower field of view and a higher broadcast angle reduce perspective
  distortion. Full-pitch fitting projects the apron corners and goal height,
  including the rotated portrait view. Zoom still deliberately permits crops.
- Player number badges are smaller to reveal more of the player silhouettes.

Simulation, fixture contracts, poses, and playback timing are unchanged. Poses
continue to derive from recorded state and selected playback time, preserving
pause and backward seeking. These changes introduce no model service or Azure
dependency.

## Validation and limits

`tests/camera.test.ts` checks actual Three.js camera projections across portrait,
square, and wide aspect ratios. Existing animation, playback, seek, offside, and
evidence tests cover the underlying behavior. Run `npm run typecheck`,
`npm test`, and `npm run build` before handoff.

The full pitch can occupy less horizontal space in a very short, wide canvas.
Stage layout belongs to the UI redesign; zoom is available for closer views.
Shadow rendering adds a pass for player geometry and goal frames. Mobile GPU
performance still needs measurement on real devices.

## Next asset pass: Blender

Create or obtain a permitted fictional footballer with a reusable skeleton,
editable kit materials, and in-place idle, run, pass, shot, and goalkeeper clips.
Export a GLB and load it with Three.js GLTFLoader. Asset animation must be sampled
from playback time rather than accumulated wall-clock updates, and root motion
must not replace the recorded player positions. Retain procedural players as a
fallback while assets load or if loading fails. Evaluate 22 independently
animated players on mobile before replacing the current instanced geometry.

This asset pass is not implemented by the initial pitch and lighting upgrade.
