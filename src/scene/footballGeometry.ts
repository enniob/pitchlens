/** Original 32-panel football, constructed by truncating an icosahedron. */
import * as THREE from "three";

export interface FootballPanel {
  kind: "pentagon" | "hexagon";
  corners: THREE.Vector3[];
}

/** Twelve pentagons and twenty hexagons; shared edges precede seam inset. */
export function footballPanels(): FootballPanel[] {
  const source = new THREE.IcosahedronGeometry(1, 0);
  const positions = source.getAttribute("position");
  const vertices: THREE.Vector3[] = [];
  const indices: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(positions, i);
    let index = vertices.findIndex((v) => v.distanceToSquared(p) < 1e-10);
    if (index < 0) { index = vertices.length; vertices.push(p); }
    indices.push(index);
  }
  source.dispose();
  const neighbours = vertices.map(() => new Set<number>());
  const edge = (a: number, b: number) => vertices[a]!.clone().multiplyScalar(2).add(vertices[b]!).normalize();
  const panels: FootballPanel[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3) as [number, number, number];
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      neighbours[from]!.add(to); neighbours[to]!.add(from);
    }
    panels.push({ kind: "hexagon", corners: [edge(a, b), edge(b, a), edge(b, c), edge(c, b), edge(c, a), edge(a, c)] });
  }
  vertices.forEach((normal, a) => {
    const corners = [...neighbours[a]!].map((b) => edge(a, b));
    const tangent = corners[0]!.clone().addScaledVector(normal, -corners[0]!.dot(normal)).normalize();
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent);
    corners.sort((p, q) => Math.atan2(p.dot(bitangent), p.dot(tangent)) - Math.atan2(q.dot(bitangent), q.dot(tangent)));
    panels.push({ kind: "pentagon", corners });
  });
  return panels;
}

/** Smooth spherical patches with rounded lips, fine inset seams and UVs for leather grain. */
export function createFootballGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], uvs: number[] = [];
  const white = new THREE.Color("#eeeae1"), charcoal = new THREE.Color("#202225"), seam = new THREE.Color("#53534f");
  const addTriangle = (points: THREE.Vector3[], color: THREE.Color, radii: number[]) => {
    const uv = points.map((p) => [Math.atan2(p.z, p.x) / (Math.PI * 2) + .5, Math.acos(THREE.MathUtils.clamp(p.y, -1, 1)) / Math.PI]);
    if (Math.max(...uv.map((v) => v[0]!)) - Math.min(...uv.map((v) => v[0]!)) > .5)
      uv.forEach((v) => { if (v[0]! < .5) v[0]! += 1; });
    points.forEach((p, i) => {
      positions.push(p.x * radii[i]!, p.y * radii[i]!, p.z * radii[i]!);
      normals.push(p.x, p.y, p.z); colors.push(color.r, color.g, color.b); uvs.push(...uv[i]!);
    });
  };
  // A slightly recessed sphere closes the gaps between the separate panels.
  const core = new THREE.IcosahedronGeometry(1, 3);
  const corePositions = core.getAttribute("position");
  for (let i = 0; i < corePositions.count; i += 3)
    addTriangle([0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(corePositions, i + j).normalize()), seam, [.992, .992, .992]);
  core.dispose();
  for (const panel of footballPanels()) {
    const center = panel.corners.reduce((sum, p) => sum.add(p), new THREE.Vector3()).normalize();
    const corners = panel.corners.map((p) => p.clone().lerp(center, .018).normalize());
    if (new THREE.Vector3().crossVectors(corners[0]!.clone().sub(center), corners[1]!.clone().sub(center)).dot(center) < 0) corners.reverse();
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
      const subdivisions = 4;
      const sample = (u: number, v: number) => center.clone().multiplyScalar(1 - u - v).addScaledVector(a, u).addScaledVector(b, v).normalize();
      const radius = (u: number, v: number) => 1 - .004 * Math.pow(u + v, 8);
      const triangle = (coords: [number, number][]) => addTriangle(coords.map(([u, v]) => sample(u, v)),
        panel.kind === "pentagon" ? charcoal : white, coords.map(([u, v]) => radius(u, v)));
      for (let row = 0; row < subdivisions; row++) for (let col = 0; col < subdivisions - row; col++) {
        const u = row / subdivisions, v = col / subdivisions, d = 1 / subdivisions;
        triangle([[u, v], [u + d, v], [u, v + d]]);
        if (col < subdivisions - row - 1) triangle([[u + d, v], [u + d, v + d], [u, v + d]]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/** Small, fixed-seed leather grain; no external texture or canvas dependency. */
export function footballGrain(): THREE.DataTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  let seed = 73;
  for (let i = 0; i < pixels.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 100 + (seed >>> 26);
    pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
