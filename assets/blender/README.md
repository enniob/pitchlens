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

## Goalkeeper source

`goalkeeper.blend` and `public/models/goalkeeper.glb` are built by
`scripts/build-goalkeeper.py` and follow the reference sheet in `docs/`. The GLB
keeps the footballer's ten joint-local mesh names and joints, with long sleeves
in `upperArm` and `forearm` and tousled hair. Two extra meshes, `gloveLeft` and
`gloveRight`, are posed with the forearms. The rig does not mirror limbs, so each
glove is authored for its hand, with the palm turned towards the body. Kit parts
carry grey tints for team colours. Gloves carry fixed RGB colours (off-white
latex, navy backhand, mint strap) and need a white instance colour. The runtime loads this asset for `GK` players in a separate instanced group. Add `-- --preview` to render
`goalkeeper-preview.png`, a front, side and back turnaround with a glove study.

Both player scripts share `scripts/football_shapes.py`, which holds the lofting
helper and the common head, shorts, leg and boot geometry.

## Corner flag source

`corner-flag.blend` and `public/models/corner-flag.glb` are built by
`scripts/build-corner-flag.py`. The 1.5 m pole has a rounded cap and two navy
clips holding a 40 × 30 cm cloth with a baked wave. The cloth is a 12 × 9 quad
grid with UVs and a double-sided material named `Flag`, so it can be recoloured.
Every mesh origin is at the pole base on the ground. The coral and navy variants
in the `.blend` reuse the same geometry. Add `-- --preview` to render
`corner-flag-preview.png`. The runtime places four shared copies at the pitch corners with outward-facing cloth.
