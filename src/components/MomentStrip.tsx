import { useEffect, useRef } from "react";
import type { MatchEvent, MatchFixture } from "@/match/contract";
import { isKeyEvent } from "@/playback/moments";
import { eventCopy, plainDescription } from "./eventCopy";
import { shortClock } from "./format";
import { Icon } from "./Icon";
import { MiniPitch } from "./MiniPitch";

interface Props {
  fixture: MatchFixture;
  /** Strip moments reached so far, oldest first (see stripMoments). */
  moments: MatchEvent[];
  selectedId: string | null;
  onSelect: (event: MatchEvent) => void;
}

/** Routine restarts would crowd the strip and the timeline. */
const ROUTINE: readonly MatchEvent["type"][] = ["throw-in", "goal-kick"];

/**
 * A moment worth a card and a timeline marker: key moments (not shot results,
 * which the shot card covers) plus balls won, which start most attacks;
 * routine restarts are left out.
 */
export function isStripMoment(e: MatchEvent): boolean {
  return (e.type === "turnover" || (isKeyEvent(e) && e.type !== "shot-result")) && !ROUTINE.includes(e.type);
}

/** The strip moments among events already reached; callers pass only reached events. */
export function stripMoments(reached: readonly MatchEvent[]): MatchEvent[] {
  return reached.filter(isStripMoment);
}

/** The latest strip moment strictly before t, or null: where "Previous moment" goes. */
export function previousStripMoment(fixture: MatchFixture, t: number): MatchEvent | null {
  let found: MatchEvent | null = null;
  for (const e of fixture.events) {
    if (e.t >= t) break;
    if (isStripMoment(e)) found = e;
  }
  return found;
}

/**
 * The first strip moment strictly after t, or null: where "Next moment" goes.
 * Only its time is used to seek, and nothing about it is shown until reached.
 */
export function nextStripMoment(fixture: MatchFixture, t: number): MatchEvent | null {
  return fixture.events.find((e) => e.t > t && isStripMoment(e)) ?? null;
}

/** Matches .strip__list's padding and scroll-padding. */
const EDGE = 4;

/**
 * Scrolls the list just enough to show the whole item, always resting on a
 * card's start (the snap positions), so no card is left half-hidden at the
 * left edge.
 */
function reveal(list: HTMLElement, item: HTMLElement) {
  const items = Array.from(list.children) as HTMLElement[];
  const viewLeft = list.scrollLeft;
  const itemRight = item.offsetLeft + item.offsetWidth;
  let left = viewLeft;
  if (item.offsetLeft - EDGE < viewLeft) left = item.offsetLeft - EDGE;
  else if (itemRight + EDGE > viewLeft + list.clientWidth) {
    // The first card start from which the item fits entirely.
    const first = items.find((li) => li.offsetLeft - EDGE >= itemRight + EDGE - list.clientWidth) ?? item;
    left = first.offsetLeft - EDGE;
  }
  if (left !== viewLeft) list.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
}

/** A scrollable row of cards for the moments reached so far, under the playback bar. */
export function MomentStrip({ fixture, moments: shown, selectedId, onSelect }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const count = shown.length;

  // Follow the newest moment as play reaches it, or bring the selected one into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = selectedId ? list.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`)?.parentElement : list.lastElementChild;
    if (target instanceof HTMLElement) reveal(list, target);
  }, [count, selectedId]);

  const page = (direction: -1 | 1) => {
    const list = listRef.current;
    if (list) list.scrollBy({ left: direction * list.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section className="strip" aria-label="Key moments so far">
      <button type="button" className="strip__nav" aria-label="Earlier moments" onClick={() => page(-1)} disabled={count === 0}>
        <Icon name="chevron" size={20} className="strip__prev" />
      </button>
      {count === 0 ? (
        <p className="strip__empty">Key moments appear here as they happen.</p>
      ) : (
        <ol className="strip__list" ref={listRef}>
          {shown.map((e) => {
            const copy = eventCopy(e);
            const selected = e.id === selectedId;
            return (
              <li key={e.id}>
                <button
                  type="button"
                  data-id={e.id}
                  className={`strip__card strip__card--${copy.tone}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(e)}
                >
                  <span className="strip__icon"><Icon name={copy.icon} size={22} /></span>
                  <span className="strip__text">
                    <time>{shortClock(e.t)}</time>
                    <span className="strip__title">{copy.title}</span>
                    <span className="strip__desc">{plainDescription(e)}</span>
                  </span>
                  <MiniPitch fixture={fixture} timeMs={e.t} highlight={e} className="strip__pitch" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <button type="button" className="strip__nav" aria-label="Later moments" onClick={() => page(1)} disabled={count === 0}>
        <Icon name="chevron" size={20} className="strip__next" />
      </button>
    </section>
  );
}
