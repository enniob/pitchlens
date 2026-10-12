"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { ExplanationAccess } from "./ExplanationAccess";

/**
 * Whether this viewer may ask for AI explanations right now. Defaults to true
 * so components rendered on their own (tests, previews) behave as before; the
 * app's gate starts locked until the session endpoint says otherwise. This is
 * a UI convenience only: the explanation endpoint enforces access itself.
 */
export const ExplanationAccessContext = createContext(true);

export const useExplanationAccess = () => useContext(ExplanationAccessContext);

/** Shown wherever an AI request is unavailable because access is locked. */
export const LOCKED_HINT = "Unlock AI explanations with the access code above. Match playback works without it.";

/** The access bar plus everything that may ask for explanations, sharing one session check. */
export function ExplanationAccessGate({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState(false);
  return (
    <ExplanationAccessContext.Provider value={allowed}>
      <ExplanationAccess onAccessChange={setAllowed} />
      {children}
    </ExplanationAccessContext.Provider>
  );
}
