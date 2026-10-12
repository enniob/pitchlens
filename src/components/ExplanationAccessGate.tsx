"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { ExplanationAccess } from "./ExplanationAccess";
import { SettingsDialog } from "./SettingsDialog";

/**
 * Whether this viewer may ask for AI explanations right now. Defaults to true
 * so components rendered on their own (tests, previews) behave as before; the
 * app's gate starts locked until the session endpoint says otherwise. This is
 * a UI convenience only: the explanation endpoint enforces access itself.
 */
export const ExplanationAccessContext = createContext(true);

export const useExplanationAccess = () => useContext(ExplanationAccessContext);
const AccessSettingsContext = createContext<(() => void) | undefined>(undefined);
export const useOpenAccessSettings = () => useContext(AccessSettingsContext);

/** Shown wherever an AI request is unavailable because access is locked. */
export const LOCKED_HINT = "Open AI access in the header to unlock explanations. Match playback works without it.";

/** One session monitor for the whole page, with its controls in a header-opened dialog. */
export function ExplanationAccessGate({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <ExplanationAccessContext.Provider value={allowed}>
      <AccessSettingsContext.Provider value={() => setOpen(true)}>
        <SettingsDialog open={open} title="AI access" onClose={() => setOpen(false)}>
          <ExplanationAccess onAccessChange={setAllowed} open={open} />
        </SettingsDialog>
        {children}
      </AccessSettingsContext.Provider>
    </ExplanationAccessContext.Provider>
  );
}
