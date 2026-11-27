# Scheduling service

A Cloudflare-hosted scheduler with the shared guest booking UI, Google Calendar availability, booking links and website embeds. Runs independently of the desktop app. Plain JavaScript/CSS; no external fonts or UI framework runtime.

## Status

Beta. The current source includes reusable/default schedules, date exceptions,
independent buffers, daily/weekly/monthly/yearly count and booked-time limits,
typed questions and additional guests, host approval, Google Meet, configurable
reminders, one optional post-meeting follow-up and host email activity. Per-link
writable destination calendars are supported; conflict selection remains
host-wide. Local test success is separate from live provider acceptance and
deployment.

## Local development

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:8788/studio`, `/book`, or `/site`. Without `.dev.vars`, these use isolated loopback-only fixture data. No Google events or messages are sent in this mode. Hosted routes do not expose the unauthenticated fixture API.

`public/` is the source for the browser app. Before `wrangler dev` and `wrangler deploy`, Wrangler runs `scripts/build-assets.mjs`. The script copies `public/` to the ignored `dist-assets/` and bundles the app's JavaScript and CSS into content-hashed files under `/assets/`, which browsers cache for a year. Every other file keeps its address, including `/embed.js`. Tests import the modules in `public/` directly.

For a connected local service, copy `.dev.vars.example` to ignored `.dev.vars` and supply a **separate Google Web Application** OAuth client (see [self-hosting](../../docs/self-hosting.md)). Its registered callback must match `PUBLIC_ORIGIN/auth/google/callback` exactly. Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32`; keep it stable and backed up securely. Losing it makes stored grants and recovery links unreadable. Never reuse desktop refresh tokens.

## Host and guest flows

- `/studio`: Google sign-in, meeting types, publishing, working hours/timezone, notice, buffer, intake question, appearance, link/embed copy, connected-account conflict calendars and bookings.
- `/b/:host/:meeting`: public availability and guest details, followed by a real Google invitation.
- `/manage/:host/:booking#capability`: view, cancel or reschedule. Capability is a random secret, not a login; treat this link as confidential. New calendar-event descriptions omit this private capability; guest management links belong in the primary guest's application email. Historical event descriptions are not rewritten. The secret stays in a fragment, never a query parameter.
- `embed.js`: inline iframe and popup dialog; the host console supplies the snippet. Guest iframe works without third-party login cookies. Popup supports Escape and focus restoration.

Google sign-in requests verified identity only. Connecting a calendar separately requests calendar-list read access, events access and free/busy access. Calendar connections retain the existing owner login instead of renewing it; fresh identity sign-in creates a seven-day HttpOnly session. Guests never receive calendar grants, busy-event contents or host administration access. Host mutations require the configured origin.

Each host's Durable Object owns all meeting types and connected-account conflicts. It persists a hold before calling Google, uses deterministic event IDs, and reconciles interrupted outcomes after eviction. A second request cannot allocate the same interval. Rescheduling secures a replacement before cancelling the original; overlapping the original interval is conservatively rejected. Existing bookings retain their original calendar snapshot when the host changes the destination.

## MCP

`/mcp` is a remote MCP server (Streamable HTTP, JSON responses) for running scheduling from an AI client. Add it by URL, for example `claude mcp add --transport http scheduling https://<your-origin>/mcp`; the client opens a browser to sign in with Google and approve access.

- Auth is OAuth 2.1: discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamic client registration at `/oauth/register`, authorization code with S256 PKCE at `/oauth/authorize` and `/oauth/token`. Nothing new is stored: client IDs and pending requests are sealed with `TOKEN_ENCRYPTION_KEY`, the code is an approved device grant and the access token is a 30-day desktop session with the `booking:manage` scope, so Studio revocation, lifecycle checks and account cleanup apply unchanged.
- Tools cover bookings (list, approve or decline, cancel, reschedule with free times), links (create, update, delete, free times), availability (weekly hours, date overrides, time zone), integrations (Slack, Discord, Twenty CRM and webhooks: connect, update, remove, test, retry), calendars, analytics and a raw settings patch. Pass `workspace` to act in a company workspace; the Studio's role checks and privacy projections apply.
- Every change an MCP client makes is recorded with the app's name and session. The Studio lists connected apps under **Settings → Connected apps**; each app's page shows its recent changes and can disconnect it. Changes are kept for 90 days, at most 500 entries per workspace.

## Desktop connection

The Email desktop app connects with a revocable PKCE device grant:

1. `POST /api/device/start` with `name`, `codeChallenge` (base64url SHA-256 of the verifier), `settingsWrite` (boolean, optional) and `scope` (string, optional). It returns `deviceCode`, `userCode`, `verificationUrl`, `expiresIn` and `interval`.
2. The person opens `verificationUrl`, signs in and approves. The page lists only the permissions in the requested scope.
3. `POST /api/device/token` with `deviceCode` and `codeVerifier` returns `accessToken`, `tokenType`, `expiresAt` and `scope`, which is exactly the requested scope.

| Request | Issued scope |
| --- | --- |
| `scope: "booking:read"` | `booking:read` |
| `scope: "booking:read booking:settings"`, `settingsWrite: true` | `booking:read booking:settings` |
| no `scope` (earlier Email builds) | `booking:read email:tracking` |
| no `scope`, `settingsWrite: true` | `booking:read email:tracking booking:settings` |

- `scope` must be one of the two strings above, exactly. Anything else returns 400, including the tracking scopes, `booking:manage` (MCP only) and a `scopes` array.
- When both are sent, `settingsWrite` must say whether `scope` contains `booking:settings`; otherwise 400.
- A grant with `booking:settings` needs the browser to send back the reviewed `approvedScope` and account email.
- `/api/device/tracking` requires `email:tracking`, so the requested scopes get 401 there. `/api/device/calendars` and settings writes require `booking:settings`.
- Credentials and pending grants with the earlier scopes stay valid.

Email records the same contract in its `contracts/scheduling.json`:

```json
"desktop_scopes": {
  "request_field": "scope",
  "connection": "booking:read",
  "settings": "booking:read booking:settings",
  "issued": "exactly the requested scope",
  "earlier_grants": ["booking:read email:tracking", "booking:read email:tracking booking:settings"]
}
```

## Notifications

Google invitation/update/cancellation delivery uses `sendUpdates=all`. Application email goes through Cloudflare Email Sending with a sender-restricted `EMAIL` binding and `MAIL_FROM`, or through Resend. It covers approval outcomes, confirmations/cancellations, configurable reminders and an optional post-meeting follow-up.

Notification jobs persist encrypted payloads, frozen sender/provider/content, retry leases and backoff. Unknown Cloudflare outcomes park for operator review instead of risking another send. Legacy Resend jobs retain their original route and pause before the provider's deduplication window expires. Calendar creation and email delivery are separate outcomes; a notification failure never creates another calendar event. Host booking results include notification issues for operational inspection.

## Deployment

`wrangler.jsonc` is shared, operator-neutral configuration: Worker code, the three SQLite Durable Object bindings and their migrations, the five-minute watchdog cron and observability (traces disabled). Each deployed instance adds its identity (Worker name, routes, `PUBLIC_ORIGIN`, sender, branding) through an instance overlay that `scripts/instance-config.mjs` validates and merges. Start from `wrangler.instance.example.jsonc` and follow [self-hosting](../../docs/self-hosting.md).

```sh
SCHEDULING_INSTANCE_CONFIG=wrangler.instance.jsonc npm run build:instance   # dry run of the merged config
SCHEDULING_INSTANCE_CONFIG=wrangler.instance.jsonc npm run deploy:instance  # deploy it
```

`npm run build` is a **dry run** of the shared config, not a deployment. Never deploy the shared config itself for an existing instance; it is the neutral `scheduling` Worker.

Install the Google client ID/secret and the encryption key with Wrangler secrets (stdin prompts; never command-line values or config files). Set `LIVE_ENABLED=true` only after they exist. The Web OAuth callback must use the deployed HTTPS origin. Keep all three Durable Object classes and migration tags. A five-minute watchdog supplements per-object alarms.

Run the tests below before deployment. After deployment, run `scripts/check-booking-deployment.py --origin <PUBLIC_ORIGIN>`, then verify unauthenticated admin denial, Google consent, calendar selection, live free/busy and a booking/cancel/reschedule acceptance flow using an explicitly agreed test guest. Google consent-screen testing restrictions still apply; this code does not make an OAuth app verified. Custom customer domains, Microsoft calendars and general multi-step follow-up sequences are not implemented here yet. Desktop setup uses a browser-approved PKCE device grant whose verification URL is built from `PUBLIC_ORIGIN`; Google credentials stay on the hosted service.

## Checks

```sh
npm test
npm run check
npm run test:runtime
npm run test:e2e
```

Unit tests cover policy/DST, grants, provider validation, concurrent booking admission, retries/eviction, capability access, cancellation/rescheduling races, retention and notification delivery. `test:runtime` builds and exercises the actual Worker/Durable Objects with mocked Google through HTTP, including OAuth replay, tenant isolation and the complete booking lifecycle. Browser tests cover live UI (mocked APIs), loopback reservation flow, responsive light/dark layouts and embeds. `BOOKING_BROWSER` selects an executable; `BOOKING_ENGINE=webkit` selects installed WebKit. Real-provider and regional performance checks remain separate acceptance work.
