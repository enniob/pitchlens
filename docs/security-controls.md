# Explanation access and usage controls

The browser calls the existing Next.js backend. Only that backend calls
Microsoft Foundry. No additional server is needed for the local application.

## Access

Access defaults closed. Set separate random `PITCHLENS_JUDGE_ACCESS_CODE`
(16–256 characters) and `PITCHLENS_SESSION_SECRET` (at least 32 characters)
in ignored `.env.local` or the hosting secret store. Generate each with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
Share only the access code privately with authorized viewers.

The header's **AI access** dialog sends the code to same-origin `POST /api/session`. The server
sets a signed 30-minute cookie with HttpOnly, SameSite=Strict and Path=/api;
Secure is required in production and on HTTPS. GET reports status without
credentials; DELETE clears the browser cookie. Mutations require the exact
Origin header. The code is never saved to browser storage.

Cookies are stateless: clearing a browser cookie does not revoke a copied one.
Rotate the signing secret to invalidate all sessions. Rotating only the access
code prevents new logins with the old code, but existing cookies remain valid.
A shared code is suitable for controlled judge access, not individual accounts.

`PITCHLENS_ACCESS_MODE=local` explicitly allows development without a session.
Production rejects that mode. Optional machine bearer access remains available
with `PITCHLENS_EXPLAIN_ACCESS_TOKEN`; never put that token in frontend code.
The `dev` and `start` scripts bind to loopback by default.

## Abuse controls

- Login attempts share five attempts per minute per process and two concurrent
  body reads. Forged forwarding headers cannot obtain new attempt buckets.
- Explanation ingress allows 60 requests per identity and 240 per process per
  minute, with 16 concurrent body reads. Bodies are bounded to 4 KB for
  explanations and 1 KB for sessions, with a five-second deadline and client
  cancellation. Model workflow limits remain six per identity and 60 per
  process per minute, four concurrent globally, one per session.
- Defaults allow 30 uncached workflows per session and 1,000,000 charged tokens
  per UTC day per process. Each workflow reserves its full 80,000-token maximum
  before starting, then settles reported or conservatively estimated usage.
  Failures retain the full reservation and count against the session quota.
  Cache hits require access and ingress admission but spend no model allowance.
- `PITCHLENS_DAILY_TOKEN_BUDGET` and `PITCHLENS_SESSION_EXPLANATIONS` accept
  positive integers. A daily allowance smaller than the workflow reservation
  admits no new workflows. Pending reservations survive a UTC day rollover.
- `PITCHLENS_EXPLANATIONS_DISABLED=1` rejects subsequent requests, including
  cache hits. Restart/reload the server when changing its environment. The
  switch does not cancel model calls already running.

## Browser policy

Responses include nosniff, framing denial, a strict referrer policy, and disabled
camera, microphone, geolocation and payment permissions. Pages use a fresh
script nonce and CSP on every dynamic render. Production disallows script
unsafe-eval; development permits it for the Next.js runtime. Inline styles
remain allowed for React/Three.js layout. Dynamic page rendering trades static
caching for nonce safety.

## Hosted deployment (Azure App Service)

The public app runs on one Azure App Service instance (Linux, Node.js 22),
deployed from `main` by `.github/workflows/main_pitchlens.yml`. The workflow
signs in to Azure with OpenID Connect; no Azure password is stored in the
repository. Foundry credentials, `PITCHLENS_JUDGE_ACCESS_CODE` and
`PITCHLENS_SESSION_SECRET` are App Service application settings. The app
runs with `NODE_ENV=production`, so local access mode is refused and the
session cookie is always `Secure`.

What the hosted app relies on:

- **HTTPS.** App Service terminates TLS. Turn on **HTTPS Only** so plain HTTP
  redirects to HTTPS.
- **The Host header.** Session logins require the browser's `Origin` to match
  the request's own origin, built from `Host`. App Service passes the public
  host through. After each change to the hosting setup, unlock **AI access** on
  the public URL to confirm login still works.
- **One instance.** Counters and the answer cache are in memory: restarts reset
  allowances, and each extra instance would get its own allowance. Do not
  scale out.
- **The kill switch.** Set `PITCHLENS_EXPLANATIONS_DISABLED=1` in the app
  settings to stop explanations; App Service restarts the app with the new
  setting.

What it does not provide:

- Allowances are application safeguards, not a durable billing cap or a
  distributed rate limiter. A new login obtains a fresh session quota. Prompt
  token estimates and provider usage can differ from billed usage. Set the
  Foundry deployment's quota to bound spending; Azure budget alerts notify but
  do not stop spending.
- There is no gateway in front of the app (such as Front Door or API
  Management), so connection and rate limits are the application's own
  per-process limits above.
- HSTS is not configured.
