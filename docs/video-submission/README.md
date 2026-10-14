# PitchLens video submission

| File | Contents |
| --- | --- |
| [pitchlens-demo-final.mp4](pitchlens-demo-final.mp4) | **Submission video**: intro card, screen recording and new narration (1:58.7) |
| [pitchlens-demo-final.srt](pitchlens-demo-final.srt) | English subtitles for the submission video, for upload to the video host |
| [narration-script.md](narration-script.md) | Timed narration and continuous reading copy |
| `pitchlens-demo-smooth.mp4` | Unedited source screen recording (1:56, with an older narration track the final video does not use). Kept locally and not committed; `tools/build.py` needs it to rebuild the video |
| [tools/](tools) | Narration text, intro card and the scripts that rebuild the final video |

## Final video

| Item | Value |
| --- | --- |
| Duration | 1 minute 58.7 seconds, including the intro and ending fade |
| Video | 1920×1080, 30 fps, H.264 |
| Audio | English narration, AAC 48 kHz |
| Narration | Microsoft MAI-Voice-2.1, voice `en-US-Grant`, through Azure AI Speech on the project's Microsoft Foundry resource |
| Match | Synthetic generated match, seed 119, 60 seconds, 4-3-3 on both teams |
| Application | Local production build of PitchLens |
| AI | Real Microsoft Foundry requests (`gpt-5-mini` deployment) through the application's analyst and verifier workflow |
| Waiting time | Condensed and labelled **AI waits shortened** |
| Captions | Not burned in; supplied as the `.srt` file |

## Sequence

Final-video times. The screen recording starts at 0:09.3, so recording time is
final time minus 9.3 s.

| Video time | Demonstration |
| --- | --- |
| 0:00–0:09 | Intro card: product name, features, Microsoft Foundry and MAI-Voice credits, synthetic-data notice |
| 0:09–0:51 | Continuous 1× match playback through both goals, with current-time statistics and patterns |
| 0:51–0:58 | Pause and inspect a measured pattern's supporting events |
| 0:58–1:19 | Casual Fan explanation, then a fresh Analyst request using the same evidence cutoff |
| 1:19–1:26 | Replay cited evidence at 1× |
| 1:26–1:34 | Seek before the penalty and show that later insights disappear |
| 1:35–1:42 | Choose Northvale Rovers and B. Oduya, then show the focused view |
| 1:42–1:59 | Seek to full time, open Recap, show the checked summary, fade out |

## Rebuilding

From `docs/video-submission/tools`, with `FOUNDRY_ENDPOINT` and
`FOUNDRY_API_KEY` in the repository's `.env.local`, and Python packages
`imageio-ffmpeg` and `playwright` (with Chromium) installed:

```
python tts.py     # synthesizes each line into build/audio and checks it fits its slot
python build.py   # renders the intro, mixes narration and writes the final video
```

`build.py` reads the source recording without modifying it, discards its old
audio, trims it after the last line, and refuses to write a video of 119 s or
longer. Intermediate files go to `build/`, which is not committed.

## Verification

The source recording samples one browser-rendered frame for each output frame
at uniform playback-clock intervals; during the continuous match, the playback
clock advances 1,000 ms per output second. Its SHA-256 is unchanged by the build
(`5bdf9ef2…693180ae`).

The final file decodes without errors. The narration pauses were checked
against the screen beats, and the intro, both goals, both audience views,
citation replay, backward seeking, preferences, recap and ending were visually
inspected.

The recording is a product demonstration, not a live evaluation matrix or a
capacity benchmark. Checked explanations reduce mistakes; neither citations nor
model approval prove every claim true. See [AI evaluation](../ai-evaluation.md)
and [release readiness](../release-readiness.md) for the separate validation
evidence.

## Publication

The [official rules, section 4.4](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md)
require a demonstration shorter than two minutes, showing the project functioning,
and a public video URL from an accepted host. Rules checked October 14, 2026.
The public hosting URL has not been recorded here yet. Follow the
[submission checklist](../submission.md) before submitting.
