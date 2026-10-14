"""Builds the submission video: intro card + the unchanged screen recording + new narration.

usage: python tts.py && python build.py

Reads ../pitchlens-demo-smooth.mp4 without modifying it; its original audio is
not used. Writes ../pitchlens-demo-final.mp4 and ../pitchlens-demo-final.srt.
"""
import array, json, pathlib, subprocess, wave
import imageio_ffmpeg
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
FOLDER = HERE.parent
BUILD = FOLDER / "build"
RECORDING = FOLDER / "pitchlens-demo-smooth.mp4"
FINAL = FOLDER / "pitchlens-demo-final.mp4"
FF = imageio_ffmpeg.get_ffmpeg_exe()
FPS = 30
BG = "0x0b1622"
LEAD = 0.5        # silence before a line starts on the intro card
INTRO_TAIL = 0.7  # card held after the intro line ends
END_TAIL = 1.3    # recording kept after the last line, including the fade
LIMIT = 119.0     # the rules require a video shorter than two minutes

script = json.loads((HERE / "narration.json").read_text(encoding="utf-8"))
lines = script["lines"]


def clip(line_id):
    with wave.open(str(BUILD / "audio" / f"{line_id}.wav")) as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1
        return w.getframerate(), array.array("h", w.readframes(w.getnframes()))


def ff(*args):
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def render_intro(seconds):
    frames = BUILD / "intro"
    frames.mkdir(parents=True, exist_ok=True)
    for f in frames.glob("*.png"):
        f.unlink()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.goto((HERE / "intro.html").as_uri(), wait_until="networkidle")
        page.evaluate("document.fonts.ready")
        page.evaluate("document.getAnimations().forEach(a => a.pause())")
        for i in range(round(seconds * FPS)):
            page.evaluate(f"document.getAnimations().forEach(a => a.currentTime = {i * 1000 / FPS})")
            page.screenshot(path=str(frames / f"{i:04d}.png"))
        browser.close()
    out = BUILD / "intro.mp4"
    ff("-framerate", str(FPS), "-i", str(frames / "%04d.png"),
       "-vf", f"fade=t=out:st={seconds - 0.4:.3f}:d=0.4:color={BG},format=yuv420p",
       "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-r", str(FPS), str(out))
    return out


def srt_time(s):
    ms = round(s * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main():
    rate, intro_clip = clip("intro")
    intro_len = round((LEAD + len(intro_clip) / rate + INTRO_TAIL) * FPS) / FPS

    # Place every line on one track, checking it ends before its next beat.
    cues, last_end = [], 0.0
    for line in lines:
        r, samples = clip(line["id"])
        assert r == rate
        dur = len(samples) / rate
        if line["at"] == "intro":
            start = LEAD
        else:
            start = intro_len + line["at"]
            assert line["at"] + dur <= line["until"] + 0.05, f"{line['id']} overruns its slot"
        assert start >= last_end, f"{line['id']} overlaps the previous line"
        cues.append((line, start, samples, dur))
        last_end = start + dur

    rec_end = lines[-1]["at"] + cues[-1][3] + END_TAIL
    total = intro_len + rec_end
    print(f"intro {intro_len:.2f}s + recording 0-{rec_end:.2f}s = {total:.2f}s")
    assert total <= LIMIT, "video must stay under two minutes"

    track = array.array("h", [0] * int(total * rate))
    for _, start, samples, _ in cues:
        i = int(start * rate)
        track[i:i + len(samples)] = samples[: len(track) - i]
    narration = BUILD / "narration.wav"
    with wave.open(str(narration), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(track.tobytes())

    srt = [f"{n}\n{srt_time(s)} --> {srt_time(s + d)}\n{line['text']}\n" for n, (line, s, _, d) in enumerate(cues, 1)]
    FINAL.with_suffix(".srt").write_text("\n".join(srt), encoding="utf-8")

    intro = render_intro(intro_len)
    graph = (f"[1:v]trim=0:{rec_end:.3f},setpts=PTS-STARTPTS,fps={FPS},format=yuv420p,"
             f"fade=t=in:st=0:d=0.3:color={BG},fade=t=out:st={rec_end - 1.0:.3f}:d=1.0:color={BG}[rec];"
             f"[0:v][rec]concat=n=2:v=1:a=0[v]")
    ff("-i", str(intro), "-i", str(RECORDING), "-i", str(narration), "-filter_complex", graph,
       "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
       "-r", str(FPS), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-af", f"afade=t=out:st={total - 0.6:.3f}:d=0.6",
       "-t", f"{total:.3f}", "-movflags", "+faststart", str(FINAL))
    print("wrote", FINAL)


main()
