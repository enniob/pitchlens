"""Build original PitchLens assets. Run with Blender --background --python this_file.

Coordinates below use the application's +X forward, +Y up convention. Each
named mesh has its origin at the existing animation joint. The GLB is an
articulated mesh library; animation remains deterministic in the application.
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

material = bpy.data.materials.new("Kit tint with vertex detail")
material.use_nodes = True
bsdf = material.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Roughness"].default_value = 0.85
color = material.node_tree.nodes.new("ShaderNodeVertexColor")
color.layer_name = "Detail"
material.node_tree.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])


class Shape:
    def __init__(self):
        self.vertices, self.faces, self.colors = [], [], []

    def loft(self, rings, center=(0, 0, 0), segments=12):
        """Rings: (height, depth radius, sideways radius, forward offset, tint)."""
        if rings[0][0] > rings[-1][0]:
            rings = list(reversed(rings))
        start = len(self.vertices)
        for y, rx, rz, dx, tint in rings:
            for i in range(segments):
                a = i * math.tau / segments
                self.vertices.append((center[0] + dx + rx * math.cos(a), center[1] + y,
                                      center[2] + rz * math.sin(a)))
                self.colors.append((tint, tint, tint, 1))
        for j in range(len(rings) - 1):
            for i in range(segments):
                a, b = start + j * segments + i, start + j * segments + (i + 1) % segments
                self.faces.append((a, a + segments, b + segments, b))
        self.faces.append(tuple(start + i for i in reversed(range(segments))))
        self.faces.append(tuple(start + (len(rings) - 1) * segments + i for i in range(segments)))
        return self

    def oval(self, center, radii, tint=1, segments=12, rows=8):
        rings = []
        for j in range(rows + 1):
            a = math.pi * j / rows
            r = max(0.001, math.sin(a))
            rings.append((math.cos(a) * radii[1], r * radii[0], r * radii[2], 0, tint))
        # Loft winding expects rings from bottom to top.
        return self.loft(list(reversed(rings)), center, segments)

    def finish(self, name, pivot):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([(x, -z, y) for x, y, z in self.vertices], [], self.faces)
        mesh.update()
        colors = mesh.color_attributes.new(name="Detail", type="FLOAT_COLOR", domain="POINT")
        for i, c in enumerate(self.colors):
            colors.data[i].color = c
        for face in mesh.polygons:
            face.use_smooth = False
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = (pivot[0], -pivot[2], pivot[1])
        obj.data.materials.append(material)
        return obj


# A fitted jersey: waist, abdomen, chest, shoulders, tapered neck opening.
Shape().loft([
    (-.045, .105, .155, 0, .88), (.015, .11, .16, 0, 1),
    (.14, .105, .163, .005, 1), (.30, .115, .205, .008, 1),
    (.43, .119, .23, .005, 1), (.50, .10, .23, 0, 1),
    (.55, .075, .20, 0, 1), (.575, .068, .085, 0, .65),
]).finish("torso", (0, .9, 0))

shorts = Shape().loft([(.02, .115, .16, 0, .72), (-.02, .12, .165, 0, .85),
                       (-.10, .12, .17, 0, 1)])
for side in [-1, 1]:
    shorts.loft([(-.09, .12, .085, 0, 1), (-.18, .115, .09, .005, 1),
                 (-.235, .11, .09, .01, .85)], center=(0, 0, side * .095))
shorts.finish("shorts", (0, .9, 0))

head = Shape().loft([(-.13, .045, .052, .025, .9),
                     (-.095, .076, .075, .015, 1),
                     (-.035, .100, .098, 0, 1),
                     (.045, .100, .095, -.003, 1),
                     (.105, .076, .079, -.008, 1),
                     (.137, .015, .025, -.015, 1)])
head.loft([(-.225, .055, .059, 0, 1), (-.10, .059, .065, .003, 1)])
head.oval((.099, -.015, 0), (.024, .030, .022), .92, 12, 8)
for side in [-1, 1]:
    head.oval((-.004, -.008, side * .099), (.028, .044, .019), .9, 12, 8)
    head.oval((.094, .025, side * .044), (.009, .010, .016), .06, 8, 4)
    head.oval((.093, .046, side * .045), (.010, .005, .020), .12, 8, 4)
head.oval((.095, -.065, 0), (.008, .006, .031), .35, 8, 4)
head.finish("head", (0, 1.63, 0))

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

# The hidden upper thigh is omitted so it cannot poke through the shorts.
Shape().loft([(-.21, .090, .075, .003, 1), (-.25, .085, .072, .005, 1),
              (-.29, .073, .067, .007, 1), (-.40, .060, .058, .012, .9),
              (-.44, .058, .056, .012, .9)]).finish("thigh", (0, .9, -.095))
Shape().loft([(0, .059, .057, .012, 1), (-.045, .061, .059, .009, .65),
              (-.08, .065, .064, 0, 1), (-.17, .063, .059, -.008, 1),
              (-.30, .038, .036, 0, 1), (-.40, .033, .035, .005, .8)]).finish("shin", (0, .46, -.095))
boot = Shape().oval((.064, -.006, 0), (.126, .049, .052), 1, 20, 8)
boot.oval((.055, -.038, 0), (.13, .015, .053), .65, 20, 6)
for x in [.02, .045, .07, .095]:
    boot.oval((x, .036, 0), (.006, .004, .031), 4, 8, 4)
for x in [-.025, .075, .13]:
    for z in [-.032, .032]:
        boot.oval((x, -.051, z), (.009, .009, .009), .8, 6, 4)
boot.finish("boot", (0, .06, -.095))

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
