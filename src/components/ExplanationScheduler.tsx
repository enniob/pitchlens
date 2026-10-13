"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ExplanationScheduler } from "@/explain/scheduler";

const ExplanationSchedulerContext = createContext<ExplanationScheduler | null>(null);

/**
 * The scheduler shared by every explanation request in this part of the page.
 * Reuses one from further up (the match viewer's), so the insight feed, the
 * panel and the recap take turns; rendered on its own it makes its own.
 * Waiting requests are dropped when the scope that made it goes away.
 */
export function ExplanationSchedulerScope({ children }: { children: ReactNode }) {
  const parent = useContext(ExplanationSchedulerContext);
  const [own] = useState(() => (parent ? null : new ExplanationScheduler()));
  useEffect(() => () => { own?.cancelQueued(); }, [own]);
  if (parent) return <>{children}</>;
  return <ExplanationSchedulerContext.Provider value={own}>{children}</ExplanationSchedulerContext.Provider>;
}

export function useExplanationScheduler(): ExplanationScheduler {
  const scheduler = useContext(ExplanationSchedulerContext);
  if (!scheduler) throw new Error("useExplanationScheduler must be used inside an ExplanationSchedulerScope.");
  return scheduler;
}
