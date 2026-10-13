/**
 * Paired assessment of the Casual Fan and Analyst answers for one moment.
 *
 * `assess` judges each answer alone. Both audiences are given the same
 * evidence, so this compares them, on three separate levels:
 *
 *   1. consistency: the two answers must not disagree about the match. One
 *      explained and the other not, different scores, or different times for
 *      the same cited event. Deterministic; a conflict means at least one
 *      answer is wrong.
 *   2. casual readability: long sentences, analyst jargon, raw coordinates,
 *      units or event IDs, and too many numbers in the Casual Fan text.
 *   3. analyst detail: an Analyst answer that adds nothing to the Casual Fan
 *      one, cites less evidence, or states no time, measurement or player.
 *
 * Levels 2 and 3 are wording heuristics that flag answers for a human to
 * read. Passing them does not show an answer is clear or useful.
 */
import type { ExplanationResponse } from "@/explain/response";

export interface AudienceAssessment {
  /** The two answers disagree about the match. */
  conflicts: string[];
  /** The Casual Fan answer may be hard to read. */
  readability: string[];
  /** The Analyst answer may lack useful detail. */
  detail: string[];
}

/** Readability bounds for the Casual Fan text. */
export const CASUAL_READABILITY = { averageWords: 22, longestWords: 35, headlineWords: 12, numbers: 4 } as const;

const JARGON =
  /\b(half[ -]?spaces?|progressive|xT|xG|low block|mid block|high block|rest defen[cs]e|overloads?|underlap\w*|between the lines|line[ -]breaking|vertical(ity)?|transition(al)? phase|pressing trigger|compactness|third man)\b/i;
const RAW = [
  { label: "raw coordinates", pattern: /\b[xy]\s?=\s?-?\d/i },
  { label: "a speed unit", pattern: /\bm\/s\b/i },
  { label: "milliseconds", pattern: /\d\s?ms\b/i },
  { label: "an event ID", pattern: /\be\d+-[a-z]+\b|\bev-\d+/i },
  { label: "a snapshot reference", pattern: /\bsnapshots?\b/i },
] as const;
const SCORE = /(?<![\d.\-–#])(\d{1,2})\s?[–-]\s?(\d{1,2})(?![\d\-–])/g;
const TIME = /(?<![#\d.])(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/gi;
const PRECISE = /(?<![#\w])\d+(\.\d+)?\s*(s|secs?|seconds?|m|metres?|meters?|%|m\/s)\b|#\d+/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const words = (text: string) => text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
const shown = (r: ExplanationResponse) => [r.headline, r.explanation, ...r.facts.map((c) => c.text), ...r.interpretation.map((c) => c.text)];
/** The highest-scoring scoreline an answer states, without team order: "0–1" and "1–0" agree. */
const latestScore = (r: ExplanationResponse): string | undefined =>
  shown(r)
    .flatMap((t) => [...t.matchAll(SCORE)].map((m) => [Number(m[1]), Number(m[2])].sort((a, b) => a - b)))
    .sort((a, b) => b[0]! + b[1]! - a[0]! - a[1]!)[0]?.join("–");
const refs = (r: ExplanationResponse) =>
  new Set([...r.facts, ...r.interpretation].flatMap((c) => c.evidence.map((e) => (e.kind === "event" ? e.id : `snapshot@${e.t}`))));

/** Seconds stated in claims citing exactly one event, by that event. */
function eventTimes(r: ExplanationResponse): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of [...r.facts, ...r.interpretation]) {
    const events = c.evidence.filter((e) => e.kind === "event");
    if (events.length !== 1 || c.evidence.length !== 1) continue;
    // Durations are not timestamps: "took 6.4 s", "6.4 s later".
    const times = [...c.text.matchAll(TIME)].filter((m) => {
      const before = c.text.slice(0, m.index).toLowerCase();
      const after = c.text.slice(m.index! + m[0].length).toLowerCase();
      return !/(took|takes|lasted|lasting|within|over|in|for|after|last|previous|about|roughly|approximately)\s+$/.test(before) && !/^\s+(later|earlier|apart|after|before)\b/.test(after);
    });
    if (times.length !== 1) continue;
    const id = (events[0] as { id: string }).id;
    out.set(id, [...(out.get(id) ?? []), Number(times[0]![1])]);
  }
  return out;
}

export function assessAudiences(casual: ExplanationResponse, analyst: ExplanationResponse): AudienceAssessment {
  const conflicts: string[] = [];
  const readability: string[] = [];
  const detail: string[] = [];

  if (casual.status !== analyst.status) conflicts.push(`the Casual Fan answer is ${casual.status} but the Analyst answer is ${analyst.status}`);
  // Earlier scores may be mentioned by one answer only; the latest score each states must agree.
  const [cs, as] = [latestScore(casual), latestScore(analyst)];
  if (cs && as && cs !== as) conflicts.push(`the answers state different latest scores (${cs} vs ${as})`);
  const [ct, at] = [eventTimes(casual), eventTimes(analyst)];
  for (const [id, times] of ct) {
    const other = at.get(id);
    // Each audience may round differently; disagreement beyond a second is a conflict.
    if (other && !times.some((t) => other.some((u) => Math.abs(t - u) <= 1)))
      conflicts.push(`the answers give different times for ${id} (${times.join(", ")} s vs ${other.join(", ")} s)`);
  }

  if (casual.status === "explained") {
    const prose = [casual.headline, casual.explanation].join(" ");
    const all = shown(casual).join(" ");
    const lengths = sentences(casual.explanation).map((s) => words(s).length);
    if (lengths.length > 0) {
      const average = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      if (average > CASUAL_READABILITY.averageWords) readability.push(`explanation sentences average ${average.toFixed(1)} words`);
      if (Math.max(...lengths) > CASUAL_READABILITY.longestWords) readability.push(`an explanation sentence has ${Math.max(...lengths)} words`);
    }
    if (words(casual.headline).length > CASUAL_READABILITY.headlineWords) readability.push(`headline has ${words(casual.headline).length} words`);
    const jargon = all.match(JARGON);
    if (jargon) readability.push(`uses analyst jargon ("${jargon[0]}")`);
    for (const r of RAW) if (r.pattern.test(all)) readability.push(`shows ${r.label}`);
    // A formation ("4-2-3-1") or a score ("1–0") reads as one number.
    const numbers = prose.replace(/\d(?:\s?[–-]\s?\d+)+/g, "").match(/\d+(\.\d+)?|/g)?.length ?? 0;
    if (numbers > CASUAL_READABILITY.numbers) readability.push(`headline and explanation contain ${numbers} numbers`);
  }

  if (analyst.status === "explained") {
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    if (casual.status === "explained" && same(casual.explanation, analyst.explanation) && same(casual.headline, analyst.headline))
      detail.push("the Analyst answer repeats the Casual Fan headline and explanation");
    if (casual.status === "explained" && refs(analyst).size < refs(casual).size)
      detail.push(`the Analyst answer cites less evidence (${refs(analyst).size} vs ${refs(casual).size} references)`);
    if (!analyst.facts.some((f) => PRECISE.test(f.text))) detail.push("no Analyst fact states a time, distance, measurement or shirt number");
  }
  return { conflicts, readability, detail };
}
