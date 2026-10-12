// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_CHANGED_EVENT, ExplanationAccess } from "@/components/ExplanationAccess";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let changes: number;
const countChange = () => { changes++; };

type Status = { required: boolean; authenticated: boolean; available: boolean; expiresAt?: number };
const locked: Status = { required: true, authenticated: false, available: true };
const unlocked: Status = { required: true, authenticated: true, available: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const statusResponse = (s: Status) => json({ ok: true, ...s });

/** A fake session endpoint: GET returns the current status, POST accepts `secret-code`, DELETE locks. */
function sessionServer(initial: Status, post: (code: string) => Response | Promise<Response> = (code) =>
  code === "secret-code" ? json({ ok: true }) : json({ ok: false, error: "internal: hash mismatch for code secret-code" }, 401)) {
  let current = initial;
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(url).toBe("/api/session");
    expect(init?.credentials).toBe("same-origin");
    const method = init?.method ?? "GET";
    if (method === "GET") return statusResponse(current);
    if (method === "POST") {
      const res = await post((JSON.parse(String(init?.body)) as { code: string }).code);
      if (res.ok) current = { ...current, authenticated: true };
      return res;
    }
    if (method === "DELETE") { current = { ...current, authenticated: false }; return json({ ok: true }); }
    throw new Error(`Unexpected ${method}`);
  });
}

const render = () => act(async () => { root.render(<ExplanationAccess />); });
const text = () => container.textContent ?? "";
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
function codeInput() {
  const label = [...container.querySelectorAll("label")].find((l) => l.textContent === "Access code");
  if (!label) throw new Error("Missing Access code label");
  return container.querySelector<HTMLInputElement>(`#${label.htmlFor}`)!;
}
async function type(value: string) {
  const input = codeInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const submit = () => act(async () => { button("Unlock AI explanations").click(); });

beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  changes = 0; window.addEventListener(ACCESS_CHANGED_EVENT, countChange);
  localStorage.clear(); sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  window.removeEventListener(ACCESS_CHANGED_EVENT, countChange);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("AI explanation access", () => {
  it("shows a loading state until the session status arrives", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(new Promise((r) => { answer = r; })));
    await render();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(text()).toContain("Checking AI explanation access");
    await act(async () => answer(statusResponse(locked)));
    expect(text()).not.toContain("Checking");
    expect(codeInput().type).toBe("password");
  });

  it("asks for an access code with an accessible, labelled password field", async () => {
    vi.stubGlobal("fetch", sessionServer(locked));
    await render();
    const input = codeInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(button("Unlock AI explanations").type).toBe("submit");
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("AI explanation access");
  });

  it("unlocks with the exact code, clears it, announces the change, and keeps it out of browser storage", async () => {
    const fetchMock = sessionServer(locked);
    vi.stubGlobal("fetch", fetchMock);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await render();
    await type("secret-code");
    await submit();
    await settle();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[1]?.body).toBe(JSON.stringify({ code: "secret-code" }));
    expect(new Headers(post[1]?.headers).get("Content-Type")).toBe("application/json");
    expect(text()).toContain("AI explanations unlocked");
    expect(container.querySelector("input")).toBeNull();
    expect(changes).toBe(1);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain("secret-code");
    expect(container.innerHTML).not.toContain("secret-code");
    setItem.mockRestore();
  });

  it("rejects a wrong code with fixed copy, never the raw server error body", async () => {
    vi.stubGlobal("fetch", sessionServer(locked));
    await render();
    await type("wrong");
    await submit();
    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toBe("That access code was not accepted.");
    expect(text()).not.toContain("hash mismatch");
    expect(text()).not.toContain("internal");
    expect(codeInput().getAttribute("aria-invalid")).toBe("true");
    expect(codeInput().getAttribute("aria-describedby")).toBe(alert?.id);
    expect(changes).toBe(0);
  });

  it("uses generic copy for rate limits and network failures", async () => {
    let next: () => Promise<Response> = async () => json({ error: "slow down <script>" }, 429);
    vi.stubGlobal("fetch", sessionServer(locked, () => next()));
    await render();
    await type("anything");
    await submit();
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Too many attempts. Wait a moment and try again.");
    next = async () => { throw new TypeError("Failed to fetch: secret upstream detail"); };
    await submit();
    expect(container.querySelector("[role='alert']")?.textContent).toBe("AI explanations could not be unlocked right now.");
    expect(text()).not.toContain("upstream");
  });

  it("says explanations are unavailable while playback stays usable", async () => {
    vi.stubGlobal("fetch", sessionServer({ required: true, authenticated: false, available: false }));
    await render();
    expect(text()).toContain("AI explanations are unavailable right now. Match playback is still available.");
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders nothing when no access code is required", async () => {
    vi.stubGlobal("fetch", sessionServer({ required: false, authenticated: false, available: true }));
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("locks an unlocked session with DELETE and announces the change", async () => {
    const fetchMock = sessionServer(unlocked);
    vi.stubGlobal("fetch", fetchMock);
    await render();
    expect(text()).toContain("AI explanations unlocked");
    await act(async () => { button("Lock AI explanations").click(); });
    await settle();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    expect(changes).toBe(1);
    expect(codeInput()).toBeTruthy();
  });

  it("refetches status and announces when the session expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetchMock = sessionServer({ ...unlocked, expiresAt: Date.now() + 60_000 });
    vi.stubGlobal("fetch", fetchMock);
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(changes).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a retryable failure for malformed status without leaking the body", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "database password=hunter2" }, 500))
      .mockResolvedValueOnce(statusResponse(locked));
    vi.stubGlobal("fetch", fetchMock);
    await render();
    expect(text()).toContain("could not be checked");
    expect(text()).not.toContain("hunter2");
    await act(async () => { button("Try again").click(); });
    expect(codeInput()).toBeTruthy();
  });

  it("aborts the in-flight status request on unmount and ignores its late answer", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_u, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    root = createRoot(container);
  });

  it("ignores a stale status response that resolves after the viewer locks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const gets: { resolve: (r: Response) => void; signal?: AbortSignal | null }[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_u, init) => {
      if (init?.method === "DELETE") return Promise.resolve(json({ ok: true }));
      return new Promise((resolve) => { gets.push({ resolve, signal: init?.signal }); });
    }));
    await render();
    await act(async () => gets[0]!.resolve(statusResponse({ ...unlocked, expiresAt: Date.now() + 1_000 })));
    // Expiry starts a status refresh that is still in flight when the viewer locks.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(gets).toHaveLength(2);
    await act(async () => { button("Lock AI explanations").click(); });
    expect(gets[1]!.signal?.aborted).toBe(true);
    expect(gets).toHaveLength(3);
    await act(async () => gets[2]!.resolve(statusResponse(locked)));
    // The superseded refresh answers late with the old unlocked state; it must not win.
    await act(async () => gets[1]!.resolve(statusResponse(unlocked)));
    expect(text()).not.toContain("AI explanations unlocked");
    expect(codeInput()).toBeTruthy();
  });
});

describe("access change callback", () => {
  const renderWith = (onAccessChange: (allowed: boolean) => void) =>
    act(async () => { root.render(<ExplanationAccess onAccessChange={onAccessChange} />); });
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

  it("reports locked while checking and for locked, unavailable or failed status", async () => {
    for (const reply of [statusResponse(locked), statusResponse({ ...unlocked, available: false }), json({}, 500)]) {
      const onAccess = vi.fn();
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply));
      await renderWith(onAccess);
      await settle();
      expect(onAccess).toHaveBeenCalledWith(false);
      expect(onAccess).not.toHaveBeenCalledWith(true);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("reports access once a signed-in, available status arrives, and after unlocking", async () => {
    const onAccess = vi.fn();
    vi.stubGlobal("fetch", sessionServer(locked));
    await renderWith(onAccess);
    expect(last(onAccess)).toBe(false);
    await type("secret-code");
    await submit();
    await settle();
    expect(last(onAccess)).toBe(true);
  });

  it("revokes access as soon as the viewer locks, before the status check returns", async () => {
    const onAccess = vi.fn();
    let finishDelete!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_u, init) => {
      if (init?.method === "DELETE") return new Promise((r) => { finishDelete = r; });
      return Promise.resolve(statusResponse(unlocked));
    }));
    await renderWith(onAccess);
    expect(last(onAccess)).toBe(true);
    await act(async () => { button("Lock AI explanations").click(); });
    expect(last(onAccess)).toBe(false);
    // A lock the server refused restores access.
    await act(async () => finishDelete(json({ ok: false }, 500)));
    expect(last(onAccess)).toBe(true);
  });

  it("revokes access when the session expires, before the status check returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const onAccess = vi.fn();
    const gets: ((r: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(() => new Promise((r) => { gets.push(r); })));
    await renderWith(onAccess);
    await act(async () => gets[0]!(statusResponse({ ...unlocked, expiresAt: Date.now() + 1_000 })));
    expect(last(onAccess)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(last(onAccess)).toBe(false);
    expect(gets).toHaveLength(2);
    await act(async () => gets[1]!(statusResponse(locked)));
    expect(last(onAccess)).toBe(false);
    expect(onAccess.mock.calls.flat()).toEqual([false, true, false]);
  });
});
