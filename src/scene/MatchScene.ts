/**
 * Composes pitch, players and ball; owns the renderer, lights, cameras, zoom/pan
 * input and resizing. It has no clock of its own: the caller passes a playback
 * frame to `update` and calls `render` once per animation frame. Player poses
 * are derived from the frame's time, never accumulated between frames.
 */
import * as THREE from "three";
import type { MatchFixture } from "@/match/contract";
import { motionAt } from "@/playback/animation";
import type { PlaybackFrame } from "@/playback/derive";
import type { OffsideReview } from "@/playback/offsideReview";
import { BallModel } from "./Ball";
import { CornerFlags } from "./CornerFlags";
import { followPan, pitchCameraDistance } from "./camera";
import { completedPassAt } from "./evidence";
import { HALF_LENGTH, HALF_WIDTH } from "./coords";
import { createPitch } from "./Pitch";
import { PlayerSquad } from "./Player";

export type CameraView = "overhead" | "angled";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const FOV = 22;
const VIEW_DIRECTIONS: Record<CameraView, THREE.Vector3> = {
  // Overhead with a slight tilt towards the bottom touchline.
  overhead: new THREE.Vector3(0, 1, 0.17).normalize(),
  // Broadcast-style elevated view from the bottom touchline.
  angled: new THREE.Vector3(0, 0.75, 0.85).normalize(),
};
/**
 * On portrait screens the camera is turned 90° so the pitch runs top-to-bottom
 * (left goal at the top), using the space far better on phones.
 */
const PORTRAIT_VIEW_DIRECTIONS: Record<CameraView, THREE.Vector3> = {
  overhead: new THREE.Vector3(0.17, 1, 0).normalize(),
  angled: new THREE.Vector3(0.85, 0.75, 0).normalize(),
};
const PORTRAIT_BELOW_ASPECT = 0.85;
/** Fraction of the visible half-extent the ball may roam before the zoomed camera follows it. */
const FOLLOW_DEAD_ZONE = 0.55;
/** After a manual drag, wait this long before following the ball again. */
const FOLLOW_RESUME_MS = 2500;

export interface MatchSceneOptions {
  container: HTMLElement;
  fixture: MatchFixture;
  onContextLost?: () => void;
}

export class MatchScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 1000);
  private readonly players: PlayerSquad;
  private readonly ball = new BallModel();
  private readonly cornerFlags = new CornerFlags();
  private readonly carrierRing = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 0.94, 64),
    new THREE.MeshBasicMaterial({ color: "#48ffcf", transparent: true, opacity: 0.88, depthWrite: false }),
  );
  private readonly carrierGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1.28, 64),
    new THREE.MeshBasicMaterial({ color: "#48ffcf", transparent: true, opacity: 0.12, depthWrite: false }),
  );
  private readonly passTrail = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
    new THREE.LineDashedMaterial({ color: "#83ffe0", dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.8 }),
  );
  private readonly passTip = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.8, 3),
    new THREE.MeshBasicMaterial({ color: "#83ffe0" }),
  );
  private readonly passDirection = new THREE.Vector3();
  private readonly reviewLine = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.025, HALF_WIDTH * 2),
    new THREE.MeshBasicMaterial({ color: "#facc15", depthTest: false }),
  );
  private readonly reviewPlayer = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 0.9, 48),
    new THREE.MeshBasicMaterial({ color: "#f97316", side: THREE.DoubleSide, depthTest: false }),
  );
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new AbortController();
  private readonly pointers = new Map<number, { x: number; y: number }>();

  private view: CameraView = "overhead";
  private tactics = false;
  // A modest broadcast crop puts the action closer, as in the reference.
  // Zoom out / reset still reaches the complete pitch at MIN_ZOOM.
  private zoom = 1.2;
  private manualZoom = false;
  private readonly pan = new THREE.Vector2(0, 0);
  private readonly lookAt = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredLookAt = new THREE.Vector3();
  private readonly ballGround = new THREE.Vector2(0, 0);
  private followPausedUntil = 0;
  private snapCamera = true;
  /** With reduced motion requested, camera moves snap instead of easing. */
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private disposed = false;

  constructor(private readonly options: MatchSceneOptions) {
    const { container, fixture } = options;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor("#0b1622");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "3D view of a synthetic football match. The score, timeline and key moments describe what happens.",
    );
    container.appendChild(canvas);

    this.scene.add(new THREE.HemisphereLight("#e4efff", "#45502b", 1.6));
    const sun = new THREE.DirectionalLight("#fff4db", 2.2);
    sun.position.set(-35, 65, -40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -76, right: 76, top: 64, bottom: -64, near: 1, far: 180 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = 0.035;
    sun.shadow.bias = -0.00015;
    this.scene.add(sun);

    this.scene.add(createPitch(this.renderer.capabilities.getMaxAnisotropy()));
    this.scene.add(this.cornerFlags.object);

    this.players = new PlayerSquad(fixture);
    this.scene.add(this.players.object);
    this.scene.add(this.ball.object);
    for (const ring of [this.carrierRing, this.carrierGlow]) {
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.scene.add(ring);
    }
    this.passTrail.visible = this.passTip.visible = false;
    this.scene.add(this.passTrail, this.passTip);
    this.reviewPlayer.rotation.x = -Math.PI / 2;
    this.reviewLine.renderOrder = this.reviewPlayer.renderOrder = 10;
    this.scene.add(this.reviewLine, this.reviewPlayer);
    this.setOffsideReview(null);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindInput(canvas);
  }

  update(frame: PlaybackFrame): void {
    // Poses come from the same recorded snapshots as the positions; the scene keeps no animation state.
    this.players.update(frame.players, motionAt(this.options.fixture, frame.timeMs), frame.timeMs);
    this.ball.setPosition(frame.ball);
    this.ballGround.set(frame.ball.x - HALF_LENGTH, frame.ball.y - HALF_WIDTH);
    const carrier = frame.players.find((player) => player.playerId === frame.possession?.playerId);
    for (const ring of [this.carrierRing, this.carrierGlow]) {
      ring.visible = carrier !== undefined;
      if (carrier) ring.position.set(carrier.x - HALF_LENGTH, 0.035, carrier.y - HALF_WIDTH);
    }
    const pass = this.tactics ? completedPassAt(frame.events, frame.timeMs) : null;
    this.passTrail.visible = this.passTip.visible = pass !== null;
    if (pass?.start && pass.end) {
      const positions = this.passTrail.geometry.getAttribute("position");
      positions.setXYZ(0, pass.start.x - HALF_LENGTH, 0.08, pass.start.y - HALF_WIDTH);
      positions.setXYZ(1, pass.end.x - HALF_LENGTH, 0.08, pass.end.y - HALF_WIDTH);
      positions.needsUpdate = true;
      this.passTrail.geometry.computeBoundingSphere();
      this.passTrail.computeLineDistances();
      this.passDirection.set(pass.end.x - pass.start.x, 0, pass.end.y - pass.start.y).normalize();
      this.passTip.position.set(pass.end.x - HALF_LENGTH, 0.1, pass.end.y - HALF_WIDTH);
      this.passTip.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.passDirection);
    }
  }

  render(): void {
    if (this.disposed) return;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  setView(view: CameraView): void {
    this.view = view;
    if (!this.manualZoom) this.zoom = view === "angled" && !this.portrait ? 1.2 : MIN_ZOOM;
    this.players.setLabelsVisible(this.tactics || view === "overhead");
  }

  setTactics(enabled: boolean): void {
    this.tactics = enabled;
    this.players.setLabelsVisible(enabled || this.view === "overhead");
  }

  setOffsideReview(review: OffsideReview | null): void {
    this.reviewLine.visible = this.reviewPlayer.visible = review !== null;
    if (!review) return;
    this.reviewLine.position.set(review.lineX - HALF_LENGTH, 0.08, 0);
    this.reviewPlayer.position.set(review.player.x - HALF_LENGTH, 0.09, review.player.y - HALF_WIDTH);
  }

  zoomBy(factor: number): void {
    this.manualZoom = true;
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.clampPan();
  }

  resetZoom(): void {
    this.manualZoom = true;
    this.zoom = MIN_ZOOM;
    this.pan.set(0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.cornerFlags.dispose();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.DirectionalLight) obj.shadow.dispose();
      // PlayerSquad owns its instance buffers; static goal furniture is owned here.
      if (obj instanceof THREE.InstancedMesh && !this.players.object.getObjectById(obj.id)) obj.dispose();
      const mesh = obj as Partial<THREE.Mesh>;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const mat = mesh.material;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        materials.add(m);
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    this.players.dispose();
    this.scene.clear();

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // Camera ------------------------------------------------------------------

  private get portrait(): boolean {
    return this.camera.aspect < PORTRAIT_BELOW_ASPECT;
  }

  private baseDistance(): number {
    const direction = (this.portrait ? PORTRAIT_VIEW_DIRECTIONS : VIEW_DIRECTIONS)[this.view];
    return pitchCameraDistance(direction, this.camera.aspect, FOV, this.portrait);
  }

  private updateCamera(): void {
    const distance = this.baseDistance() / this.zoom;
    this.followBall(distance);
    this.desiredLookAt.set(this.pan.x, 0, this.pan.y);
    const direction = (this.portrait ? PORTRAIT_VIEW_DIRECTIONS : VIEW_DIRECTIONS)[this.view];
    this.desiredPosition.copy(direction).multiplyScalar(distance).add(this.desiredLookAt);
    if (this.snapCamera || this.reducedMotion.matches) {
      this.camera.position.copy(this.desiredPosition);
      this.lookAt.copy(this.desiredLookAt);
      this.snapCamera = false;
    } else {
      // Ease camera moves (view toggle, zoom) — this only affects the camera, never match objects.
      this.camera.position.lerp(this.desiredPosition, 0.18);
      this.lookAt.lerp(this.desiredLookAt, 0.18);
    }
    this.camera.lookAt(this.lookAt);
    // Follow the eased camera, not the target zoom, so the ball resizes smoothly with it.
    this.ball.setZoom(this.baseDistance() / this.camera.position.distanceTo(this.lookAt));
  }

  /** While zoomed in, pan so the ball never leaves the frame (paused briefly after a manual drag). */
  private followBall(distance: number): void {
    if (this.zoom <= MIN_ZOOM || performance.now() < this.followPausedUntil) return;
    const direction = (this.portrait ? PORTRAIT_VIEW_DIRECTIONS : VIEW_DIRECTIONS)[this.view];
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // Visible ground half-extents at the look-at point; the screen-vertical axis is foreshortened by the tilt.
    const across = distance * tanVertical * this.camera.aspect;
    const along = (distance * tanVertical) / direction.y;
    const [halfX, halfZ] = this.portrait ? [along, across] : [across, along];
    const next = followPan(this.pan, { x: this.ballGround.x, z: this.ballGround.y }, halfX, halfZ, FOLLOW_DEAD_ZONE);
    this.pan.set(next.x, next.y);
    this.clampPan();
  }

  private clampPan(): void {
    const slack = 1 - 1 / this.zoom;
    this.pan.x = THREE.MathUtils.clamp(this.pan.x, -HALF_LENGTH * slack, HALF_LENGTH * slack);
    this.pan.y = THREE.MathUtils.clamp(this.pan.y, -HALF_WIDTH * slack, HALF_WIDTH * slack);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.options.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (!this.manualZoom) this.zoom = this.view === "angled" && !this.portrait ? 1.2 : MIN_ZOOM;
    this.camera.updateProjectionMatrix();
    this.snapCamera = true;
  }

  // Input -------------------------------------------------------------------

  private bindInput(canvas: HTMLCanvasElement): void {
    const signal = this.listeners.signal;

    canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        if (!this.disposed) this.options.onContextLost?.();
      },
      { signal },
    );

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0015));
      },
      { signal, passive: false },
    );

    const pinchDistance = () => {
      const [a, b] = [...this.pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };

    canvas.addEventListener(
      "pointerdown",
      (e) => {
        canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      },
      { signal },
    );

    canvas.addEventListener(
      "pointermove",
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        if (this.pointers.size === 2) {
          const before = pinchDistance();
          this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const after = pinchDistance();
          if (before > 0 && after > 0) this.zoomBy(after / before);
          return;
        }
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.zoom <= MIN_ZOOM) return;
        this.followPausedUntil = performance.now() + FOLLOW_RESUME_MS;
        // Drag to pan while zoomed in: convert pixels to metres at the look-at point.
        const distance = this.baseDistance() / this.zoom;
        const metresPerPixel =
          (2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / Math.max(1, canvas.clientHeight);
        const dx = (e.clientX - prev.x) * metresPerPixel;
        const dy = (e.clientY - prev.y) * metresPerPixel;
        if (this.portrait) {
          // When the camera is turned, screen right is scene −z and screen down is scene +x.
          this.pan.y += dx;
          this.pan.x -= dy;
        } else {
          this.pan.x -= dx;
          this.pan.y -= dy;
        }
        this.clampPan();
      },
      { signal },
    );

    const release = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
    };
    canvas.addEventListener("pointerup", release, { signal });
    canvas.addEventListener("pointercancel", release, { signal });
  }
}
