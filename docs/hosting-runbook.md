# Azure App Service deployment and rollback

PitchLens is deployed as a prebuilt Next.js package to Azure App Service on
Linux with Node.js 22. The reviewed deployment is `aaef1f3`; its successful
[workflow run](https://github.com/enniob/pitchlens/actions/runs/38450685813)
deployed the [public application](https://pitchlens-cubrekc4a8a0g8gp.westus3-01.azurewebsites.net/).

## Runtime settings

- Startup: `node node_modules/next/dist/bin/next start --hostname 0.0.0.0`.
  Next.js uses the hosting `PORT` environment variable. Local `npm start`
  deliberately binds to loopback and is not the hosting startup command.
- Set `SCM_DO_BUILD_DURING_DEPLOYMENT=false`; GitHub Actions supplies the build
  and dependencies, including the hidden `.next` output, in `release.zip`.
- Store Foundry configuration, the judge access code and the independent
  session-signing secret in App Service environment variables. Never put
  provider credentials in browser variables, the deployment zip or judge notes.
- Keep one instance while usage counters, pacing and answer caching remain
  process-local. Restarting resets those counters; they are not a durable
  billing cap. See [security controls](security-controls.md).

## Release verification

1. Check the build/deploy workflow's conclusion and exact source revision.
   Deployment success alone does not establish application readiness.
2. Load `/` over HTTPS and confirm that the scripted 3D demo boots.
3. Check `GET /api/session`, then sign in through **AI access**. Confirm an
   authenticated session and usable checked explanations in both audiences.
   Session availability alone does not prove model-provider readiness.
4. Follow the [judge walkthrough](judge-instructions.md), including generated
   playback, citation replay, backward seeking, audience changes and recap.
5. Confirm configured allowances permit the judge walkthrough. Check current
   App Service quotas, Foundry quota, billing alerts and failure logs in the
   hosting account. Do not log prompts, model drafts or credentials.
6. Keep the public app and supplied judge code available free of charge through
   November 10, 2026, 11:59 p.m. Pacific, as required for judging.

The deployed HTTPS, session API, independent audience workflows and cache
repeat checks passed; the precise current validation scope is in
[release readiness](release-readiness.md). Account-level alert settings and
future availability are owner responsibilities, not established by code tests.

## Rollback

Record the last verified source SHA before each release. To roll back code,
prepare a revert of the faulty change on a separate branch, run the offline
checks, review it, and merge only with owner authorization. The `main`
deployment workflow then rebuilds and deploys that version. Do not rewrite
published history or remove server environment settings as part of rollback.
Repeat the release verification steps and record the resulting revision.

For an immediate inference stop, an authorized operator can set
`PITCHLENS_EXPLANATIONS_DISABLED=1` and restart the app. Playback remains
available; already running calls may still finish. Re-enable only after the
underlying failure and deployment settings have been checked.
