#!/usr/bin/env node
/**
 * Records the PitchLens demonstration (no audio) from a running deployment,
 * with English captions taken from docs/demo-recording.md.
 *
 *   npm run record -- [--url <app url>] [--out <folder>] [options]
 *
 * Outputs in --out (existing files there are first moved to backup-<time>/):
 *   pitchlens-demo.mp4            clean 1920x1080 H.264 video, under two minutes
 *   pitchlens-demo.en.srt / .vtt  caption sidecars for the video host
 *   pitchlens-demo-captioned.mp4  preview with the captions burned in
 *   recording-log.json            when each scene started, for editing
 *
 * AI access: the judge access code is read from PITCHLENS_JUDGE_ACCESS_CODE in
 * the environment, or from .env.local / .env in the repository root. It is
 * entered on an unrecorded page and never printed or recorded.
 *
 * Unless --no-warm is given, an unrecorded pass first requests the same
 * explanations and recaps, so the recorded pass is served from the service's
 * ten-minute answer cache. The captions say so; a fresh request takes longer.
 */
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DEFAULT_URL = "https://pitchlens-cubrekc4a8a0g8gp.westus3-01.azurewebsites.net/";
const BASE = "pitchlens-demo";
const FPS = 30;
const VIEWPORT = { width: 1440, height: 810 };
const SCALE = 4 / 3; // 1440x810 CSS pixels -> 1920x1080 video, larger text on screen

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const o = {
    url: DEFAULT_URL,
    out: join(homedir(), "Videos", "PitchLens"),
    headless: false,
    channel: process.platform === "win32" ? "msedge" : undefined,
    warm: true,
    burn: true,
    maxSeconds: 118,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--url") o.url = next();
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--headless") o.headless = true;
    else if (a === "--channel") o.channel = next() === "none" ? undefined : argv[i];
    else if (a === "--no-warm") o.warm = false;
    else if (a === "--no-burn") o.burn = false;
    else if (a === "--max-seconds") o.maxSeconds = Math.min(119, Number(next()));
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

/** The judge access code, without ever printing it. */
function accessCode() {
  if (process.env.PITCHLENS_JUDGE_ACCESS_CODE) return process.env.PITCHLENS_JUDGE_ACCESS_CODE.trim();
  for (const name of [".env.local", ".env"]) {
    const file = join(REPO, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?PITCHLENS_JUDGE_ACCESS_CODE\s*=\s*(.*)\s*$/);
      if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
    }
  }
  return "";
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = spawnSync(process.execPath, ["-e", "process.stdout.write(require('ffmpeg-static') || '')"], { cwd: HERE, encoding: "utf8" }).stdout;
    if (p && existsSync(p)) return p;
  } catch { /* fall through to PATH */ }
  return "ffmpeg";
}

/** Moves everything already in the output folder (except older backups) into backup-<time>/. */
function backupExisting(out) {
  mkdirSync(out, { recursive: true });
  const entries = readdirSync(out).filter((n) => !n.startsWith("backup-"));
  if (!entries.length) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(out, `backup-${stamp}`);
  mkdirSync(dir);
  for (const n of entries) renameSync(join(out, n), join(dir, n));
  return dir;
}

// ---------------------------------------------------------------- captions

/** Narration from docs/demo-recording.md, one entry per scene. */
const SCENES = [
  { id: "intro", at: 0, text: "Football statistics tell us what happened. PitchLens helps explain why a moment matters, using evidence you can replay beside a synthetic match." },
  { id: "play", at: 12, text: "These teams, players and events are fictional. As playback advances, recorded events become current statistics. The simulator is seeded, so the same settings reproduce the same match." },
  { id: "pattern", at: 28, text: "Here, a turnover leads to three completed passes and a shot. The sequence and its duration are calculated in code. We describe what is recorded, without inventing player intent or defensive pressure." },
  { id: "explain", at: 44, text: "Microsoft Foundry turns that evidence into an account for a casual fan or an analyst. Both use the same evidence. Factual claims are built in code; the model selects them and writes the explanation. Checks and a separate verifier review the wording." },
  { id: "replay", at: 67, text: "Every claim links to an event or position snapshot. Replay takes us back to that evidence. Seeking earlier hides later insights, and the model's tools cannot access events beyond the selected time." },
  { id: "prefs", at: 83, text: "Preferences focus the moments and measured patterns on a favorite team or player. Personalization changes what is highlighted, while preserving the underlying match and evidence." },
  { id: "recap", at: 98, text: "The recap brings together the result and defining moments. PitchLens connects match intelligence to evidence you can inspect. Automated checks reduce mistakes; they do not guarantee every AI claim is true." },
];
const WARM_NOTE = "(Answers were prepared just before recording. A fresh request takes about 10 to 20 seconds.)";

/** Splits narration into caption-sized chunks of at most ~84 characters (two lines). */
function chunks(text) {
  const out = [];
  for (const sentence of text.match(/[^.;]+[.;)]+\s*|[^.;]+$/g) ?? [text]) {
    let cur = "";
    for (const word of sentence.trim().split(/\s+/)) {
      if (cur && (cur + " " + word).length > 84) { out.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Two lines of at most ~42 characters, broken at the space nearest the middle. */
function wrap(s) {
  if (s.length <= 42) return s;
  const mid = s.length / 2;
  let best = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? s : `${s.slice(0, best)}\n${s.slice(best + 1)}`;
}

/** Cues spread over each scene's measured time, weighted by length. */
function buildCues(marks, endSec, warmed) {
  const cues = [];
  marks.forEach((m, i) => {
    const start = m.sec;
    const end = Math.min(i + 1 < marks.length ? marks[i + 1].sec : endSec, endSec);
    if (end - start < 0.5) return;
    const scene = SCENES.find((s) => s.id === m.id);
    const parts = chunks(scene.text);
    if (warmed && m.id === "explain") parts.push(WARM_NOTE);
    const total = parts.reduce((n, p) => n + p.length, 0);
    let t = start;
    for (const p of parts) {
      const d = (end - start) * (p.length / total);
      cues.push({ start: t, end: t + d - 0.05, text: wrap(p) });
      t += d;
    }
  });
  return cues;
}

const stamp = (sec, sep) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};
const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`).join("\n");
const toVtt = (cues) => `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")}`;

// ---------------------------------------------------------------- recording

/**
 * Captures the page with the DevTools screencast and encodes a constant
 * frame-rate H.264 file: each frame is repeated until the next one arrives,
 * so still screens keep their real duration.
 */
class Recorder {
  constructor(page, ffmpeg, file, maxSeconds) {
    Object.assign(this, { page, ffmpeg, file, maxSeconds, t0: null, last: null, written: 0 });
  }
  async start() {
    this.proc = spawn(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS),
      "-t", String(this.maxSeconds), "-movflags", "+faststart", this.file,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    this.proc.stdin.on("error", () => {}); // ffmpeg exits at -t; later frames are dropped
    this.done = new Promise((res, rej) => this.proc.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited with ${c}`)))));
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.started = new Promise((res) => (this.onFirst = res));
    this.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      this.frame(Buffer.from(data, "base64"), metadata.timestamp * 1000);
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await this.started;
  }
  frame(buf, atMs) {
    if (this.t0 === null) { this.t0 = atMs; this.last = buf; this.onFirst(); return; }
    this.fill(atMs);
    this.last = buf;
  }
  fill(atMs) {
    const target = Math.floor(((atMs - this.t0) / 1000) * FPS);
    while (this.written < target && !this.proc.stdin.destroyed) { this.proc.stdin.write(this.last); this.written++; }
  }
  /** Seconds since the first frame. */
  now() { return (Date.now() - this.t0) / 1000; }
  async stop() {
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.fill(Date.now());
    if (this.written === 0) this.proc.stdin.write(this.last);
    this.proc.stdin.end();
    await this.done;
    return Math.min(this.written / FPS, this.maxSeconds);
  }
}

/** A visible pointer, since automated clicks have none. */
const CURSOR_SCRIPT = `(() => {
  const make = () => {
    if (document.getElementById("pl-cursor")) return;
    const c = document.createElement("div");
    c.id = "pl-cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.8L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none",
      transform: "translate(720px, 600px)", transition: "transform 0ms", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))" });
    document.documentElement.appendChild(c);
    window.__plCursor = {
      move(x, y, ms) { c.style.transition = "transform " + ms + "ms cubic-bezier(.45,.05,.25,1)"; c.style.transform = "translate(" + (x - 4) + "px," + (y - 2) + "px)"; },
      click(x, y) {
        const r = document.createElement("div");
        Object.assign(r.style, { position: "fixed", left: (x - 18) + "px", top: (y - 18) + "px", width: "36px", height: "36px", borderRadius: "50%",
          border: "3px solid #34d399", zIndex: 2147483646, pointerEvents: "none", transition: "transform 450ms ease-out, opacity 450ms ease-out" });
        document.documentElement.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
        setTimeout(() => r.remove(), 500);
      },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make); else make();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UI steps shared by the warm-up and the recorded pass. */
function actions(page, { show }) {
  const pause = (ms) => (show ? sleep(ms) : Promise.resolve());
  const center = async (loc) => {
    await loc.waitFor({ state: "visible", timeout: 30_000 });
    await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    await sleep(show ? 450 : 50);
    const b = await loc.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const point = async (loc, ms = 700) => {
    const p = await center(loc);
    if (show) { await page.evaluate(({ x, y, ms }) => window.__plCursor?.move(x, y, ms), { ...p, ms }); await sleep(ms + 120); }
    return p;
  };
  const click = async (loc, ms) => {
    const p = await point(loc, ms);
    if (show) await page.evaluate(({ x, y }) => window.__plCursor?.click(x, y), p);
    await page.mouse.click(p.x, p.y);
    await pause(250);
  };
  const clock = () => page.locator(".timeline__slider").evaluate((el) => Number(el.value));
  const waitClock = (ms, timeout = 120_000) =>
    page.waitForFunction((t) => Number(document.querySelector(".timeline__slider")?.value) >= t, ms, { timeout, polling: 100 });
  const playing = () => page.locator(".ctl--play").getAttribute("aria-label").then((l) => /pause/i.test(l ?? ""));
  const setPlaying = async (on) => { if ((await playing()) !== on) await click(page.locator(".ctl--play"), 500); };
  const speed = (s) => page.locator(".controls__speed select").selectOption(String(s));
  const marker = (name) => page.locator(`.timeline__markers button[aria-label*="${name}"]`).first();
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const audience = (name) => page.getByRole("group", { name: "Explanation audience" }).first().getByRole("button", { name, exact: true });
  /** Waits for an explanation (or an error) after asking; never longer than `timeout`. */
  const waitAnswer = async (timeout) => {
    const panel = page.locator("#dock-panel-moments");
    await panel.locator(".explain__answer, .explain__error").first().waitFor({ state: "visible", timeout }).catch(() => {});
  };
  const explain = async (timeout) => {
    await click(page.getByRole("button", { name: /Explain this moment|Try again|Get AI explanation/ }).first());
    await waitAnswer(timeout);
  };
  const waitRecap = (timeout) =>
    page.locator(".recap__story:not([aria-busy])").first().waitFor({ state: "visible", timeout }).catch(() => {});
  return { pause, point, click, clock, waitClock, setPlaying, speed, marker, tab, audience, explain, waitAnswer, waitRecap };
}

async function unlock(page, code) {
  const open = page.getByRole("button", { name: "AI access" });
  if (!(await open.isVisible().catch(() => false))) return "no AI access control (server not in judge mode)";
  await open.click();
  const dialog = page.getByRole("dialog");
  const unlocked = dialog.getByText("AI explanations unlocked");
  if (!(await unlocked.isVisible().catch(() => false))) {
    if (!code) { await dialog.getByRole("button", { name: "Done" }).click(); return "locked: no PITCHLENS_JUDGE_ACCESS_CODE found"; }
    await dialog.locator("#pitchlens-access-code").fill(code);
    await dialog.getByRole("button", { name: "Unlock AI explanations" }).click();
    await unlocked.waitFor({ timeout: 20_000 }).catch(() => {});
  }
  const ok = await unlocked.isVisible().catch(() => false);
  await dialog.getByRole("button", { name: "Done" }).click();
  return ok ? "unlocked" : "unlock failed (check the access code)";
}

/** Same requests as the recorded pass, unrecorded, so the recording is served from cache. */
async function warmUp(page, log) {
  const a = actions(page, { show: false });
  await page.getByRole("button", { name: "Kick off the demo" }).first().click();
  await a.speed(1);
  log("warm-up: playing to the goal (automatic insights)");
  await a.waitClock(9_600);
  await a.click(a.marker("Goal"));
  for (const who of ["Casual Fan", "Analyst"]) {
    log(`warm-up: explanation for ${who}`);
    await a.click(a.audience(who));
    await sleep(800);
    if (!(await page.locator("#dock-panel-moments .explain__answer").isVisible())) await a.explain(120_000);
  }
  await a.click(a.audience("Casual Fan"));
  // Settle the automatic insights before moving on.
  await page.locator(".insight .spinner").first().waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
  await a.speed(4);
  await a.setPlaying(true);
  await a.waitClock(24_000);
  await page.getByRole("button", { name: "See the recap" }).click();
  for (const who of ["Casual Fan", "Analyst"]) {
    log(`warm-up: recap for ${who}`);
    await a.click(a.audience(who));
    await sleep(500);
    await a.waitRecap(120_000);
  }
}

/** The recorded demonstration; scene starts follow docs/demo-recording.md. */
async function demo(page, rec, log) {
  const a = actions(page, { show: true });
  const marks = [];
  const scene = async (id) => {
    const plan = SCENES.find((s) => s.id === id).at;
    while (rec.now() < plan) await sleep(50);
    marks.push({ id, sec: rec.now() });
    log(`${id} at ${rec.now().toFixed(1)} s (planned ${plan} s)`);
  };
  const until = async (sec) => { while (rec.now() < sec) await sleep(40); };

  // 0:00 Welcome, then kick off the scripted demo at full speed.
  await scene("intro");
  await until(2.5);
  await a.point(page.getByRole("button", { name: "Kick off the demo" }).first(), 1200);
  await until(8.5);
  await a.click(page.getByRole("button", { name: "Kick off the demo" }).first(), 200);
  await a.speed(1);

  // 0:12 Turnover, passes, shot and goal; current-time numbers in Tactics.
  await scene("play");
  await a.waitClock(3_000);
  await a.click(a.tab("Tactics"), 900);
  await a.point(page.locator(".tactics").first(), 900);
  await a.waitClock(11_500);
  await a.setPlaying(false);

  // 0:28 The measured turnover-to-shot pattern and its supporting events.
  await scene("pattern");
  const patterns = page.getByRole("region", { name: "Measured match patterns" });
  await a.point(patterns.locator("h3"), 800);
  await until(31);
  await a.click(patterns.locator("summary").first());
  await until(36);
  await a.click(patterns.getByRole("button", { name: /^Replay .* evidence/ }).first());
  await a.waitClock(9_700, 30_000).catch(() => {});
  await a.click(a.marker("Goal"), 500);

  // 0:44 AI explanation for a casual fan, then an analyst, at the same moment.
  await scene("explain");
  await a.click(a.tab("Game moments"), 700);
  await until(46);
  await a.explain(25_000);
  await a.pause(1_500);
  await a.point(page.locator("#dock-panel-moments .explain__headline").first(), 700).catch(() => {});
  await until(56);
  await a.click(a.audience("Analyst"));
  await sleep(1_000);
  if (!(await page.locator("#dock-panel-moments .explain__answer").isVisible())) await a.explain(15_000);
  await until(62);
  await a.point(page.locator("#dock-panel-moments .explain__details summary").first(), 900).catch(() => {});

  // 1:07 Citation replay; seek before the goal; the explanation returns at its cutoff.
  await scene("replay");
  const cite = page.locator("#dock-panel-moments").locator(".evidence__replay, .cite").first();
  if (await cite.isVisible().catch(() => false)) await a.click(cite);
  await until(72);
  await a.click(a.marker("Turnover"), 800);
  await a.pause(2_500);
  await a.setPlaying(true);
  await a.waitClock(9_600, 30_000).catch(() => {});
  await a.setPlaying(false);
  await a.point(page.locator("#dock-panel-moments .explain__answer").first(), 700).catch(() => {});

  // 1:23 Preferences: favorite team and player focus the moments shown.
  await scene("prefs");
  await a.click(page.getByRole("button", { name: "Preferences" }), 900);
  const dialog = page.getByRole("dialog");
  const team = dialog.getByLabel("Favorite team");
  await a.point(team, 600);
  await team.selectOption({ index: 1 });
  await a.pause(1_200);
  const player = dialog.getByLabel("Favorite player");
  await a.point(player, 600);
  const options = await player.locator("option").count();
  if (options > 1) await player.selectOption({ index: options > 2 ? options - 2 : 1 }); // a forward rather than the keeper
  await a.pause(1_500);
  await a.click(dialog.getByRole("button", { name: "Done" }), 600);
  await a.click(a.tab("Tactics"), 700);
  await a.point(page.getByRole("region", { name: "Measured match patterns" }).locator("h3"), 700);

  // 1:38 Full time and the recap.
  await scene("recap");
  await a.speed(4);
  await a.setPlaying(true);
  await a.waitClock(24_000, 30_000);
  await a.click(page.getByRole("button", { name: "See the recap" }), 700);
  await a.waitRecap(6_000);
  await a.pause(2_500);
  await page.locator(".recap__story").first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "start" })).catch(() => {});
  await until(112);
  return marks;
}

// ---------------------------------------------------------------- main

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[record] ${m}`);
  const ffmpeg = ffmpegPath();
  if (spawnSync(ffmpeg, ["-version"]).status !== 0) throw new Error("ffmpeg not found. Run npm install here, or set FFMPEG_PATH.");

  const backup = backupExisting(o.out);
  if (backup) log(`moved existing files to ${backup}`);

  const browser = await chromium.launch({
    headless: o.headless,
    channel: o.channel,
    args: [`--window-size=${VIEWPORT.width + 16},${VIEWPORT.height + 140}`, "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"],
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "dark", reducedMotion: "no-preference" });

    const prep = await context.newPage();
    await prep.goto(o.url, { waitUntil: "networkidle", timeout: 90_000 });
    log(`AI access: ${await unlock(prep, accessCode())}`);
    let warmed = false;
    if (o.warm) {
      try { await warmUp(prep, log); warmed = true; }
      catch (e) { log(`warm-up incomplete (${e.message.split("\n")[0]}); recording with live requests`); }
    }
    await prep.close();

    // Fresh page, same signed-in session; start on Game moments in Casual Fan.
    const page = await context.newPage();
    await page.addInitScript(() => { try { localStorage.removeItem("pitchlens.pro"); } catch {} });
    await page.addInitScript(CURSOR_SCRIPT);
    await page.goto(o.url, { waitUntil: "networkidle", timeout: 90_000 });
    await page.getByRole("button", { name: "Kick off the demo" }).first().waitFor();
    await sleep(800);

    const file = join(o.out, `${BASE}.mp4`);
    const rec = new Recorder(page, ffmpeg, file, o.maxSeconds);
    await rec.start();
    let marks = [];
    try { marks = await demo(page, rec, log); }
    finally {
      const seconds = await rec.stop();
      const cues = buildCues(marks, seconds, warmed);
      writeFileSync(join(o.out, `${BASE}.en.srt`), toSrt(cues));
      writeFileSync(join(o.out, `${BASE}.en.vtt`), toVtt(cues));
      writeFileSync(join(o.out, "recording-log.json"), JSON.stringify({ url: o.url, recordedAt: new Date().toISOString(), seconds, warmed, scenes: marks }, null, 2));
      log(`video: ${file} (${seconds.toFixed(1)} s)`);
    }

    if (o.burn) {
      const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", `${BASE}.mp4`,
        "-vf", `subtitles=${BASE}.en.srt:force_style='FontName=Arial,FontSize=20,Outline=1.5,Shadow=0,MarginV=28,BorderStyle=3,BackColour=&H80000000'`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-movflags", "+faststart", `${BASE}-captioned.mp4`], { cwd: o.out, stdio: "inherit" });
      log(r.status === 0 ? `captioned preview: ${join(o.out, `${BASE}-captioned.mp4`)}` : "could not burn in captions; the .srt and .vtt files are still written");
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(`[record] ${e.stack ?? e}`); process.exit(1); });
