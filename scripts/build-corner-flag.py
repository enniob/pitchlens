"""Build the original PitchLens corner flag. Run with Blender --background --python this_file.

Dimensions follow the reference sheet: a 1.5 m pole above ground with a rounded
cap, two navy clips, and a 40 x 30 cm low-poly cloth with a baked gentle wave.
All three meshes have their origin at the pole base (ground contact), so the
runtime can drop the flag on a pitch corner without offsets. The cloth material
is named "Flag" so the application can recolour it; mint, coral and navy
variants exist only in the Blender source and preview.

Add `-- --preview` to render `corner-flag-preview.png` with the three variants.
"""
from pathlib import Path
import math
import sys
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "models"
SOURCE = ROOT / "assets" / "blender"
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0

POLE_HEIGHT = 1.5
POLE_RADIUS = .0175
FLAG_LENGTH, FLAG_HEIGHT = .40, .30
FLAG_BOTTOM = 1.12
CLIP_HEIGHTS = (FLAG_BOTTOM + .015, FLAG_BOTTOM + FLAG_HEIGHT - .015)


def linear(hex_colour):
    """sRGB hex to Blender's linear colour space."""
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return (*[c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels], 1)


def make_material(name, colour, roughness, double_sided=False):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = colour
    bsdf.inputs["Roughness"].default_value = roughness
    material.use_backface_culling = not double_sided
    return material


POLE = make_material("Pole", linear("#ecebe4"), .45)
CLIP = make_material("Clip", linear("#22344f"), .55)
VARIANTS = {"Flag": linear("#8edcb9"), "Flag coral": linear("#f07f6f"), "Flag navy": linear("#22344f")}
FLAGS = {name: make_material(name, colour, .9, double_sided=True) for name, colour in VARIANTS.items()}


def lathe(profile, segments, vertices, faces, center=(0, 0)):
    """Revolve (radius, height) pairs, bottom to top, closing both ends."""
    start = len(vertices)
    for radius, z in profile:
        for i in range(segments):
            a = i * math.tau / segments
            vertices.append((center[0] + radius * math.cos(a), center[1] + radius * math.sin(a), z))
    for j in range(len(profile) - 1):
        for i in range(segments):
            a = start + j * segments + i
            b = start + j * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    faces.append(tuple(start + i for i in reversed(range(segments))))
    faces.append(tuple(start + (len(profile) - 1) * segments + i for i in range(segments)))


def box(lo, hi, vertices, faces):
    start = len(vertices)
    for z in (lo[2], hi[2]):
        vertices += [(lo[0], lo[1], z), (hi[0], lo[1], z), (hi[0], hi[1], z), (lo[0], hi[1], z)]
    faces += [tuple(start + i for i in f) for f in
              [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]]


def finish(name, vertices, faces, material, smooth=True, uvs=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    for face in mesh.polygons:
        face.use_smooth = smooth
    if uvs:
        layer = mesh.uv_layers.new(name="UVMap")
        for loop in mesh.loops:
            layer.data[loop.index].uv = uvs[loop.vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def build_pole():
    vertices, faces = [], []
    # Shaft, then a slightly wider cap with a rounded dome.
    cap_base, cap_radius = POLE_HEIGHT - .045, .0205
    profile = [(POLE_RADIUS, 0), (POLE_RADIUS, cap_base - .004), (cap_radius, cap_base),
               (cap_radius, POLE_HEIGHT - cap_radius * .9)]
    for k in range(1, 6):
        a = k / 6 * math.pi / 2
        profile.append((cap_radius * math.cos(a), POLE_HEIGHT - cap_radius * .9 + cap_radius * .9 * math.sin(a)))
    profile.append((.003, POLE_HEIGHT))
    lathe(profile, 20, vertices, faces)
    return finish("corner-flag-pole", vertices, faces, POLE)


def build_clips():
    vertices, faces = [], []
    for z in CLIP_HEIGHTS:
        lathe([(.0215, z - .0175), (.0225, z - .016), (.0225, z + .016), (.0215, z + .0175)],
              20, vertices, faces)
        # The tab wraps the hoist edge of the cloth.
        box((.012, -.0075, z - .0165), (.05, .0075, z + .0165), vertices, faces)
    return finish("corner-flag-clips", vertices, faces, CLIP, smooth=False)


def cloth_point(u, v):
    """u runs from hoist to fly, v from bottom to top; returns a waved position."""
    x = .024 + FLAG_LENGTH * u * (1 - .035 * u)
    wave = .05 * math.sin(u * math.pi * 1.55) * u ** .7 + .012 * math.sin(v * math.pi) * u
    droop = .022 * u ** 1.6 * (1 - .45 * v)
    return (x, wave, FLAG_BOTTOM + FLAG_HEIGHT * v - droop)


def build_cloth(material=None, columns=12, rows=9):
    vertices, faces, uvs = [], [], []
    for j in range(rows + 1):
        for i in range(columns + 1):
            u, v = i / columns, j / rows
            vertices.append(cloth_point(u, v))
            uvs.append((u, v))
    for j in range(rows):
        for i in range(columns):
            a = j * (columns + 1) + i
            faces.append((a, a + 1, a + columns + 2, a + columns + 1))
    return finish("corner-flag-cloth", vertices, faces, material or FLAGS["Flag"], uvs=uvs)


pole, clips, cloth = build_pole(), build_clips(), build_cloth()
bpy.ops.object.select_all(action="DESELECT")
for obj in (pole, clips, cloth):
    obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT / "corner-flag.glb"), export_format="GLB",
                          use_selection=True, export_yup=True, export_animations=False,
                          export_materials="EXPORT")

# Colour variants share the exported geometry and sit beside it in the source file.
variants = [(pole, clips, cloth)]
for offset, name in [(.7, "Flag coral"), (1.4, "Flag navy")]:
    copies = []
    for original in (pole, clips, cloth):
        duplicate = original.copy()
        duplicate.data = original.data
        duplicate.name = f"{original.name}_{name.split()[1]}_variant"
        duplicate.location.x += offset
        if original is cloth:
            duplicate.material_slots[0].link = "OBJECT"
            duplicate.material_slots[0].material = FLAGS[name]
        bpy.context.collection.objects.link(duplicate)
        copies.append(duplicate)
    variants.append(copies)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "corner-flag.blend"), compress=True)
print("PitchLens corner flag exported:", OUT / "corner-flag.glb")

if "--preview" in sys.argv:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.view_settings.view_transform = "Standard"
    scene.world.color = (.55, .56, .58)
    bpy.ops.mesh.primitive_plane_add(size=40)
    floor = bpy.context.object
    floor.name = "preview-floor"
    floor.data.materials.append(make_material("Preview floor", linear("#d9dadc"), .9))
    # Subtle weave on the cloth, preview only.
    for material in FLAGS.values():
        nodes, links = material.node_tree.nodes, material.node_tree.links
        noise = nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 900
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = .08
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], nodes.get("Principled BSDF").inputs["Normal"])
    target = Vector((.85, 0, .8))
    bpy.ops.object.camera_add(location=(.9 + 2.2, -6.2, 1.9))
    camera = bpy.context.object
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.6
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(2, -4, 5))
    bpy.context.object.data.energy = 450
    bpy.context.object.data.size = 5
    bpy.ops.object.light_add(type="AREA", location=(-3, 2, 3))
    bpy.context.object.data.energy = 120
    bpy.context.object.data.size = 4
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(SOURCE / "corner-flag-preview.png")
    bpy.ops.render.render(write_still=True)
