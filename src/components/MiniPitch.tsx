import { useId } from "react";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { GOAL_WIDTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DISTANCE, PITCH_LENGTH, PITCH_WIDTH } from "@/match/contract";
import { lastAtOrBefore } from "@/playback/derive";

interface Props {
  fixture: MatchFixture;
  /** Positions are the latest snapshot at or before this time, never later. */
  timeMs: number;
  /** Marks this event's player; a pass also gets its path, already known when it is revealed. */
  highlight?: MatchEvent;
  className?: string;
}

const W = PITCH_LENGTH;
const H = PITCH_WIDTH;
const MID = H / 2;
const BOX_Y = MID - PENALTY_AREA_HALF_WIDTH;
const SIX_DEPTH = 5.5;
const SIX_HALF = GOAL_WIDTH / 2 + 5.5;
const CIRCLE_R = 9.15;
// Where the penalty arc leaves the box edge, above and below the spot.
const ARC_DY = Math.sqrt(CIRCLE_R ** 2 - (PENALTY_AREA_DEPTH - PENALTY_SPOT_DISTANCE) ** 2);
const STRIPE = W / 12;
const ASPECT = W / H;
/** Width in metres of the close-up around a highlighted event. */
const CLOSE_W = 74;
const BLEED = 6;

interface Box { x: number; y: number; w: number; h: number }

/** A close-up framed on the action, kept on the pitch where it fits; the whole pitch otherwise. */
function frame(focus: { x: number; y: number } | null, span = { w: 0, h: 0 }): Box {
  if (!focus) return { x: -3, y: -3, w: W + 6, h: H + 6 };
  const w = Math.min(W + 2 * BLEED, Math.max(CLOSE_W, span.w + 16, (span.h + 12) * ASPECT));
  const h = w / ASPECT;
  const clamp = (c: number, size: number, max: number) =>
    size >= max + 2 * BLEED ? max / 2 - size / 2 : Math.min(max + BLEED - size, Math.max(-BLEED, c - size / 2));
  return { x: clamp(focus.x, w, W), y: clamp(focus.y, h, H), w, h };
}

/**
 * A small top-down drawing of player and ball positions at one time, for
 * moment, evidence and recap cards. With a highlighted event it frames a
 * close-up on the action, like a cropped broadcast still; it covers whatever
 * box it is given, cropping evenly from the edges. Decorative: the card around
 * it carries the text. Home players are circles and away players squares, so
 * teams never rely on colour alone. Markers are dots of a fixed on-screen size
 * (zero-length strokes that ignore scaling), so they stay small at every
 * thumbnail size.
 */
export function MiniPitch({ fixture, timeMs, highlight, className }: Props) {
  const id = useId();
  const snaps = fixture.snapshots;
  const snap = snaps[Math.max(0, lastAtOrBefore(snaps, timeMs, (s) => s.t))]!;
  const teamOf = new Map(fixture.roster.map((p) => [p.id, p.teamId]));
  const team = new Map(fixture.teams.map((t) => [t.id, t]));
  const actor = highlight?.playerId;
  const actorAt = actor ? snap.players.find((q) => q.playerId === actor) : undefined;
  const pass = highlight?.type === "pass" && highlight.start && highlight.end
    ? { start: highlight.start, end: highlight.end } : null;

  const view = !highlight ? frame(null)
    : pass ? frame({ x: (pass.start.x + pass.end.x) / 2, y: (pass.start.y + pass.end.y) / 2 },
      { w: Math.abs(pass.end.x - pass.start.x), h: Math.abs(pass.end.y - pass.start.y) })
      : frame(actorAt ?? snap.ball);
  const vignette = `${id}-vignette`;

  return (
    <svg
      className={`minipitch${className ? ` ${className}` : ""}`}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={vignette} cx="50%" cy="45%" r="75%">
          <stop offset="55%" stopColor="#000" stopOpacity={0} />
          <stop offset="100%" stopColor="#000" stopOpacity={0.32} />
        </radialGradient>
      </defs>
      <rect className="minipitch__grass" x={-30} y={-30} width={W + 60} height={H + 60} />
      {Array.from({ length: 18 }, (_, i) => (
        <rect key={i} className="minipitch__stripe" x={(i * 2 - 5) * STRIPE} y={-30} width={STRIPE} height={H + 60} />
      ))}
      <g className="minipitch__lines">
        <rect x={0} y={0} width={W} height={H} />
        <line x1={W / 2} y1={0} x2={W / 2} y2={H} />
        <circle cx={W / 2} cy={MID} r={CIRCLE_R} />
        <rect x={0} y={BOX_Y} width={PENALTY_AREA_DEPTH} height={PENALTY_AREA_HALF_WIDTH * 2} />
        <rect x={W - PENALTY_AREA_DEPTH} y={BOX_Y} width={PENALTY_AREA_DEPTH} height={PENALTY_AREA_HALF_WIDTH * 2} />
        <rect x={0} y={MID - SIX_HALF} width={SIX_DEPTH} height={SIX_HALF * 2} />
        <rect x={W - SIX_DEPTH} y={MID - SIX_HALF} width={SIX_DEPTH} height={SIX_HALF * 2} />
        <path d={`M${PENALTY_AREA_DEPTH} ${MID - ARC_DY}A${CIRCLE_R} ${CIRCLE_R} 0 0 1 ${PENALTY_AREA_DEPTH} ${MID + ARC_DY}`} />
        <path d={`M${W - PENALTY_AREA_DEPTH} ${MID - ARC_DY}A${CIRCLE_R} ${CIRCLE_R} 0 0 0 ${W - PENALTY_AREA_DEPTH} ${MID + ARC_DY}`} />
        <rect className="minipitch__goal" x={-1.6} y={MID - GOAL_WIDTH / 2} width={1.6} height={GOAL_WIDTH} />
        <rect className="minipitch__goal" x={W} y={MID - GOAL_WIDTH / 2} width={1.6} height={GOAL_WIDTH} />
      </g>
      <g className="minipitch__spots">
        <circle cx={W / 2} cy={MID} r={0.45} />
        <circle cx={PENALTY_SPOT_DISTANCE} cy={MID} r={0.35} />
        <circle cx={W - PENALTY_SPOT_DISTANCE} cy={MID} r={0.35} />
      </g>
      {actorAt && <path className="minipitch__ring" d={dot(actorAt)} />}
      {pass && <PassPath start={pass.start} end={pass.end} head={view.w * 0.028} />}
      {snap.players.map((p) => {
        const t = team.get(teamOf.get(p.playerId) ?? "");
        if (!t) return null;
        const shape = `minipitch__player minipitch__player--${t.side}${p.playerId === actor ? " minipitch__player--actor" : ""}`;
        return (
          <g key={p.playerId} className={shape}>
            <path className="minipitch__outline" d={dot(p)} />
            <path className="minipitch__kit" d={dot(p)} stroke={t.kit.primary} />
          </g>
        );
      })}
      <path className="minipitch__outline minipitch__ball-outline" d={dot(snap.ball)} />
      <path className="minipitch__ball" d={dot(snap.ball)} />
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#${vignette})`} />
    </svg>
  );
}

/** A zero-length path: stroked with a cap, it draws a dot whose size is set in CSS pixels. */
const dot = (p: { x: number; y: number }) => `M${p.x} ${p.y}h0`;

/** A dashed pass line ending in a small arrowhead at the reception point. */
function PassPath({ start, end, head }: { start: { x: number; y: number }; end: { x: number; y: number }; head: number }) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = end.x - ux * head;
  const by = end.y - uy * head;
  return (
    <g className="minipitch__path">
      <line x1={start.x} y1={start.y} x2={bx} y2={by} />
      <polygon points={`${end.x},${end.y} ${bx - uy * head * 0.55},${by + ux * head * 0.55} ${bx + uy * head * 0.55},${by - ux * head * 0.55}`} />
    </g>
  );
}
