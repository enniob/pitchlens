/**
 * "Moments": the events a fan cares about, and what the broadcast overlays
 * show at time t. Like the rest of playback these are pure functions of the
 * fixture and the time, built only from events with a timestamp ≤ t, so
 * nothing on screen can reveal what has not happened yet.
 */
import type { EventType, MatchEvent, MatchFixture } from "@/match/contract";
import { clampTime, eventsAt } from "./derive";

/** Events worth a marker, a pop-up or a line in the simple live feed. Passes, balls won and deflections are Pro detail. */
export const KEY_EVENT_TYPES: readonly EventType[] = [
  "goal",
  "shot",
  "shot-result",
  "foul",
  "offside",
  "penalty",
  "corner",
  "free-kick",
  "kickoff",
  "formation-change",
  "throw-in",
  "goal-kick",
];

/** Stoppages that get a short pop-up. */
const STOPPAGE_TYPES: readonly EventType[] = ["foul", "offside", "penalty"];

export const isKeyEvent = (e: MatchEvent) => KEY_EVENT_TYPES.includes(e.type);

/** How long each pop-up stays on screen after its event, ms. */
export const BANNER_MS = { goal: 5_000, tactic: 6_000, stop: 2_500 } as const;
export type BannerKind = keyof typeof BANNER_MS;

/** How far back the live feed looks, and how many cards it shows. */
export const FEED_WINDOW_MS = { simple: 12_000, pro: 20_000 } as const;
export const FEED_MAX = { simple: 3, pro: 5 } as const;

/** Key moments reached by t, oldest first, for the timeline. A shot's result shares its shot's marker. */
export function timelineMoments(fixture: MatchFixture, t: number): MatchEvent[] {
  return eventsAt(fixture, t).filter((e) => isKeyEvent(e) && e.type !== "shot-result");
}

/** Time of the latest key moment strictly before t, or null. */
export function previousMomentTime(fixture: MatchFixture, t: number): number | null {
  let found: number | null = null;
  for (const e of fixture.events) {
    if (e.t >= t) break;
    if (isKeyEvent(e)) found = e.t;
  }
  return found;
}

/** Time of the earliest key moment strictly after t, or null. */
export function nextMomentTime(fixture: MatchFixture, t: number): number | null {
  for (const e of fixture.events) if (e.t > t && isKeyEvent(e)) return e.t;
  return null;
}

export function bannerKind(e: MatchEvent): BannerKind | null {
  if (e.type === "goal") return "goal";
  if (e.type === "formation-change") return "tactic";
  if (STOPPAGE_TYPES.includes(e.type)) return "stop";
  return null;
}

/** The pop-up on screen at t: the newest goal, formation change or stoppage still inside its display time. */
export function activeBanner(fixture: MatchFixture, t: number): { event: MatchEvent; kind: BannerKind } | null {
  const time = clampTime(fixture, t);
  const reached = eventsAt(fixture, time);
  for (let i = reached.length - 1; i >= 0; i--) {
    const e = reached[i]!;
    // Events are ordered, and no pop-up lasts longer than the goal or tactic window.
    if (time - e.t >= BANNER_MS.tactic) break;
    const kind = bannerKind(e);
    if (kind && time - e.t < BANNER_MS[kind]) return { event: e, kind };
  }
  return null;
}

/**
 * The live feed at t, newest first: key moments from the last 12 s (at most
 * three), or with Pro data every event from the last 20 s (at most five).
 */
export function liveFeed(fixture: MatchFixture, t: number, pro: boolean): MatchEvent[] {
  const time = clampTime(fixture, t);
  const windowMs = pro ? FEED_WINDOW_MS.pro : FEED_WINDOW_MS.simple;
  const max = pro ? FEED_MAX.pro : FEED_MAX.simple;
  const out: MatchEvent[] = [];
  const reached = eventsAt(fixture, time);
  for (let i = reached.length - 1; i >= 0 && out.length < max; i--) {
    const e = reached[i]!;
    if (time - e.t > windowMs) break;
    if (pro || isKeyEvent(e)) out.push(e);
  }
  return out;
}
