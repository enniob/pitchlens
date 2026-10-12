import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { GOAL_HEIGHT, GOAL_WIDTH, POST_RADIUS } from "@/match/contract";
import { createGoal, GOAL_DEPTH } from "@/scene/Goal";
import { createFootballGeometry, footballPanels, footballGrain } from "@/scene/footballGeometry";
import { BallModel } from "@/scene/Ball";

describe("reference football", () => {
  it("has 12 pentagons and 20 hexagons with exactly two panels sharing each edge", () => {
    const panels = footballPanels();
    expect(panels.filter((p) => p.kind === "pentagon")).toHaveLength(12);
    expect(panels.filter((p) => p.kind === "hexagon")).toHaveLength(20);
    const edges = new Map<string, number>();
    const key = (p: THREE.Vector3) => p.toArray().map((n) => n.toFixed(6)).join(",");
    for (const { corners, kind } of panels) {
      expect(corners).toHaveLength(kind === "pentagon" ? 5 : 6);
      corners.forEach((p, i) => {
        const edge = [key(p), key(corners[(i + 1) % corners.length]!)].sort().join("/");
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      });
    }
    expect(edges.size).toBe(90);
    expect([...edges.values()].every((count) => count === 2)).toBe(true);
  });

  it("keeps curved panel geometry spherical, outward-facing and within a small mesh budget", () => {
    const geometry = createFootballGeometry();
    const positions = geometry.getAttribute("position");
    expect(positions.count / 3).toBeLessThan(4000);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < positions.count; i += 3) {
      a.fromBufferAttribute(positions, i); b.fromBufferAttribute(positions, i + 1); c.fromBufferAttribute(positions, i + 2);
      expect(a.length()).toBeGreaterThan(.99);
      expect(a.length()).toBeLessThanOrEqual(1.000001);
      expect(b.sub(a).cross(c.sub(a)).dot(a)).toBeGreaterThan(0);
    }
    expect(geometry.getAttribute("color").count).toBe(positions.count);
    expect(geometry.getAttribute("uv").count).toBe(positions.count);
    geometry.dispose();
  });

  it("reconstructs the same ball position and spin after seeking backwards or changing zoom", () => {
    const model = new BallModel();
    const ball = model.object.getObjectByName("football-panels") as THREE.Mesh;
    const at = { x: 58, y: 30, z: .11 };
    model.setPosition(at);
    const position = ball.position.clone(), rotation = ball.quaternion.clone();
    model.setPosition({ x: 93, y: 42, z: 2 });
    model.setPosition(at);
    expect(ball.position.equals(position)).toBe(true);
    expect(ball.quaternion.equals(rotation)).toBe(true);
    model.setZoom(3);
    expect(ball.quaternion.equals(rotation)).toBe(true);
    expect(ball.position.y).toBeCloseTo(ball.scale.x);
    model.setPosition({ ...at, z: 2.11 });
    expect(ball.position.y).toBeCloseTo(ball.scale.x + 2);
  });

  it("uses reproducible grain without external images", () => {
    const first = footballGrain(), second = footballGrain();
    expect(first.image.data).toEqual(second.image.data);
    first.dispose(); second.dispose();
  });
});

describe("reference goals", () => {
  it("preserves simulation post centres and keeps the net out of the goal mouth", () => {
    const goal = createGoal(1);
    const frame = goal.getObjectByName("goal-frame") as THREE.InstancedMesh;
    expect(frame.count).toBe(3);
    const matrix = new THREE.Matrix4();
    frame.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBeCloseTo(GOAL_HEIGHT);
    for (const [i, side] of [[1, -1], [2, 1]]) {
      frame.getMatrixAt(i!, matrix);
      expect(matrix.elements[12]).toBeCloseTo(0);
      expect(matrix.elements[14]).toBeCloseTo(side! * GOAL_WIDTH / 2);
    }
    expect((frame.geometry as THREE.CylinderGeometry).parameters.radiusTop).toBe(POST_RADIUS);
    const net = goal.getObjectByName("goal-net") as THREE.InstancedMesh;
    expect(net.count).toBeLessThan(3500);
    expect(net.count * net.geometry.index!.count / 3).toBeLessThan(30_000);
    let sagged = false;
    for (let i = 0; i < net.count; i++) {
      net.getMatrixAt(i, matrix);
      const p = new THREE.Vector3().setFromMatrixPosition(matrix);
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x).toBeLessThanOrEqual(GOAL_DEPTH + 1e-6);
      if (p.x < .001 && p.y < GOAL_HEIGHT - .001) expect(Math.abs(p.z)).toBeCloseTo(GOAL_WIDTH / 2);
      if (p.x > .5 && p.x < 1 && Math.abs(p.z) < .5 && p.y > 2)
        sagged ||= p.y < GOAL_HEIGHT - (GOAL_HEIGHT - 1.96) * p.x / 1.55 - .03;
    }
    expect(sagged).toBe(true);
  });

  it("mirrors both goals so every support and cord stays behind its goal line", () => {
    const left = createGoal(-1), right = createGoal(1);
    for (const name of ["goal-frame", "goal-supports", "goal-net", "goal-net-mounts"]) {
      const a = left.getObjectByName(name) as THREE.InstancedMesh;
      const b = right.getObjectByName(name) as THREE.InstancedMesh;
      expect(a.count).toBe(b.count);
      const ma = new THREE.Matrix4(), mb = new THREE.Matrix4();
      for (let i = 0; i < a.count; i++) {
        a.getMatrixAt(i, ma); b.getMatrixAt(i, mb);
        expect(ma.elements[12]).toBeCloseTo(-mb.elements[12]!);
        expect(ma.elements[13]).toBeCloseTo(mb.elements[13]!);
        expect(ma.elements[14]).toBeCloseTo(mb.elements[14]!);
      }
    }
  });
});
