/** Formats simulation milliseconds as m:ss.t */
export function formatClock(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/** formatClock without the tenths (m:ss), for compact labels. */
export function shortClock(ms: number): string {
  return formatClock(ms).replace(/\.\d$/, "");
}
