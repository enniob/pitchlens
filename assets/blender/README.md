# Footballer source

`footballer.blend` and the generated `public/models/footballer.glb` are original
PitchLens project assets, created by `scripts/build-football-assets.py`. They
contain no third-party models, textures, logos, or real-player likenesses.
No third-party asset packages are used.

The ten export mesh names are an application contract. Their origins are at
the corresponding animation joints. The two sides share limb geometry; meshes
ending in `_preview_right` exist only to make the Blender source easier to edit
and are excluded from the runtime library. Re-run the script to regenerate the
asset, or preserve this contract when authoring a replacement.

Add `-- --preview` to the Blender build command to render a close-up
`footballer-preview.png` alongside the source. The preview uses a cyan kit;
runtime colours continue to come from the fixture.

`node scripts/preview-field-assets.mjs` creates goal and ball preview `.blend`
files and PNG close-ups from the actual Three.js geometry. Their authoritative
sources are `src/scene/Goal.ts` and `src/scene/footballGeometry.ts`; editing these
inspection files does not change the runtime meshes. `BLENDER_PATH` overrides
the default Blender 5.2 executable, and `--ball` renders only the ball.
