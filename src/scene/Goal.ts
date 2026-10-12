/** Reference-shaped goal furniture. Simulation frame centres remain unchanged. */
import * as THREE from "three";
import { GOAL_HEIGHT, GOAL_WIDTH, POST_RADIUS } from "@/match/contract";

export const GOAL_DEPTH = 2;
const REAR_TOP_DEPTH = 1.55;
const REAR_HEIGHT = 1.96;
const BASE_HEIGHT = .055;
const CELL_SIZE = .16;
const UP = new THREE.Vector3(0, 1, 0);
type Surface = (u: number, v: number) => THREE.Vector3;

/** Sample curved cords along both axes of a square mesh, leaving the mouth open. */
function netCords(surface: Surface, columns: number, rows: number, cords: THREE.Vector3[][]): void {
  for (let col = 0; col <= columns; col++) {
    const points = Array.from({ length: rows + 1 }, (_, row) => surface(col / columns, row / rows));
    cords.push(points);
  }
  for (let row = 0; row <= rows; row++) {
    const points = Array.from({ length: columns + 1 }, (_, col) => surface(col / columns, row / rows));
    cords.push(points);
  }
}

/** One shared cylinder draw call per set of rods/cords, regardless of segment count. */
function tubes(name: string, paths: THREE.Vector3[][], radius: number, material: THREE.Material, sides: number, capped = true): THREE.InstancedMesh {
  const count = paths.reduce((sum, path) => sum + path.length - 1, 0);
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(radius, radius, 1, sides, 1, !capped), material, count);
  mesh.name = name;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const delta = new THREE.Vector3();
  const midpoint = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  let index = 0;
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    delta.subVectors(b, a);
    scale.y = delta.length();
    rotation.setFromUnitVectors(UP, delta.normalize());
    midpoint.addVectors(a, b).multiplyScalar(.5);
    mesh.setMatrixAt(index++, matrix.compose(midpoint, rotation, scale));
  }
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
}

/** Goal is local to the goal line, with its rear in +X; the left goal mirrors it. */
export function createGoal(side: -1 | 1): THREE.Group {
  const goal = new THREE.Group();
  goal.name = side === 1 ? "goal-right" : "goal-left";
  const half = GOAL_WIDTH / 2;
  const point = (depth: number, height: number, z: number) => new THREE.Vector3(depth * side, height, z);
  const frameMaterial = new THREE.MeshStandardMaterial({ color: "#f5f5f1", roughness: .38, metalness: .08 });
  const supportMaterial = new THREE.MeshStandardMaterial({ color: "#e9eceb", roughness: .5, metalness: .08 });
  const front: THREE.Vector3[][] = [[point(0, GOAL_HEIGHT, -half), point(0, GOAL_HEIGHT, half)]];
  const supports: THREE.Vector3[][] = [[point(GOAL_DEPTH, BASE_HEIGHT, -half), point(GOAL_DEPTH, BASE_HEIGHT, half)],
    [point(REAR_TOP_DEPTH, REAR_HEIGHT, -half), point(REAR_TOP_DEPTH, REAR_HEIGHT, half)]];
  for (const z of [-half, half]) {
    front.push([point(0, 0, z), point(0, GOAL_HEIGHT, z)]);
    supports.push([point(0, BASE_HEIGHT, z), point(GOAL_DEPTH, BASE_HEIGHT, z)],
      [point(GOAL_DEPTH, BASE_HEIGHT, z), point(REAR_TOP_DEPTH, REAR_HEIGHT, z)],
      [point(0, GOAL_HEIGHT, z), point(REAR_TOP_DEPTH, REAR_HEIGHT, z)]);
  }
  const posts = tubes("goal-frame", front, POST_RADIUS, frameMaterial, 16);
  const rear = tubes("goal-supports", supports, .035, supportMaterial, 10);
  posts.castShadow = rear.castShadow = true;
  goal.add(posts, rear);

  const cords: THREE.Vector3[][] = [];
  const across = Math.ceil(GOAL_WIDTH / CELL_SIZE);
  const vertical = Math.ceil(REAR_HEIGHT / CELL_SIZE);
  const depth = Math.ceil(GOAL_DEPTH / CELL_SIZE);
  // Every sag term vanishes at the boundary, so the four panels share edges.
  netCords((u, v) => point(REAR_TOP_DEPTH * u,
    THREE.MathUtils.lerp(GOAL_HEIGHT, REAR_HEIGHT, u) - .10 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v),
    (v - .5) * GOAL_WIDTH), depth, across, cords);
  netCords((u, v) => point(THREE.MathUtils.lerp(GOAL_DEPTH, REAR_TOP_DEPTH, v)
    + .10 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v),
    THREE.MathUtils.lerp(BASE_HEIGHT, REAR_HEIGHT, v), (u - .5) * GOAL_WIDTH), across, vertical, cords);
  for (const z of [-half, half]) netCords((u, v) => point(
    u * THREE.MathUtils.lerp(GOAL_DEPTH, REAR_TOP_DEPTH, v),
    THREE.MathUtils.lerp(BASE_HEIGHT, THREE.MathUtils.lerp(GOAL_HEIGHT, REAR_HEIGHT, u), v),
    z + Math.sign(z) * .055 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)), depth, vertical, cords);
  const net = tubes("goal-net", cords, .005, new THREE.MeshStandardMaterial({
    color: "#cbd0cc", roughness: .95,
  }), 4, false);
  // Fine netting stays out of the shadow pass to avoid a dark moire on the turf.
  goal.add(net);

  const mounts = new THREE.InstancedMesh(new THREE.BoxGeometry(.15, .12, .16),
    new THREE.MeshStandardMaterial({ color: "#253747", roughness: .7 }), 4);
  mounts.name = "goal-net-mounts";
  const matrix = new THREE.Matrix4();
  let mount = 0;
  for (const z of [-half, half]) for (const [x, y] of [[GOAL_DEPTH, BASE_HEIGHT], [REAR_TOP_DEPTH, REAR_HEIGHT]]) {
    mounts.setMatrixAt(mount++, matrix.makeTranslation(side * x!, y!, z));
  }
  mounts.computeBoundingSphere();
  goal.add(mounts);
  return goal;
}
