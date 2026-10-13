# PitchLens submission guide

## Elevator pitch

PitchLens helps football viewers understand why a moment matters. It turns
synthetic match events into measured patterns and Microsoft Foundry explanations
beside an interactive 3D replay. Casual fans get a short account; analysts can
inspect observations, tactical readings, and limitations. Supported claims link
to replayable evidence, and team or player preferences focus the moments that matter
to each viewer. Playback-time boundaries prevent explanations from seeing later
events, including when a viewer seeks backwards. It runs on Azure App Service,
deployed by GitHub Actions, and Microsoft Foundry cloud evaluations score its
answers during testing.

## Technology statement

- **Microsoft Foundry** hosts the model deployment used for live explanations.
- The Next.js server calls it through the **Azure OpenAI-compatible v1 chat
  completions API** with server-only credentials and structured JSON output.
- **Microsoft Foundry cloud evaluations** score retained live explanations for
  groundedness, relevance, coherence, content safety and indirect attacks
  (informational, beside the deterministic checks).
- **Azure App Service** hosts the public app; credentials are App Service
  application settings.
- **GitHub Actions** runs offline tests, type checking and the production build
  on every pull request, and deploys `main` to App Service with OpenID Connect
  sign-in.
- The application implements bounded analyst/tool/verifier steps, deterministic
  validation, one revision and explicit failure handling in TypeScript.
- Three.js renders the synthetic match; React presents evidence and preferences.
- Vitest exercises simulation, evidence boundaries and failure behavior with
  mocked models. Live evaluations are separate and opt-in.

Microsoft Agent Framework, Fabric, MCP and managed Azure databases are not
claimed as implemented technologies. See [service architecture](explain-service.md)
for the Agent Framework evaluation and [AI evaluation](ai-evaluation.md) for the
distinction between offline checks and live quality.

## Testing instructions for judges

Paste this into the submission's testing instructions, with the real access
code. Never commit the code to this repository.

> **URL:** <judge URL>
>
> PitchLens works in a desktop browser with WebGL (Chrome, Edge, Firefox or
> Safari). All teams, players and events are synthetic.
>
> 1. Open the URL and choose **Kick off the demo**. Playback, statistics,
>    patterns and the recap work without signing in.
> 2. To turn on AI explanations, select the lock icon (**AI access**) in the
>    header and enter the access code: `<access code>`. Access lasts 30 minutes;
>    enter the code again after that.
> 3. Let play reach the goal, or pause anywhere and press **Pause and explain**.
>    Switch between **Casual Fan** and **Analyst**, expand the evidence and use
>    **Replay** on a cited event.
> 4. Seek backwards on the timeline: later moments and explanations disappear.
> 5. Open **Preferences** (sliders icon) and choose a team or player to focus on.
> 6. Let the match reach full time and open **Recap**.
> 7. **New match** generates a different reproducible match from a seed and
>    chosen formations.
>
> An explanation can take up to a minute. When an answer fails the automatic
> checks, PitchLens shows the recorded match facts, marked **Match facts, not
> AI**, with a button to try again. Each session allows 30 new explanations;
> repeated questions are answered from a cache.

Before submitting, and again during the judging period, follow these steps on
the public URL from a fresh browser profile, including unlocking AI access.

## Suggested demonstration: 1 minute 50 seconds

Record the functioning application. This is a recording script, not a completed
demo video. Confirm the configured live deployment and current behavior before
recording; trim pauses in editing without representing a cached answer as an
instant live response.

| Time | Screen action | Spoken message |
| --- | --- | --- |
| 0:00–0:12 | Show the pitch and Synthetic match label; kick off the scripted demo | “Football statistics tell us what happened. PitchLens connects them to evidence you can replay, so you can understand why a moment matters.” |
| 0:12–0:27 | Play the turnover, passing sequence, and shot; show current-time numbers | “Every team, player, and event here is synthetic. Playback reveals events and statistics as they happen.” |
| 0:27–0:45 | Pause after the shot; open measured patterns and replay its passage | “These patterns are calculated from recorded events. We can inspect the exact sequence and elapsed time without guessing what a player intended.” |
| 0:45–1:08 | Open a live AI explanation; show Casual Fan and Analyst versions at the same time | “Microsoft Foundry explains the evidence for two audiences. A separate verifier and application checks review the answer, with one revision allowed.” |
| 1:08–1:23 | Expand citations; replay an event and seek before the explanation time | “Citations take us back to the evidence. Seeking backwards hides later insights. Automated checks reduce mistakes; they do not prove every claim true.” |
| 1:23–1:38 | Select a team and player; show focused moments and numbers | “Personal preferences focus the moments shown, while both audiences use the same underlying evidence.” |
| 1:38–1:50 | Reach full time and open Recap | “The result is a personalized viewing companion: live moments, measured patterns, and a recap you can question and replay.” |

## Running locally

1. Install Node.js 22 and run `npm ci`.
2. Copy `.env.example` to `.env.local`; configure Foundry, a random access
   code and an independent session signing secret.
3. Run `npm run dev` and open `http://localhost:3000`.
4. Follow the testing instructions above from step 1.

Playback works without Foundry credentials. AI explanations do not: a
configuration error is an expected failure state, not a mocked successful answer.

## Submission checklist

The [official rules](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md)
were checked on October 13, 2026. Recheck before submitting.

- Registration: October 20, 2026, noon Pacific; confirm completion.
- Submission: October 27, 2026, 11:59 p.m. Pacific.
- Public source: `https://github.com/enniob/pitchlens`.
- Finalize the project description and category selection on the submission site.
- Record a demonstration video shorter than two minutes showing the hosted app
  working, with no third-party trademarks or unlicensed music, and publish it
  publicly on YouTube, Vimeo, Facebook Video or Youku.
- Hosting: the app runs on Azure App Service. Put its URL in the README and in
  the testing instructions above, and the access code in the submission's
  testing instructions only. Keep the app running, the access code valid and
  Foundry funded through November 10, 2026, when judging ends.
- Review permissions for any media used and supply English submission materials.

Video publication, registration and submission are pending. This guide does not
confirm registration, successful judging access or a submitted entry.
