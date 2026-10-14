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

## Finished demonstration: 1 minute 58.7 seconds

The [finished video](video-submission/pitchlens-demo-final.mp4) and
[timed narration](video-submission/narration-script.md) are included in this repository.
See [recording details and verification](video-submission/README.md).

The video opens with a short intro card crediting Microsoft Foundry and
Microsoft MAI-Voice narration, then shows a generated match at 1×, measured patterns, real Microsoft
Foundry explanations for both audiences, evidence replay, backward seeking,
preferences and the full-time recap. AI waiting time is condensed and labelled.
The capture uses a local production build; it is separate from verification of
the deployed judge-access experience.

The local video is complete. Publication to an accepted public video host and
adding that public URL to the submission are still required.

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
complete, as confirmed by the project owner. Initial hosted checks passed;
verify the final released revision and
judge-access flow before submitting; see [judge instructions](judge-instructions.md)
and [release readiness](release-readiness.md).

## Submission checklist

The [official rules](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md)
were checked on October 14, 2026. Recheck before submitting.

- Registration: October 20, 2026, noon Pacific; confirm completion.
- Submission: October 27, 2026, 11:59 p.m. Pacific.
- Public source: `https://github.com/enniob/pitchlens`.
- Finalize the project description and category selection on the submission site.
- Publish the finished 1:58.7 demonstration (`docs/video-submission/pitchlens-demo-final.mp4`, with its `.srt` subtitles) to an accepted public video host
  and add its URL.
- Add a working judge-access link and testing instructions; keep access available
  through November 10, 2026, when judging ends.
- Review permissions for any media used and supply English submission materials.

Azure hosting and deployment are complete. Verification of the final deployed
revision, video publication and submission remain pending. This guide does not confirm
registration, successful judging access, or a submitted entry.
