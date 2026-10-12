"""Build original PitchLens assets. Run with Blender --background --python this_file.

Coordinates below use the application's +X forward, +Y up convention. Each
named mesh has its origin at the existing animation joint. The GLB is an
articulated mesh library; animation remains deterministic in the application.
"""
from pathlib import Path
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


# A fitted jersey: waist, abdomen, chest, shoulders, tapered neck opening.
Shape().loft([
    (-.045, .105, .155, 0, .88), (.015, .11, .16, 0, 1),
    (.14, .105, .163, .005, 1), (.30, .115, .205, .008, 1),
    (.43, .119, .23, .005, 1), (.50, .10, .23, 0, 1),
    (.55, .075, .20, 0, 1), (.575, .068, .085, 0, .65),
]).finish("torso", (0, .9, 0))

parts.shorts()
parts.head()

# A shaped hair cap, leaving the lower face and forehead visible.
hair = Shape()
hair.loft([(.045, .100, .100, -.014, .75), (.090, .108, .100, -.005, .9),
           (.145, .085, .080, .012, 1), (.175, .040, .045, .035, .9),
           (.182, .005, .008, .045, .9)])
hair.finish("hair", (0, 1.63, 0))

Shape().loft([(.05, .005, .005, 0, 1), (.025, .060, .065, 0, 1),
              (0, .075, .080, 0, 1), (-.05, .078, .082, 0, 1),
              (-.13, .071, .075, 0, 1), (-.16, .070, .073, 0, .7)]).finish("sleeve", (0, 1.42, -.25))
Shape().loft([(0, .060, .065, 0, 1), (-.08, .066, .067, 0, 1),
              (-.17, .060, .062, 0, 1),
              (-.27, .053, .056, .004, .88)]).finish("upperArm", (0, 1.42, -.25))
arm = Shape().loft([(0, .051, .053, 0, 1), (-.08, .054, .052, 0, 1),
                    (-.20, .035, .034, 0, 1), (-.26, .033, .032, 0, 1)])
arm.oval((.005, -.284, 0), (.036, .035, .022), .95, 8, 6)
for finger, length in enumerate([.039, .049, .046, .034]):
    arm.oval((-.019 + finger * .016, -.309 - length / 2, 0),
             (.008, length / 2, .010), .95, 6, 4)
arm.oval((.040, -.291, .003), (.014, .029, .014), .95, 6, 4)
arm.finish("forearm", (0, 1.15, -.25))

parts.thigh()
parts.shin()
parts.boot()

# The model is editable in its assembled neutral pose. Mirrored preview parts
# are excluded from the GLB library, which uses one geometry per limb type.
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=str(OUT / "footballer.glb"), export_format="GLB",
                          use_selection=True, export_yup=True, export_animations=False,
                          export_extras=True, export_materials="EXPORT")
for name in ["sleeve", "upperArm", "forearm", "thigh", "shin", "boot"]:
    original = bpy.data.objects[name]
    mirrored = original.copy()
    mirrored.data = original.data
    mirrored.name = name + "_preview_right"
    mirrored.location.y *= -1
    bpy.context.collection.objects.link(mirrored)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "footballer.blend"))
print("PitchLens footballer exported:", OUT / "footballer.glb")

# Optional close-up for inspecting authored detail independently of pitch zoom.
if "--preview" in sys.argv:
    palette = {"torso": (.02, .64, .85, 1), "sleeve": (.02, .64, .85, 1),
               "shin": (.02, .64, .85, 1), "shorts": (.015, .035, .065, 1),
               "boot": (.015, .025, .04, 1), "hair": (.065, .035, .02, 1)}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        base = obj.name.split("_preview")[0]
        shaded = material.copy()
        multiply = shaded.node_tree.nodes.new("ShaderNodeMixRGB")
        multiply.blend_type = "MULTIPLY"
        multiply.inputs[0].default_value = 1
        multiply.inputs[2].default_value = palette.get(base, (.72, .43, .25, 1))
        detail = next(node for node in shaded.node_tree.nodes if node.type == "VERTEX_COLOR")
        shaded.node_tree.links.new(detail.outputs["Color"], multiply.inputs[1])
        shaded.node_tree.links.new(multiply.outputs[0], shaded.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
        obj.data.materials.clear()
        obj.data.materials.append(shaded)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.world.color = (.3, .3, .3)
    bpy.ops.object.camera_add(location=(3.6, -5.5, 2.6))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, .9)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.15
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(3, -4, 5))
    bpy.context.object.data.energy = 450
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = 4
    scene.render.resolution_x = 720
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(SOURCE / "footballer-preview.png")
    bpy.ops.render.render(write_still=True)
