/** Render the actual procedural Three.js meshes through Blender for close-up QA.
 * Run: node scripts/preview-field-assets.mjs
 * BLENDER_PATH can override the installed Blender executable.
 */
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import * as THREE from "three";

const root = fileURLToPath(new URL("../", import.meta.url));
async function moduleUrl(relative, imports = {}) {
  const source = await readFile(resolve(root, relative), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [name, url] of Object.entries({ three: import.meta.resolve("three"), ...imports }))
    code = code.replaceAll(JSON.stringify(name), JSON.stringify(url));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const contract = await moduleUrl("src/match/contract.ts");
const { createGoal } = await import(await moduleUrl("src/scene/Goal.ts", { "@/match/contract": contract }));
const { createFootballGeometry } = await import(await moduleUrl("src/scene/footballGeometry.ts"));
const goal = createGoal(1);
const ball = new THREE.Mesh(createFootballGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .82 }));
ball.name = "football-panels";

function serialize(mesh) {
  const vertices = [], faces = [], colors = [], normals = [];
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute("position");
  const tint = geometry.getAttribute("color");
  const normal = geometry.getAttribute("normal");
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const p = new THREE.Vector3();
  for (let instance = 0; instance < (mesh.isInstancedMesh ? mesh.count : 1); instance++) {
    if (mesh.isInstancedMesh) mesh.getMatrixAt(instance, matrix);
    normalMatrix.getNormalMatrix(matrix);
    const offset = vertices.length;
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i).applyMatrix4(matrix);
      vertices.push(p.toArray());
      p.fromBufferAttribute(normal, i).applyNormalMatrix(normalMatrix);
      normals.push(p.toArray());
      if (tint) colors.push([tint.getX(i), tint.getY(i), tint.getZ(i), 1]);
    }
    const count = geometry.index?.count ?? positions.count;
    for (let i = 0; i < count; i += 3) faces.push([0, 1, 2].map((j) => offset + (geometry.index?.getX(i + j) ?? i + j)));
  }
  return { name: mesh.name, vertices, faces, normals, colors, color: mesh.material.color.toArray(), roughness: mesh.material.roughness };
}
const temporary = join(tmpdir(), `pitchlens-field-assets-${process.pid}.json`);
const output = resolve(root, "assets/blender");
await mkdir(output, { recursive: true });
try {
  await writeFile(temporary, JSON.stringify({ ...(process.argv.includes("--ball") ? {} : { goal: goal.children.map(serialize) }), ball: [serialize(ball)] }));
  const blender = process.env.BLENDER_PATH ?? "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe";
  const result = spawnSync(blender, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", resolve(root, "scripts/render-field-assets.py"), "--", temporary, output], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Blender preview failed (${result.status})`);
} finally {
  await unlink(temporary);
}
