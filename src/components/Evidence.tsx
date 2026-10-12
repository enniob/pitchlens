import type { MatchFixture } from "@/match/contract";
import type { Claim, EvidenceRef, ExplanationResponse } from "@/explain/response";
import { eventCopy } from "./eventCopy";
import { formatClock } from "./format";
import { Icon } from "./Icon";
import { MiniPitch } from "./MiniPitch";

export interface Citation {
  key: string;
  t: number;
  /** "Goal!", "Pass", "Positions"… */
  what: string;
  kind: "event" | "positions";
  ref: EvidenceRef;
}

/** What a citation points at. Citations were validated against the fixture before display, so lookups succeed. */
export function citationOf(fixture: MatchFixture, ref: EvidenceRef): Citation {
  if (ref.kind === "snapshot") return { key: `s${ref.t}`, t: ref.t, what: "Positions", kind: "positions", ref };
  const event = fixture.events.find((e) => e.id === ref.id)!;
  return { key: `e${ref.id}`, t: event.t, what: eventCopy(event).title, kind: "event", ref };
}

/** Every distinct piece of evidence an explanation cites, in time order. */
export function citedEvidence(fixture: MatchFixture, explanation: ExplanationResponse): Citation[] {
  const seen = new Map<string, Citation>();
  for (const claim of [...explanation.facts, ...explanation.interpretation])
    for (const ref of claim.evidence) {
      const c = citationOf(fixture, ref);
      if (!seen.has(c.key)) seen.set(c.key, c);
    }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

const replayName = (c: Citation) => `Replay ${c.kind} at ${formatClock(c.t)}`;

/** "See the evidence": a card per cited event or snapshot, each with a positions drawing and Replay. */
export function EvidenceCards({ fixture, items, onReplay }: { fixture: MatchFixture; items: Citation[]; onReplay: (t: number) => void }) {
  if (!items.length) return null;
  return (
    <ul className="evidence">
      {items.map((c) => {
        const event = c.ref.kind === "event" ? fixture.events.find((e) => e.id === (c.ref as { id: string }).id) : undefined;
        return (
          <li key={c.key} className="evidence__card">
            <MiniPitch fixture={fixture} timeMs={c.t} highlight={event} className="evidence__pitch" />
            <div className="evidence__body">
              <time>{formatClock(c.t)}</time>
              <span className="evidence__what">{c.what}</span>
              <button type="button" className="evidence__replay" aria-label={replayName(c)} title={replayName(c)} onClick={() => onReplay(c.t)}>
                <Icon name="play" size={14} />
                Replay
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Facts or interpretation, each claim with compact citation chips. */
export function ClaimList({ title, kind, items, fixture, onReplay }:
  { title: string; kind: "fact" | "reading"; items: Claim[]; fixture: MatchFixture; onReplay: (t: number) => void }) {
  if (!items.length) return null;
  return (
    <div className={`claims claims--${kind}`}>
      <h5>{title}</h5>
      <ul>
        {items.map((claim, i) => (
          <li key={i}>
            <p>{claim.text}</p>
            <div className="claims__cites">
              {claim.evidence.map((ref, j) => {
                const c = citationOf(fixture, ref);
                return (
                  <button className="cite" type="button" key={j} aria-label={replayName(c)} title={replayName(c)} onClick={() => onReplay(c.t)}>
                    <Icon name="play" size={12} />
                    {c.what} <time>{formatClock(c.t)}</time>
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Facts, interpretation and limits, kept apart so readings are never shown as facts. */
export function ExplanationDetails({ explanation, fixture, onReplay }: { explanation: ExplanationResponse; fixture: MatchFixture; onReplay: (t: number) => void }) {
  return (
    <>
      <ClaimList title="Observable facts" kind="fact" items={explanation.facts} fixture={fixture} onReplay={onReplay} />
      <ClaimList title="Tactical interpretation" kind="reading" items={explanation.interpretation} fixture={fixture} onReplay={onReplay} />
      {!!explanation.limitations.length && (
        <div className="limits">
          <h5>
            <Icon name="info" size={16} />
            Limits of the evidence
          </h5>
          <ul>
            {explanation.limitations.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
