# PitchLens documentation

Start with the [project README](../README.md) for installation, configuration,
features and limitations. This folder contains current guidance, measured
validation evidence and the finished demonstration. Superseded reports and
screenshots of older interfaces have been removed.

## Demo and submission

| File | Purpose |
| --- | --- |
| [Finished video](pitchlens-demo-smooth.mp4) | Accepted 1:56 demonstration, with English narration |
| [Exact narration](pitchlens-demo-script.md) | Spoken text, timestamps and reading copy used in that video |
| [Recording details](demo-recording.md) | Screen sequence, capture verification and publication status |
| [Judge instructions](judge-instructions.md) | Hosted access, walkthrough, expected failures and local test build |
| [Submission guide](submission.md) | Elevator pitch, implemented Microsoft/Azure technologies and submission checklist |
| [Release readiness](release-readiness.md) | Latest recorded validation, tested revisions and remaining release checks |

The video is complete. Public video hosting, final deployment verification and
submission completion remain separate checks; see the submission and readiness
guides. Judge codes and provider credentials belong in private configuration
and testing instructions.

## Architecture and operation

| File | Purpose |
| --- | --- |
| [Analyst service](explain-service.md) | Foundry integration, bounded analyst/verifier workflow, tools, revisions and failure handling |
| [Evidence contract](explain-this-moment.md) | Playback-time context, response schema, citations and browser validation |
| [Match patterns](match-patterns.md) | Recorded measurements, supporting events and interpretation limits |
| [3D rendering](3d-rendering.md) | Runtime geometry, authored player assets, animation and rendering limits |
| [Security controls](security-controls.md) | Server credentials, judge sessions, allowances, rate limits and emergency stop |
| [Hosting runbook](hosting-runbook.md) | Azure App Service configuration, verification and rollback |

## Validation and visual material

| Location | Purpose |
| --- | --- |
| [AI evaluation](ai-evaluation.md) | Current evaluation strategy, scenario coverage, offline/live distinction and Foundry cloud evaluations |
| [README screenshots](screenshots/readme) | Product screenshots referenced by the project README |
| [Design references](design-references/README.md) | Asset design targets; these are distinct from screenshots of the working product |

The app runs without this documentation folder. Keep these files with the
public source so judges and maintainers can understand and verify the project.
