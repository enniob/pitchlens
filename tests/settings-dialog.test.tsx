// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplanationAccessGate, useExplanationAccess, useOpenAccessSettings } from "@/components/ExplanationAccessGate";
import { MatchViewer } from "@/components/MatchViewer";
import { sampleFixture } from "@/match/fixture";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (element: HTMLElement) => act(async () => { element.focus(); element.click(); });
const status = (authenticated = false, expiresAt?: number) => new Response(JSON.stringify({
  ok: true, required: true, available: true, authenticated, ...(expiresAt ? { expiresAt } : {}),
}));

describe("match panel tabs", () => {
  it("shows patterns only on Tactics while retaining the live announcements", async () => {
    function Viewer() {
      const [pro, setPro] = useState(false);
      return <MatchViewer fixture={sampleFixture} pro={pro} onTogglePro={() => setPro((value) => !value)} />;
    }
    await act(async () => root.render(<Viewer />));
    const patterns = () => container.querySelector('[aria-label="Measured match patterns"]');
    const moments = container.querySelector<HTMLElement>("#dock-panel-moments")!;
    const liveRegion = container.querySelector('.feed__list[aria-live="polite"]');
    expect(patterns()).toBeNull();
    expect(moments.hidden).toBe(false);
    await click(container.querySelector<HTMLElement>("#dock-tab-tactics")!);
    expect(patterns()).not.toBeNull();
    expect(moments.hidden).toBe(true);
    await click(container.querySelector<HTMLElement>("#dock-tab-moments")!);
    expect(patterns()).toBeNull();
    expect(moments.hidden).toBe(false);
    expect(container.querySelector('.feed__list[aria-live="polite"]')).toBe(liveRegion);
  });
});

describe("header settings dialogs", () => {
  it("edits favorites in a modal and preserves them after closing and reopening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(status()));
    await act(async () => root.render(<ExplanationAccessGate><MatchViewer fixture={sampleFixture} /></ExplanationAccessGate>));
    const preferences = button("Preferences");
    const favoriteSection = container.querySelector<HTMLElement>('[aria-label="Favorite team and player"]')!;
    expect(favoriteSection.closest("[hidden]")).not.toBeNull();
    expect(container.querySelector('.dock [aria-label="Favorite team and player"]')).toBeNull();
    await click(preferences);
    expect(favoriteSection.closest("[hidden]")).toBeNull();
    const [team, player] = [...favoriteSection.querySelectorAll("select")];
    const favorite = sampleFixture.roster[0]!;
    await act(async () => { team!.value = favorite.teamId; team!.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { player!.value = favorite.id; player!.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => favoriteSection.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(preferences);
    expect(favoriteSection.closest("[hidden]")).not.toBeNull();
    await click(preferences);
    expect(team!.value).toBe(favorite.teamId);
    expect(player!.value).toBe(favorite.id);
    const dialog = favoriteSection.closest('[role="dialog"]')!;
    const controls = dialog.querySelectorAll("button");
    const done = controls[controls.length - 1]!;
    done.focus();
    await act(async () => done.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(button("Close preferences"));
  });

  it("opens access from the header and clears an unsubmitted code on close", async () => {
    const fetcher = vi.fn().mockResolvedValue(status());
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(<ExplanationAccessGate><MatchViewer fixture={sampleFixture} /></ExplanationAccessGate>));
    const access = container.querySelector<HTMLElement>('[aria-label="AI explanation access"]')!;
    expect(access.closest("[hidden]")).not.toBeNull();
    await click(button("AI access"));
    expect(access.closest("[hidden]")).toBeNull();
    const input = access.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unsubmitted-code");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Close ai access"));
    await click(button("AI access"));
    expect(input.value).toBe("");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("expires access while its dialog is closed without losing the session monitor", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(status(true, Date.now() + 1000)).mockImplementation(async () => status());
    vi.stubGlobal("fetch", fetcher);
    function Probe() {
      const allowed = useExplanationAccess();
      const open = useOpenAccessSettings();
      return <button aria-label="Open access" data-allowed={allowed} onClick={open}>Open</button>;
    }
    await act(async () => root.render(<ExplanationAccessGate><Probe /></ExplanationAccessGate>));
    expect(button("Open access").dataset.allowed).toBe("true");
    await click(button("Open access"));
    await click(button("Close ai access"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(button("Open access").dataset.allowed).toBe("false");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
