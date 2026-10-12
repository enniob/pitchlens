"""Shared low-poly building blocks for the PitchLens footballer and goalkeeper.

Coordinates use the application's +X forward, +Y up, +Z player-right
convention; `finish` converts them to Blender's Z-up axes. Vertex colours are
either a grey tint multiplied by the runtime kit colour, or an RGB tuple for
parts with fixed colours such as goalkeeper gloves.
"""
import math
import bpy

MATERIAL_NAME = "Kit tint with vertex detail"


def detail_material():
    material = bpy.data.materials.get(MATERIAL_NAME)
    if material:
        return material
    material = bpy.data.materials.new(MATERIAL_NAME)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.85
    color = material.node_tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Detail"
    material.node_tree.links.new(color.outputs["Color"], bsdf.inputs["Base Color"])
    return material


def rgba(tint):
    return (tint, tint, tint, 1) if isinstance(tint, (int, float)) else (*tint[:3], 1)


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
                self.colors.append(rgba(tint))
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

    def finish(self, name, pivot, material=None):
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
        obj.data.materials.append(material or detail_material())
        return obj


def shorts():
    shape = Shape().loft([(.02, .115, .16, 0, .72), (-.02, .12, .165, 0, .85),
                          (-.10, .12, .17, 0, 1)])
    for side in [-1, 1]:
        shape.loft([(-.09, .12, .085, 0, 1), (-.18, .115, .09, .005, 1),
                    (-.235, .11, .09, .01, .85)], center=(0, 0, side * .095))
    return shape.finish("shorts", (0, .9, 0))


def head():
    shape = Shape().loft([(-.13, .045, .052, .025, .9),
                          (-.095, .076, .075, .015, 1),
                          (-.035, .100, .098, 0, 1),
                          (.045, .100, .095, -.003, 1),
                          (.105, .076, .079, -.008, 1),
                          (.137, .015, .025, -.015, 1)])
    shape.loft([(-.225, .055, .059, 0, 1), (-.10, .059, .065, .003, 1)])
    shape.oval((.099, -.015, 0), (.024, .030, .022), .92, 12, 8)
    for side in [-1, 1]:
        shape.oval((-.004, -.008, side * .099), (.028, .044, .019), .9, 12, 8)
        shape.oval((.094, .025, side * .044), (.009, .010, .016), .06, 8, 4)
        shape.oval((.093, .046, side * .045), (.010, .005, .020), .12, 8, 4)
    shape.oval((.095, -.065, 0), (.008, .006, .031), .35, 8, 4)
    return shape.finish("head", (0, 1.63, 0))


def thigh():
    # The hidden upper thigh is omitted so it cannot poke through the shorts.
    return Shape().loft([(-.21, .090, .075, .003, 1), (-.25, .085, .072, .005, 1),
                         (-.29, .073, .067, .007, 1), (-.40, .060, .058, .012, .9),
                         (-.44, .058, .056, .012, .9)]).finish("thigh", (0, .9, -.095))


def shin():
    return Shape().loft([(0, .059, .057, .012, 1), (-.045, .061, .059, .009, .65),
                         (-.08, .065, .064, 0, 1), (-.17, .063, .059, -.008, 1),
                         (-.30, .038, .036, 0, 1), (-.40, .033, .035, .005, .8)]).finish("shin", (0, .46, -.095))


def boot():
    shape = Shape().oval((.064, -.006, 0), (.126, .049, .052), 1, 20, 8)
    shape.oval((.055, -.038, 0), (.13, .015, .053), .65, 20, 6)
    for x in [.02, .045, .07, .095]:
        shape.oval((x, .036, 0), (.006, .004, .031), 4, 8, 4)
    for x in [-.025, .075, .13]:
        for z in [-.032, .032]:
            shape.oval((x, -.051, z), (.009, .009, .009), .8, 6, 4)
    return shape.finish("boot", (0, .06, -.095))
