/**
 * Formation presets and slot assignments.
 *
 * A formation is one goalkeeper slot and ten outfield slots. Each slot has an
 * ID unique within the formation (e.g. "LCB"), a tactical position (e.g. "CB")
 * and a neutral spot given relative to the team's attacking direction:
 *
 *   - depth:   metres from the team's own goal line towards the goal it attacks
 *   - lateral: metres left (+) or right (−) of the pitch's centre line, as seen
 *              by a player facing the goal the team attacks
 *
 * `slotSpot` turns that into pitch coordinates. The two attacking directions
 * are a 180° rotation of each other, so a left back stands on their own left
 * whichever way the team attacks.
 *
 * Players keep their ID, name, shirt number and roster `role`; a slot only
 * says where they play. The goalkeeper slot is always filled by the roster
 * goalkeeper (there are no substitutions or keeper swaps).
 */
import {
  FORMATION_IDS,
  PITCH_LENGTH,
  PITCH_WIDTH,
  type FormationId,
  type Player,
  type SlotAssignments,
  type TacticalPosition,
  type Team,
  type Vec2,
} from "./contract";

export interface FormationSlot {
  id: string;
  position: TacticalPosition;
  depth: number;
  lateral: number;
  /** Shirt number given this slot by the default assignment, when a player with it is free. */
  shirt: number;
}

export interface Formation {
  id: FormationId;
  slots: readonly FormationSlot[];
}

const slot = (id: string, position: TacticalPosition, depth: number, lateral: number, shirt: number): FormationSlot => ({
  id,
  position,
  depth,
  lateral,
  shirt,
});

const BACK_FOUR = [
  slot("GK", "GK", 2.5, 0, 1),
  slot("RB", "RB", 27, -22, 2),
  slot("RCB", "CB", 25, -8, 5),
  slot("LCB", "CB", 25, 8, 4),
  slot("LB", "LB", 27, 22, 3),
];

/** Neutral spots sit in the team's own half, so kickoff positions are always legal. */
export const FORMATIONS: Record<FormationId, Formation> = {
  "4-4-2": {
    id: "4-4-2",
    slots: [
      ...BACK_FOUR,
      slot("RM", "RM", 40, -23, 7),
      slot("RCM", "CM", 38, -7, 8),
      slot("LCM", "CM", 38, 7, 6),
      slot("LM", "LM", 40, 23, 11),
      slot("RS", "ST", 49, -6, 9),
      slot("LS", "ST", 49, 6, 10),
    ],
  },
  "4-3-3": {
    id: "4-3-3",
    slots: [
      ...BACK_FOUR,
      slot("DM", "DM", 37, 0, 6),
      slot("RCM", "CM", 41, -11, 10),
      slot("LCM", "CM", 41, 11, 8),
      slot("RW", "RW", 49, -24, 7),
      slot("ST", "ST", 50, 0, 9),
      slot("LW", "LW", 49, 24, 11),
    ],
  },
  "4-2-3-1": {
    id: "4-2-3-1",
    slots: [
      ...BACK_FOUR,
      slot("RDM", "DM", 35, -7, 8),
      slot("LDM", "DM", 35, 7, 6),
      slot("RW", "RW", 44, -22, 7),
      slot("AM", "AM", 44, 0, 10),
      slot("LW", "LW", 44, 22, 11),
      slot("ST", "ST", 50, 0, 9),
    ],
  },
};

export const DEFAULT_FORMATION: FormationId = "4-3-3";

export const isFormationId = (v: unknown): v is FormationId => (FORMATION_IDS as readonly unknown[]).includes(v);

export function formationSlot(formation: FormationId, slotId: string): FormationSlot | undefined {
  return FORMATIONS[formation].slots.find((s) => s.id === slotId);
}

/** Pitch coordinates of a slot's neutral spot for a team attacking in `attacksTowards`. */
export function slotSpot(s: Pick<FormationSlot, "depth" | "lateral">, attacksTowards: Team["attacksTowards"]): Vec2 {
  return attacksTowards === "increasing-x"
    ? { x: s.depth, y: PITCH_WIDTH / 2 - s.lateral }
    : { x: PITCH_LENGTH - s.depth, y: PITCH_WIDTH / 2 + s.lateral };
}

/** Copies `assignments` with keys in roster order, so equal assignments serialise identically. */
function ordered(squad: readonly Player[], assignments: SlotAssignments): SlotAssignments {
  const out: SlotAssignments = {};
  for (const p of squad) out[p.id] = assignments[p.id]!;
  return out;
}

/**
 * Default assignment: the roster goalkeeper in goal, then each outfield slot
 * takes the free player wearing its traditional shirt number; any slot left
 * over takes the remaining players in roster order.
 */
export function defaultAssignments(formation: FormationId, squad: readonly Player[]): SlotAssignments {
  const slots = FORMATIONS[formation].slots;
  const out: SlotAssignments = {};
  const free = new Set(squad);
  const keeper = squad.find((p) => p.role === "GK");
  if (keeper) {
    out[keeper.id] = "GK";
    free.delete(keeper);
  }
  const open: FormationSlot[] = [];
  for (const s of slots) {
    if (s.position === "GK") continue;
    const p = [...free].find((q) => q.number === s.shirt);
    if (p) {
      out[p.id] = s.id;
      free.delete(p);
    } else open.push(s);
  }
  for (const s of open) {
    const p = [...free][0];
    if (!p) break;
    out[p.id] = s.id;
    free.delete(p);
  }
  return ordered(squad, out);
}

/**
 * Default reassignment for a change of formation mid-match: players move to
 * the nearest free slot of the new formation (measured between neutral spots),
 * closest pairs first, so the team reshapes with as little running as
 * possible. Ties go to the earlier slot, then the earlier roster entry. The
 * goalkeeper stays in goal.
 */
export function remapAssignments(
  from: FormationId,
  previous: SlotAssignments,
  to: FormationId,
  squad: readonly Player[],
): SlotAssignments {
  const slots = FORMATIONS[to].slots;
  const out: SlotAssignments = {};
  const pairs: { d: number; si: number; pi: number }[] = [];
  squad.forEach((p, pi) => {
    const old = formationSlot(from, previous[p.id] ?? "");
    if (old?.position === "GK") {
      out[p.id] = "GK";
      return;
    }
    slots.forEach((s, si) => {
      if (s.position === "GK") return;
      const d = old ? Math.hypot(s.depth - old.depth, s.lateral - old.lateral) : Infinity;
      pairs.push({ d, si, pi });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.si - b.si || a.pi - b.pi);
  const taken = new Set<number>();
  for (const { si, pi } of pairs) {
    const p = squad[pi]!;
    if (out[p.id] !== undefined || taken.has(si)) continue;
    out[p.id] = slots[si]!.id;
    taken.add(si);
  }
  return ordered(squad, out);
}

/**
 * Problems with `assignments` for `squad` in `formation`: every player of the
 * team in exactly one slot, every slot filled once, no players from elsewhere,
 * and the roster goalkeeper in goal.
 */
export function assignmentErrors(
  formation: FormationId,
  assignments: SlotAssignments,
  squad: readonly Player[],
  allPlayers: readonly Player[],
): string[] {
  const errors: string[] = [];
  if (!assignments || typeof assignments !== "object") return ["assignments must be an object of player ID → slot ID"];
  const ids = new Set(squad.map((p) => p.id));
  const used = new Map<string, string>();
  for (const [playerId, slotId] of Object.entries(assignments)) {
    if (!ids.has(playerId)) {
      const other = allPlayers.find((p) => p.id === playerId);
      errors.push(other ? `player ${playerId} is not on this team` : `unknown player ${playerId}`);
      continue;
    }
    const s = formationSlot(formation, slotId);
    if (!s) {
      errors.push(`player ${playerId} has unknown ${formation} slot ${String(slotId)}`);
      continue;
    }
    if (used.has(slotId)) errors.push(`slot ${slotId} is assigned to both ${used.get(slotId)} and ${playerId}`);
    used.set(slotId, playerId);
    const keeper = squad.find((p) => p.id === playerId)!.role === "GK";
    if (keeper !== (s.position === "GK")) errors.push(`only the roster goalkeeper may fill the GK slot (${playerId} → ${slotId})`);
  }
  for (const p of squad) if (!(p.id in assignments)) errors.push(`player ${p.id} has no slot`);
  return errors;
}

/** FNV-1a, 32-bit, as 8 hex digits: a short, stable key for a configuration string. */
export function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
