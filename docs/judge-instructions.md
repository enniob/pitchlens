# PitchLens judge instructions

PitchLens turns synthetic football events into measured patterns and
Microsoft Foundry explanations beside an interactive 3D replay.
All teams, players, movement and match events are fictional.

## Access

Open [PitchLens](https://pitchlens-cubrekc4a8a0g8gp.westus3-01.azurewebsites.net/).
The application is deployed on Azure App Service. If AI access is
locked, use the judge access code supplied privately in the submission's
testing instructions. Provider keys and session-signing secrets are never
judge credentials and must not be shared.

## Five-minute walkthrough

1. Open the website in a desktop browser with WebGL enabled. Open **AI access**
   in the header and enter the supplied judge access code.
2. Choose **Kick off the demo**. The score, event markers and statistics appear
   only as playback reaches them. All match data is labelled synthetic.
3. Pause after the goal and choose **Explain this moment**. Model calls and
   verification take time; a loading or queued state is expected.
4. Compare **Casual Fan** and **Analyst**. Both use the same underlying
   evidence. Expand the supporting evidence and use a **Replay** button.
5. Seek before the explanation's timestamp. The later explanation should
   disappear and return only when its cutoff is reached again. Earlier
   scores, event markers and formations should be restored.
6. Open **Tactics** to inspect measured statistics and patterns. Replay a
   supporting sequence. These are recorded measurements, not inferred pressure
   or player intent.
7. Open **Preferences** and choose a favorite team or player. Relevant moments,
   patterns and focused counts change; the match itself does not.
8. Reach the end of the synthetic sequence and open **Recap**. Inspect the
   score, defining moments, audience-specific summary and supporting events.
9. Start a new generated match with a seed, formations and optional formation
   change. Playback and seeking remain deterministic for the same settings.

## Failure states

An answer that fails validation is not shown. A card marked **Match facts,
not AI** is a deterministic recorded account, not a successful model answer.
Use **Get AI explanation** to retry. Insufficient evidence is stated explicitly.
Provider errors, throttling and exhausted allowances have separate messages;
playback remains available. Automated checks and citations do not prove that
every natural-language statement is correct.

## Local test build

Use Node.js 22, run `npm ci`, then `npm run build` and `npm start`. Open
`http://127.0.0.1:3000`. Playback works without credentials. For live AI,
configure the server-only variables in `.env.example` using your own Foundry
deployment, access code and signing secret. Do not use local development
access mode with a production build. See the README for full setup.
