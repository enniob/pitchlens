/**
 * "Explain this moment": removing rejected claims instead of discarding the
 * whole answer.
 *
 * When every problem found in a draft is about individual facts,
 * interpretation claims or limitations, those entries are removed and the
 * rest is kept. Removing a claim adds nothing to the answer, so this cannot
 * introduce unsupported text. It is refused, and the draft is revised or
 * falls back as before, when:
 *
 *   - any problem is about the headline, the explanation or the answer as a
 *     whole (length, fact count, status);
 *   - no fact would remain;
 *   - a number from a removed claim appears in the headline or explanation
 *     but in no kept claim, as the summary may repeat the rejected detail.
 *
 * The caller checks the pruned answer again before using it.
 */
import type { ExplanationResponse } from "./response";

const TARGET = /^(facts|interpretation|limitations)\[(\d+)\]/;
const NUMBER = /\d+(?:[.,]\d+)*/g;

export interface Pruned {
  response: ExplanationResponse;
  /** Targets removed, such as `facts[2]`. */
  removed: string[];
}

export function pruneRejectedClaims(response: ExplanationResponse, issues: string[]): Pruned | null {
  if (response.status !== "explained" || issues.length === 0) return null;
  const drop = { facts: new Set<number>(), interpretation: new Set<number>(), limitations: new Set<number>() };
  for (const issue of issues) {
    const m = issue.match(TARGET);
    if (!m) return null;
    drop[m[1] as keyof typeof drop].add(Number(m[2]));
  }
  const keep = <T>(list: T[], field: keyof typeof drop) => list.filter((_, i) => !drop[field].has(i));
  const pruned: ExplanationResponse = {
    ...response,
    facts: keep(response.facts, "facts"),
    interpretation: keep(response.interpretation, "interpretation"),
    limitations: keep(response.limitations, "limitations"),
  };
  if (pruned.facts.length === 0) return null;

  const numbers = (text: string) => new Set(text.match(NUMBER) ?? []);
  const kept = numbers([...pruned.facts, ...pruned.interpretation].map((c) => c.text).join(" "));
  const removedText = [
    ...response.facts.filter((_, i) => drop.facts.has(i)),
    ...response.interpretation.filter((_, i) => drop.interpretation.has(i)),
  ].map((c) => c.text).join(" ");
  const summary = numbers(`${response.headline} ${response.explanation}`);
  for (const n of numbers(removedText)) if (summary.has(n) && !kept.has(n)) return null;

  const removed = (["facts", "interpretation", "limitations"] as const)
    .flatMap((field) => [...drop[field]].sort((a, b) => a - b).map((i) => `${field}[${i}]`));
  return { response: pruned, removed };
}
