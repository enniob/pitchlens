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

## Hosting work still required

Counters and cache are in memory: restarts reset allowances, replicas each get
their own allowance, and a new login obtains a fresh session quota. These are
application safeguards, not a durable billing cap or distributed rate limiter.
Prompt token estimation and provider usage can differ from billed usage.

Before public hosting, configure HTTPS, gateway connection/body/rate limits,
trusted proxy handling, shared durable counters if running multiple instances,
Foundry deployment quotas, billing alerts and operational monitoring. Azure
budget alerts alone do not stop spending. Configure HSTS at the HTTPS edge.
Validate session Origin handling behind the chosen proxy. Public hosting and
deployment are a separate delivery step.
