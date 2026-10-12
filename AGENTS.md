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

- Microsoft Foundry is the planned model platform.
- Evaluate Microsoft Agent Framework for bounded agent orchestration.
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
- Do not publish secrets, private planning, coding-session URLs, or
  assistant/model attribution in issues, PRs, or documentation.
- Do not merge or deploy unless explicitly requested.
- Document the Microsoft/Azure technologies actually used.

## Hackathon reference

Official rules:
https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md

The submission needs a public GitHub repository, a working project accessible
to judges, an elevator pitch, and a demonstration video under two minutes.
Consult the current official rules before submission.
