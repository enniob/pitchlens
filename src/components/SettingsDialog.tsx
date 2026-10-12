"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import styles from "./SettingsDialog.module.css";

/** Children stay mounted so closing settings never stops session monitoring. */
export function SettingsDialog({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    heading.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    if (event.key !== "Tab") return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']");
    const first = controls?.[0];
    const last = controls?.[controls.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (active === last || active === heading.current)) {
      event.preventDefault(); first.focus();
    }
  }

  return <div className={styles.scrim} hidden={!open} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.dialog} ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        <h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>
        <button type="button" className="btn btn--ghost btn--icon" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className={styles.body}>{children}</div>
      <div className={styles.footer}><button type="button" className="btn btn--accent" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}
