/**
 * Plain-language titles, icons and one-line explanations for match events,
 * written for fans who may not know the laws of the game. Presentation only:
 * the event data itself is never changed.
 */
import type { MatchEvent } from "@/match/contract";
import type { IconName } from "./Icon";

export type EventTone = "goal" | "tactic" | "stop" | "default";

export interface EventCopy {
  title: string;
  icon: IconName;
  explain: string;
  tone: EventTone;
}

const COPY: Partial<Record<MatchEvent["type"], Omit<EventCopy, "tone">>> = {
  goal: { title: "Goal!", icon: "goal", explain: "The whole ball crossed the goal line between the posts and under the bar." },
  shot: { title: "Shot", icon: "shot", explain: "A strike at goal. The result follows a moment later." },
  foul: {
    title: "Foul",
    icon: "whistle",
    explain: "A challenge broke the rules, so play stops for a free kick, or a penalty if it was inside the penalty area.",
  },
  offside: {
    title: "Offside",
    icon: "flag",
    explain: "When the pass was played, the receiver was in the opponents' half and beyond the second-last defender.",
  },
  penalty: { title: "Penalty", icon: "restart", explain: "A foul inside the penalty area: one shot from the spot, 11 m out." },
  corner: { title: "Corner", icon: "flag", explain: "A defender sent the ball over their own goal line, so the attackers restart from the corner." },
  "free-kick": { title: "Free kick", icon: "restart", explain: "Play restarts where the foul happened; opponents stand at least 9.15 m back." },
  kickoff: { title: "Kick-off", icon: "restart", explain: "Play starts or restarts from the centre spot. After a goal, the team that conceded kicks off." },
  "formation-change": { title: "Tactical change", icon: "swap", explain: "Same players in new positions. This is not a substitution." },
  "throw-in": { title: "Throw-in", icon: "restart", explain: "The ball crossed the sideline. The team that did not touch it last throws it back in." },
  "goal-kick": { title: "Goal kick", icon: "restart", explain: "The attackers put the ball over the goal line, so the goalkeeper restarts play." },
  turnover: { title: "Ball won", icon: "pass", explain: "Possession switches to the other team." },
  deflection: { title: "Deflection", icon: "pass", explain: "The ball came off a player or the goal frame." },
};

export function eventCopy(e: MatchEvent): EventCopy {
  const tone: EventTone =
    e.type === "goal" ? "goal" : e.type === "formation-change" ? "tactic" : ["foul", "offside", "penalty"].includes(e.type) ? "stop" : "default";
  if (e.type === "shot-result") {
    if (e.outcome === "saved") return { title: "Save", icon: "save", explain: "The goalkeeper stopped the shot.", tone };
    if (e.outcome === "blocked") return { title: "Shot blocked", icon: "save", explain: "An outfield player got in the way of the shot.", tone };
    return { title: "Off target", icon: "shot", explain: "The shot did not go in.", tone };
  }
  if (e.type === "pass") {
    if (e.outcome === "complete") return { title: "Pass", icon: "pass", explain: "A player finds a teammate.", tone };
    if (e.outcome === "intercepted") return { title: "Pass cut out", icon: "pass", explain: "An opponent reached the pass first.", tone };
    return { title: "Pass out of play", icon: "pass", explain: "The pass ran out of play.", tone };
  }
  const copy = COPY[e.type];
  return copy ? { ...copy, tone } : { title: e.type, icon: "pass", explain: "", tone };
}

/** The simulator's description with broadcast-style prefixes removed ("GOAL! ", "Kickoff: "). */
export function plainDescription(e: MatchEvent): string {
  return e.description
    .replace(/^GOAL! /i, "")
    .replace(/^Kickoff: /, "")
    .replace(/^Turnover: /, "")
    .replace("Kickoff by the conceding team", "The team that conceded restarts play");
}
