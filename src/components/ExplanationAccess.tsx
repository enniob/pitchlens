"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./ExplanationAccess.module.css";

/** Fired on `window` whenever this browser's AI explanation access may have changed. */
export const ACCESS_CHANGED_EVENT = "pitchlens-access-changed";
const SESSION_URL = "/api/session";
// setTimeout overflows above this delay and would fire immediately.
const MAX_TIMER_MS = 2_147_483_647;

type AccessStatus = { required: boolean; authenticated: boolean; available: boolean; expiresAt?: number };
type Phase = "loading" | "ready" | "failed";

function parseStatus(body: unknown): AccessStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true || typeof b.required !== "boolean" || typeof b.authenticated !== "boolean" || typeof b.available !== "boolean") return null;
  const expiresAt = typeof b.expiresAt === "number" && Number.isFinite(b.expiresAt) ? b.expiresAt : undefined;
  return { required: b.required, authenticated: b.authenticated, available: b.available, expiresAt };
}

const announce = () => window.dispatchEvent(new Event(ACCESS_CHANGED_EVENT));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Fixed copy only: server error bodies are never shown to the viewer. */
function unlockFailure(status: number) {
  if (status === 401 || status === 403) return "That access code was not accepted.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  return "AI explanations could not be unlocked right now.";
}

/**
 * Lets a viewer unlock AI explanations with a shared access code. The code
 * lives only in component state and is sent once to the session endpoint,
 * which answers with an HTTP-only cookie; playback never waits on this.
 * `onAccessChange` hears whether explanations may be requested: only once a
 * status check says this browser is signed in and the service is available.
 */
export function ExplanationAccess({ onAccessChange, open }: { onAccessChange?: (allowed: boolean) => void; open?: boolean } = {}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [code, setCode] = useState("");
  useEffect(() => { if (open === false) setCode(""); }, [open]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  // Set on expiry or locking, so listeners stop at once rather than after the next status check, which clears it.
  const [revoked, setRevoked] = useState(false);
  const notify = useRef(onAccessChange);
  notify.current = onAccessChange;

  const allowed = phase === "ready" && status !== null && status.authenticated && status.available && !revoked;
  useEffect(() => { notify.current?.(allowed); }, [allowed]);

  const refresh = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    const mine = ++generation.current;
    try {
      const res = await fetch(SESSION_URL, { method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const next = res.ok ? parseStatus(await res.json().catch(() => null)) : null;
      if (mine !== generation.current) return;
      setStatus(next);
      setRevoked(false);
      setPhase(next ? "ready" : "failed");
    } catch (e) {
      if (isAbort(e) || mine !== generation.current) return;
      setStatus(null);
      setRevoked(false);
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      statusRequest.current?.abort();
      mutation.current?.abort();
    };
  }, [refresh]);

  // When the session lapses, re-read it so the UI and listeners stop assuming access.
  const expiresAt = status?.authenticated ? status.expiresAt : undefined;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setTimeout(() => {
      setRevoked(true);
      announce();
      void refresh();
    }, Math.min(MAX_TIMER_MS, Math.max(0, expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [expiresAt, refresh]);

  async function change(init: RequestInit, onFailure: (status: number) => string) {
    mutation.current?.abort();
    statusRequest.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    const mine = ++generation.current;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(SESSION_URL, { ...init, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (mine !== generation.current) return false;
      if (!res.ok) {
        setMessage(onFailure(res.status));
        return false;
      }
      announce();
      return true;
    } catch (e) {
      if (!isAbort(e) && mine === generation.current) setMessage(onFailure(0));
      return false;
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }

  async function unlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!code || busy) return;
    const ok = await change({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) }, unlockFailure);
    if (!ok) return;
    setCode("");
    await refresh();
  }

  async function lock() {
    if (busy) return;
    setRevoked(true);
    if (await change({ method: "DELETE" }, () => "AI explanations could not be locked right now.")) await refresh();
    else setRevoked(false);
  }

  if (phase === "loading") {
    return <section className={styles.access} aria-label="AI explanation access" aria-busy="true">
      <p role="status">Checking AI explanation access…</p>
    </section>;
  }
  if (phase === "failed" || !status) {
    return <section className={styles.access} aria-label="AI explanation access">
      <p role="status">AI explanation access could not be checked. Match playback is still available.</p>
      <button type="button" className={styles.secondary} onClick={() => { setPhase("loading"); void refresh(); }}>Try again</button>
    </section>;
  }
  if (!status.available) {
    return <section className={styles.access} aria-label="AI explanation access">
      <p role="status">AI explanations are unavailable right now. Match playback is still available.</p>
    </section>;
  }
  if (!status.required) return null;
  if (status.authenticated) {
    return <section className={styles.access} aria-label="AI explanation access">
      <p role="status" className={styles.unlocked}>AI explanations unlocked</p>
      <button type="button" className={styles.secondary} onClick={lock} disabled={busy}>Lock AI explanations</button>
      {message && <p role="alert" className={styles.error}>{message}</p>}
    </section>;
  }
  return <section className={styles.access} aria-label="AI explanation access">
    <form className={styles.form} onSubmit={unlock}>
      <label htmlFor="pitchlens-access-code">Access code</label>
      <input id="pitchlens-access-code" type="password" name="code" autoComplete="off" spellCheck={false} required
        value={code} onChange={(e) => setCode(e.target.value)} disabled={busy}
        aria-invalid={message ? true : undefined} aria-describedby={message ? "pitchlens-access-error" : undefined} />
      <button type="submit" className={styles.primary} disabled={busy || !code}>Unlock AI explanations</button>
    </form>
    {message && <p id="pitchlens-access-error" role="alert" className={styles.error}>{message}</p>}
  </section>;
}
