<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## PitchLens product goal

PitchLens transforms synthetic, football-realistic match data into
explainable match intelligence through interactive 3D playback.

The intended experience covers:
1. Ingest synthetic events as playback advances.
2. Interpret events into statistics and evidence-backed patterns.
3. Explain why a moment matters.
4. Render explanations alongside the match with replayable evidence.
5. Personalize explanations for Casual Fan and Analyst audiences.

## Data and explanation rules

- Use synthetic, football-realistic data and clearly label it.
- Keep fictional teams and players; use only permitted assets.
- Explanations may use only evidence available at the selected playback time.
- Never expose future events, outcomes, or scheduled formation changes.
- Use the existing context extractor and response validation.
- Keep generator metadata and spoiler titles out of model-facing context.
- Separate observable facts from tactical interpretation.
- Citation validation proves a reference exists, not that a claim is true.
- Say when evidence is insufficient. Do not invent player intentions,
  attributes, pressure metrics, or causal relationships.
- Both audience modes must use the same underlying evidence.

## Architecture direction

- Microsoft Foundry is the model platform. The server calls it through the
  Azure OpenAI-compatible v1 chat completions API; Foundry cloud evaluations
  score live evaluation runs.
- Microsoft Agent Framework was evaluated and not adopted (see
  `docs/explain-service.md`). The analyst, tool, verifier and revision steps
  are TypeScript in `src/server/analyst.ts`; revisit the framework only with a
  documented reason.
- Verify current official documentation and SDK compatibility before choosing
  implementation details; document any incompatibility.
- Give agents distinct responsibilities and bounded tool access.
- Enforce time boundaries in application code, not only in prompts.
- Keep credentials and model calls server-side.
- Preserve the existing simulation, fixture contracts, and playback behavior.
- Coordinate UI changes with the separate redesign work.

## Delivery and public repository practices

- Keep changes focused, documented, and independently reviewable.
- Test meaningful behavior, including future-data prevention, unsupported
  evidence references, failure handling, and backward seeking.
- Run relevant tests, type checking, and the production build before handoff.
- Clearly distinguish mocked behavior from live integration.
- Do not publish secrets, access codes, endpoints or private planning in
  commits, issues, PRs or documentation.
- Assistant attribution is allowed: commits and PRs may say Claude wrote or
  co-authored the work.
- Do not merge or deploy unless explicitly requested. Merging to `main`
  deploys it to the public app.
- Document the Microsoft/Azure technologies actually used.

## Hosting

- The public app runs on one Azure App Service instance (Linux, Node.js 22).
  `.github/workflows/main_pitchlens.yml` builds, tests and deploys every push
  to `main`.
- Foundry credentials, the judge access code and the session secret are App
  Service application settings. Never commit them; docs use placeholders.
- Allowances and the answer cache are in memory, so the app must stay on a
  single instance.
- Keep `README.md`, `docs/submission.md` and `docs/security-controls.md`
  consistent with how the app is actually hosted.

## Hackathon reference

Official rules:
https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md

The submission needs a public GitHub repository, a working project accessible
to judges, an elevator pitch, and a demonstration video under two minutes.
Registration closes October 20, 2026 (noon Pacific); submissions close
October 27, 2026 (11:59 p.m. Pacific); judges need access until November 10,
2026. `docs/submission.md` holds the pitch, judge testing instructions and
checklist. Consult the current official rules before submission.
