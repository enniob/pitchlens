/** Lexical time parsing shared by grounding and evaluation; never split a grouped number. */
export const WRITTEN_TIME = /(?<![#\d.,])(\d+(?:,\d+)*(?:\.(\d+))?)\s*(ms|s|secs?|seconds?)\b/gi;

export function writtenTimeMs(m: RegExpMatchArray): number {
  // Reject malformed grouping rather than silently reading a smaller suffix.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(m[1]!)) return NaN;
  return Number(m[1]!.replaceAll(",", "")) * (m[3]!.toLowerCase() === "ms" ? 1 : 1000);
}

/** Explicit "at" takes precedence over an adjacent "after" clause. */
export function isElapsedTime(text: string, m: RegExpMatchArray): boolean {
  const prefix = text.slice(Math.max(0, m.index! - 60), m.index).toLowerCase();
  const suffix = text.slice(m.index! + m[0].length, m.index! + m[0].length + 15).toLowerCase();
  return !/\bat\s+$/.test(prefix) && (/(?:took|takes|lasted|lasting|within|over|in|for|after|last|previous|duration(?: of)?|elapsed(?: time)?|approximately|about|roughly)\s+(?:(?:approximately|about|roughly|only|just)\s+)?$/.test(prefix) || /^\s+(?:later|earlier|apart|elapsed|after|before)\b/.test(suffix));
}
