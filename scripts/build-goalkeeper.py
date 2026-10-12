"""Build the original PitchLens goalkeeper. Run with Blender --background --python this_file.

The goalkeeper follows the footballer's joint-local contract: the same ten
mesh names with origins at the same animation joints, so the existing rig can
pose it unchanged. Differences are a long-sleeved jersey (upperArm and forearm
are sleeve fabric ending in a cuff stripe), tousled hair, and two extra parts,
`gloveLeft` and `gloveRight`, posed with the forearm. The rig does not mirror
limbs, so the gloves are authored per hand with the palm facing the body.

Kit parts carry grey vertex tints multiplied by the team colour at runtime.
Gloves carry fixed RGB vertex colours (off-white latex palm, navy backhand,
mint strap) and should be drawn with a white instance colour.

Add `-- --preview` to render `goalkeeper-preview.png`, a front/side/back
turnaround with a palm and backhand glove study.
"""
from pathlib import Path
import math
import sys
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import football_shapes as parts  # noqa: E402
from football_shapes import Shape  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "models"
SOURCE = ROOT / "assets" / "blender"
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
material = parts.detail_material()


def linear(hex_colour):
    """sRGB hex to Blender's linear colour space."""
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return (*[c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels], 1)


MINT, NAVY, OFFWHITE = linear("#6fdba4"), linear("#26324f"), linear("#efe7d3")

# A slightly roomier long-sleeved jersey with a darker crew-neck rib.
Shape().loft([
    (-.05, .108, .158, 0, .85), (.015, .113, .163, 0, 1),
    (.14, .108, .167, .005, 1), (.30, .119, .21, .008, 1),
    (.43, .123, .236, .005, 1), (.50, .104, .236, 0, 1),
    (.55, .078, .205, 0, 1), (.565, .072, .095, 0, .72),
    (.58, .066, .084, 0, .6),
]).finish("torso", (0, .9, 0))

parts.shorts()
parts.head()

# Tousled hair: the footballer's cap plus faceted tufts swept forward and up.
hair = Shape()
hair.loft([(.045, .102, .102, -.014, .75), (.090, .110, .102, -.005, .9),
           (.145, .088, .083, .012, 1), (.175, .045, .050, .035, .9),
           (.185, .006, .009, .045, .9)], segments=10)
for x, z, base, height, lean in [
    (.06, 0, .16, .04, .045), (.03, -.05, .155, .035, .035), (.03, .05, .155, .035, .035),
    (-.005, -.065, .135, .03, .015), (-.005, .065, .135, .03, .015), (-.01, 0, .175, .035, .02),
    (-.055, -.035, .13, .03, -.01), (-.055, .035, .13, .03, -.01), (.08, -.04, .135, .03, .04),
    (.08, .04, .135, .03, .04),
]:
    hair.loft([(base - .035, .04, .036, 0, .9), (base, .036, .032, lean * .3, 1),
               (base + height, .006, .005, lean, .85)], center=(x, 0, z), segments=5)
hair.finish("hair", (0, 1.63, 0))

# Shoulder cap over the long sleeve; the rig poses it with the upper arm.
Shape().loft([(.05, .005, .005, 0, 1), (.025, .060, .064, 0, 1),
              (0, .072, .076, 0, 1), (-.05, .073, .077, 0, 1),
              (-.09, .069, .073, 0, 1)], segments=10).finish("sleeve", (0, 1.42, -.25))
Shape().loft([(0, .068, .072, 0, 1), (-.08, .072, .073, 0, 1),
              (-.17, .066, .068, 0, .95),
              (-.28, .059, .061, .004, .9)], segments=10).finish("upperArm", (0, 1.42, -.25))
# Sleeve to the wrist, with a navy stripe just above the cuff.
Shape().loft([(.01, .060, .062, 0, .9), (-.08, .061, .060, 0, 1),
              (-.19, .049, .049, 0, 1), (-.196, .050, .050, 0, .22),
              (-.212, .050, .050, 0, .22), (-.218, .049, .049, 0, 1),
              (-.236, .047, .047, 0, 1)], segments=10).finish("forearm", (0, 1.15, -.25))


def glove(side):
    """Side -1 is the left hand (at -Z); the palm faces the body (+Z for the left)."""
    inward = -side
    shape = Shape()
    # Wrist strap, edged in navy.
    shape.loft([(-.222, .049, .048, 0, NAVY), (-.228, .053, .052, 0, MINT),
                (-.287, .054, .052, 0, MINT), (-.297, .050, .048, 0, NAVY)], segments=10)
    hand = len(shape.vertices)
    # Padded palm, widening towards the knuckles.
    shape.loft([(-.29, .050, .030, 0, NAVY), (-.32, .060, .034, 0, NAVY),
                (-.36, .064, .034, -.002, NAVY), (-.385, .058, .029, -.004, NAVY)], segments=10)
    # Broad, blunt padded fingers with latex tips that wrap onto the backhand.
    tips = []
    for x, length in [(.042, .062), (.014, .076), (-.014, .072), (-.042, .056)]:
        start = len(shape.vertices)
        shape.loft([(-.372, .0135, .017, 0, NAVY), (-.378 - length + .012, .0145, .0175, 0, NAVY),
                    (-.378 - length, .009, .011, 0, NAVY)], center=(x, 0, 0), segments=6)
        tips.append((start, len(shape.vertices), -.378 - length + .022))
    thumb = len(shape.vertices)
    shape.loft([(-.30, .019, .019, 0, NAVY), (-.36, .018, .018, .006, NAVY),
                (-.378, .011, .011, .008, NAVY)], center=(.062, 0, inward * .012), segments=6)
    # Latex palm, fingertips and thumb face; the backhand stays navy.
    for i in range(hand, len(shape.vertices)):
        x, y, z = shape.vertices[i]
        tip = any(a <= i < b and y < limit for a, b, limit in tips)
        if z * inward > .006 or tip or (i >= thumb and z * inward > -.004):
            shape.colors[i] = parts.rgba(OFFWHITE)
    # Oversized padding, and the palm turned 35 degrees forward as in a ready stance.
    turn = math.radians(35)
    for i in range(hand, len(shape.vertices)):
        x, y, z = shape.vertices[i]
        y = -.29 + (y + .29) * 1.18
        x, z = x * 1.18, z * 1.18
        shape.vertices[i] = (x * math.cos(turn) + inward * z * math.sin(turn), y,
                             -inward * x * math.sin(turn) + z * math.cos(turn))
    return shape.finish("gloveLeft" if side < 0 else "gloveRight", (0, 1.15, side * .25))


glove(-1)
glove(1)
parts.thigh()
parts.shin()
parts.boot()

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=str(OUT / "goalkeeper.glb"), export_format="GLB",
                          use_selection=True, export_yup=True, export_animations=False,
                          export_extras=True, export_materials="EXPORT")
# Mirrored preview limbs share geometry; they are excluded from the runtime library.
for name in ["sleeve", "upperArm", "forearm", "thigh", "shin", "boot"]:
    original = bpy.data.objects[name]
    mirrored = original.copy()
    mirrored.data = original.data
    mirrored.name = name + "_preview_right"
    mirrored.location.y *= -1
    bpy.context.collection.objects.link(mirrored)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "goalkeeper.blend"), compress=True)
print("PitchLens goalkeeper exported:", OUT / "goalkeeper.glb")

if "--preview" in sys.argv:
    palette = {"torso": MINT, "sleeve": MINT, "upperArm": MINT, "forearm": MINT, "shin": MINT,
               "shorts": NAVY, "boot": NAVY, "hair": linear("#2a1d16"), "head": linear("#c4865c"),
               "thigh": linear("#c4865c"), "gloveLeft": (1, 1, 1, 1), "gloveRight": (1, 1, 1, 1)}
    shaded = {}
    for name, colour in palette.items():
        tinted = material.copy()
        tree = tinted.node_tree
        multiply = tree.nodes.new("ShaderNodeMixRGB")
        multiply.blend_type = "MULTIPLY"
        multiply.inputs[0].default_value = 1
        multiply.inputs[2].default_value = colour
        detail = next(node for node in tree.nodes if node.type == "VERTEX_COLOR")
        tree.links.new(detail.outputs["Color"], multiply.inputs[1])
        tree.links.new(multiply.outputs[0], tree.nodes.get("Principled BSDF").inputs["Base Color"])
        shaded[name] = tinted
    body = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in body:
        obj.material_slots[0].link = "OBJECT"
        obj.material_slots[0].material = shaded[obj.name.split("_preview")[0]]

    def place(objects, location, rotation, scale=1, local=False):
        anchor = bpy.data.objects.new("preview-anchor", None)
        bpy.context.collection.objects.link(anchor)
        anchor.location, anchor.rotation_euler, anchor.scale = location, rotation, (scale,) * 3
        for obj in objects:
            copy = obj.copy()
            bpy.context.collection.objects.link(copy)
            copy.parent = anchor
            if local:
                copy.location = (0, 0, 0)

    # Front, side (facing right) and back views; Blender +X is the player's forward.
    for i, turn in enumerate([-math.pi / 2, 0, math.pi / 2]):
        place(body, (i * 1.1, 0, 0), (0, 0, turn))
    left = bpy.data.objects["gloveLeft"]
    # Fingers up; palm towards the camera, then the backhand below it.
    for z, spin in [(.62, 0), (-.18, math.pi)]:
        place([left], (3.3, 0, z), (0, math.pi, spin), 2.1, local=True)
    for obj in body:
        obj.hide_render = True

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.view_settings.view_transform = "Standard"
    scene.world.color = (.7, .71, .73)
    bpy.ops.object.camera_add(location=(1.65, -12, 1.0), rotation=(math.pi / 2, 0, 0))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 4.4
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(.5, -6, 4.5))
    key = bpy.context.object
    key.rotation_euler = (Vector((1.6, 0, 1)) - key.location).to_track_quat("-Z", "Y").to_euler()
    key.data.energy, key.data.size = 1100, 6
    bpy.ops.object.light_add(type="AREA", location=(4, 5, 3))
    fill = bpy.context.object
    fill.rotation_euler = (Vector((1.6, 0, 1)) - fill.location).to_track_quat("-Z", "Y").to_euler()
    fill.data.energy, fill.data.size = 500, 6
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(SOURCE / "goalkeeper-preview.png")
    bpy.ops.render.render(write_still=True)
