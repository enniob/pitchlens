# PitchLens submission guide

## Elevator pitch

PitchLens helps football viewers understand why a moment matters. It turns
synthetic match events into measured patterns and Microsoft Foundry explanations
beside an interactive 3D replay. Casual fans get a short account; analysts can
inspect observations, tactical readings, and limitations. Supported claims link
to replayable evidence, and team or player preferences focus the moments that matter
to each viewer. Playback-time boundaries prevent explanations from seeing later
events, including when a viewer seeks backwards.

## Technology statement

- Microsoft Foundry hosts the model deployment used for live explanations.
- The Next.js server calls the Azure OpenAI-compatible v1 chat completions API
  with server-only credentials and structured JSON output.
- The application implements bounded analyst/tool/verifier steps, deterministic
  validation, one revision, and explicit failure handling in TypeScript.
- Three.js renders the synthetic match; React presents evidence and preferences.
- Vitest exercises simulation, evidence boundaries, and failure behavior with
  mocked models. Live evaluations are separate and opt-in.
- GitHub Actions runs offline tests, type checking, and the production build.
- Azure App Service hosts the deployed Next.js application on Linux with Node.js 22.
- Microsoft Foundry cloud evaluations provide informational groundedness,
  relevance, coherence, safety and indirect-attack assessments of retained
  answers. They do not replace application checks or manual review.

Agent Framework, Fabric, MCP, and managed Azure databases are not
claimed as implemented technologies. See [service architecture](explain-service.md)
for the Agent Framework evaluation and [AI evaluation](ai-evaluation.md) for the
distinction between offline checks and live quality.

## Suggested demonstration: 1 minute 50 seconds

Use the [complete narration and recording package](demo-recording.md).

Record the functioning application. This is a recording script, not a completed
demo video. Confirm the configured live deployment and current behavior before
recording; trim pauses in editing without representing a cached answer as an
instant live response.

| Time | Screen action | Spoken message |
| --- | --- | --- |
| 0:00–0:12 | Show the pitch and Synthetic match label; kick off the scripted demo | “Football statistics tell us what happened. PitchLens connects them to evidence you can replay, so you can understand why a moment matters.” |
| 0:12–0:27 | Play the turnover, passing sequence, and shot; show current-time numbers | “Every team, player, and event here is synthetic. Playback reveals events and statistics as they happen.” |
| 0:27–0:45 | Pause after the shot; open measured patterns and replay its passage | “These patterns are calculated from recorded events. We can inspect the exact sequence and elapsed time without guessing what a player intended.” |
| 0:45–1:08 | Open a live AI explanation; switch between Casual Fan and Analyst at the same playback time | “Microsoft Foundry explains the evidence for two audiences. Facts are calculated in code; the model selects them and writes the account. A separate verifier reviews its wording.” |
| 1:08–1:23 | Expand citations; replay an event and seek before the explanation time | “Citations take us back to the evidence. Seeking backwards hides later insights. Automated checks reduce mistakes; they do not prove every claim true.” |
| 1:23–1:38 | Select a team and player; show focused moments and numbers | “Personal preferences focus the moments shown, while both audiences use the same underlying evidence.” |
| 1:38–1:50 | Reach full time and open Recap | “The result is a personalized viewing companion: live moments, measured patterns, and a recap you can question and replay.” |

## Local walkthrough

1. Install Node.js 22 and run `npm ci`.
2. Copy `.env.example` to `.env.local`; configure Foundry, a random judge access
   code, and an independent session signing secret.
3. Run `npm run dev` and open `http://localhost:3000`.
4. Open **AI access** in the header and unlock explanations with the code,
   then select **Kick off the demo**,
   pause after the shot, and inspect patterns.
5. Request an explanation, compare audience modes, expand evidence, and replay.
6. Open header **Preferences** and choose a team/player focus. Seek backwards
   and confirm later moments disappear.
7. Reach full time and open **Recap**.

Playback works without Foundry credentials. AI explanations do not: a
configuration error is an expected failure state, not a mocked successful answer.
These are local developer instructions. Azure hosting and deployment are
complete, as confirmed by the project owner. The hosted walkthrough and final
judge-access URL still need verification; see [judge instructions](judge-instructions.md)
and [release readiness](release-readiness.md).

## Submission checklist

The [official rules](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md)
were checked on October 13, 2026. Recheck before submitting.

- Registration: October 20, 2026, noon Pacific; confirm completion.
- Submission: October 27, 2026, 11:59 p.m. Pacific.
- Public source: `https://github.com/enniob/pitchlens`.
- Finalize the project description and category selection on the submission site.
- Record and publish a functioning demonstration video shorter than two minutes.
- Add a working judge-access link and testing instructions; keep access available
  through November 10, 2026, when judging ends.
- Review permissions for any media used and supply English submission materials.

Azure hosting and deployment are complete. Hosted judge-access verification,
video publication and submission remain pending. This guide does not confirm
registration, successful judging access, or a submitted entry.
