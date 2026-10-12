"""Inspect the runtime goal and ball meshes; called by preview-field-assets.mjs."""
import json
import sys
from pathlib import Path
import bpy
from mathutils import Vector

source, output = sys.argv[sys.argv.index("--") + 1:]
models = json.loads(Path(source).read_text())
bpy.context.preferences.filepaths.save_version = 0
for kind, records in models.items():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for record in records:
        mesh = bpy.data.meshes.new(record["name"])
        mesh.from_pydata([(x, -z, y) for x, y, z in record["vertices"]], [], record["faces"])
        mesh.update()
        for face in mesh.polygons:
            face.use_smooth = True
        # Preserve the runtime's radial ball normals and cylindrical cord normals.
        mesh.normals_split_custom_set([(record["normals"][loop.vertex_index][0],
                                       -record["normals"][loop.vertex_index][2],
                                       record["normals"][loop.vertex_index][1]) for loop in mesh.loops])
        material = bpy.data.materials.new(record["name"])
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*record["color"], 1)
        bsdf.inputs["Roughness"].default_value = record["roughness"]
        if record["colors"]:
            colors = mesh.color_attributes.new(name="Panels", type="FLOAT_COLOR", domain="POINT")
            for i, color in enumerate(record["colors"]):
                colors.data[i].color = color
            node = material.node_tree.nodes.new("ShaderNodeVertexColor")
            node.layer_name = "Panels"
            material.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
            noise = material.node_tree.nodes.new("ShaderNodeTexNoise")
            noise.inputs["Scale"].default_value = 180
            bump = material.node_tree.nodes.new("ShaderNodeBump")
            bump.inputs["Strength"].default_value = .2
            bump.inputs["Distance"].default_value = .004
            material.node_tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            material.node_tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        obj = bpy.data.objects.new(record["name"], mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(material)
        if kind == "ball":
            obj.location.z = 1
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.world.color = (.25, .25, .25)
    bpy.ops.mesh.primitive_plane_add(size=200)
    floor = bpy.context.object
    floor.name = "preview-floor"
    material = bpy.data.materials.new("Preview floor")
    material.diffuse_color = (.16, .19, .17, 1)
    floor.data.materials.append(material)
    camera_position = (-8, -11, 5.5) if kind == "goal" else (3.3, -5, 2.7)
    target = Vector((.8, 0, 1.1) if kind == "goal" else (0, 0, 1))
    bpy.ops.object.camera_add(location=camera_position)
    camera = bpy.context.object
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 9.5 if kind == "goal" else 2.6
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(-3, -4, 8))
    bpy.context.object.data.energy = 1200
    bpy.context.object.data.size = 5
    scene.render.resolution_x = 1200 if kind == "goal" else 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(Path(output) / f"{kind}-preview.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(output) / f"{kind}-preview.blend"), compress=True)
    bpy.ops.render.render(write_still=True)
    if not Path(scene.render.filepath).is_file():
        raise RuntimeError(f"Missing {kind} preview")
