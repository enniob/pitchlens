"""Synthesizes each narration line with Microsoft MAI-Voice through Azure AI Speech.

usage: python tts.py [line-id] [rate]   e.g. python tts.py casual +6%

Uses the Foundry (AI Services) resource named by FOUNDRY_ENDPOINT in .env.local
and its FOUNDRY_API_KEY. The key is never printed. Writes build/audio/<id>.wav.
"""
import json, pathlib, re, sys, time, urllib.error, urllib.request, wave
from xml.sax.saxutils import escape

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parents[2]
OUT = HERE.parent / "build" / "audio"


def env(name):
    m = re.search(rf"^{name}=(.*)$", (ROOT / ".env.local").read_text(), re.M)
    if not m:
        sys.exit(f"{name} is missing from .env.local")
    return m.group(1).strip().strip('"')


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    rate = sys.argv[2] if len(sys.argv) > 2 else None
    script = json.loads((HERE / "narration.json").read_text(encoding="utf-8"))
    resource = re.match(r"https://([^.]+)\.", env("FOUNDRY_ENDPOINT")).group(1)
    url = f"https://{resource}.cognitiveservices.azure.com/tts/cognitiveservices/v1"
    key = env("FOUNDRY_API_KEY")
    OUT.mkdir(parents=True, exist_ok=True)

    for line in script["lines"]:
        if only and line["id"] != only:
            continue
        body = escape(line["text"])
        if rate:
            body = f"<prosody rate='{rate}'>{body}</prosody>"
        ssml = f"<speak version='1.0' xml:lang='en-US'><voice name='{script['voice']}'>{body}</voice></speak>"
        req = urllib.request.Request(url, data=ssml.encode(), headers={
            "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "pitchlens-demo"})
        for attempt in range(4):
            try:
                data = urllib.request.urlopen(req, timeout=60).read()
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
        (OUT / f"{line['id']}.wav").write_bytes(data)

    for line in script["lines"]:
        f = OUT / f"{line['id']}.wav"
        if not f.exists():
            continue
        with wave.open(str(f)) as w:
            dur = w.getnframes() / w.getframerate()
        room = line["until"] - line["at"] if "until" in line else None
        flag = "" if room is None or dur <= room else f"  TOO LONG by {dur - room:.2f}s"
        print(f"{line['id']:12} {dur:5.2f}s" + (f" / {room:4.1f}s" if room else "") + flag)


main()
