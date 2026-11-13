# Operations and recovery

Scope: an instance's booking Worker in `apps/booking`, at `<PUBLIC_ORIGIN>`.
State lives in three SQLite-backed Durable Object namespaces:

| Binding | Class | Holds |
| --- | --- | --- |
| `LIVE_HOSTS` | `LiveBookingHost` | One object per host: settings, calendar accounts (encrypted OAuth tokens), bookings, email jobs, receipts, metrics, operational evidence |
| `AUTH` | `AuthStore` | OAuth state, browser/device sessions, rate limits, host registry, watchdog cursor |
| `HOSTS` | `BookingHost` | Local demo only |

External state that a storage restore **cannot** roll back: Google Calendar
events (and Google's own invitation emails), and application emails already
accepted by Cloudflare Email Sending or Resend.

## What is and is not verified

| Item | Status |
| --- | --- |
| Owner operational status (`GET /api/live/operations`) | Implemented; unit + workerd route tests |
| Parked-email resolution (`POST /api/live/operations/deliveries/resolve`) | Implemented; unit + workerd route tests; never sends |
| Restore quarantine (`quarantineDeliveriesAfterRestore`) | Implemented as a host RPC; **not routed**; unit tested. Also runs automatically when the maintenance fence detects a rollback (below). |
| Maintenance fence (`POST /api/live/operations/maintenance`) | Implemented: owner session, same origin, rate limited. Freezing blocks calendar writes, email sends and guest changes from requests, alarms, manual repair and the cron watchdog. `tests/maintenance.test.mjs` (Node SQLite) and `tests/maintenance.integration.mjs` (workerd through the real Worker, `LiveBookingHost` and `AuthStore`). **Not exercised on Cloudflare.** |
| Rollback detection at host start | Implemented: before any request or alarm, the host compares its storage epoch with the authoritative fence in `AUTH`. Older storage quarantines every queued email and stays frozen. Verified with Node SQLite snapshots and a workerd drill that rolls back only the `LiveBookingHost` persistence directory. Not verified against Cloudflare PITR. |
| Restart drill on workerd SQLite | `tests/operations.integration.mjs`: persisted state survives runtime restart; parked send not replayed; lost calendar create recovered by deterministic GET with no second insert |
| File-level snapshot/restore drill | Same file plus `tests/operations.test.mjs`: copy of SQLite state restored into a fresh runtime/ledger; guest capability still valid; wrong key refuses to send and reports `delivery_overdue` |
| Cloudflare point-in-time recovery (PITR) | **Not tested.** PITR is unsupported in local workerd (it returns an all-zero bookmark, which status reports as `null`). No production restore has been run. |
| Restore bookmark RPC/route | **Not implemented.** Needs a reviewed one-off deployment (see below). The fence removes the need for that build to run quarantine itself. |
| Status UI | Studio's Troubleshooting view (`/studio#status`, below the account controls) shows issues, counts, the fence state and parked emails, and records delivered/not-sent outcomes with an explicit provider-check confirmation (`tests/scheduling-quality-browser.spec.js`, mocked APIs). Freeze, resume and release stay JSON-only. Booking email activity labels resolved receipts as **Marked delivered** / **Marked not sent**, explaining that they are operator assertions rather than independently verified delivery. |

Run the drills:

```sh
cd apps/booking
node --test tests/operations.test.mjs tests/maintenance.test.mjs
npm run test:runtime   # includes operations/maintenance integration drills and the lifecycle tests
```

## Health and status

- `GET /api/health` is public and returns only `{"ready":true}`. It means the
  configuration exists. It does **not** show that calendars, email or alarms work.
  Keep it minimal.
- `GET /api/live/operations` requires the owner's browser session. It returns
  `Cache-Control: no-store` and is scoped to that owner's host object.

The status response contains only counts, ages in milliseconds, fixed codes,
booking IDs and email job IDs (`<bookingId>:<version>:<kind>`). It never
contains guest names, emails or answers, management tokens or their encrypted
recovery copy, OAuth tokens, frozen email payloads, provider responses or raw
error text. Booking IDs alone do not let anyone manage a booking: that needs the
capability in the guest link's fragment.

All aggregates are computed by SQLite. JavaScript sees at most 20 attention
samples, 20 review items and 500 classified email jobs. `truncated` flags say
when a list is partial. The count of parked emails is always exact.

Key fields:

| Field | Meaning |
| --- | --- |
| `healthy` | `false` when any issue is `warning` or `critical` |
| `issues[]` | `{code,severity,count,message,action}`, ordered by severity |
| `bookings.pending` / `.cancelling` | `count`, `oldestAgeMs`, `stale`, `inFlight` (calendar lease held), `authorization`, `ageEstimated` (records written before transition timestamps; age measured from creation) |
| `calendarSync` | Confirmed upcoming bookings: tracked, pending re-check, overdue (more than 60 min late) |
| `deliveries.byStatus` | Same status vocabulary as booking email activity |
| `deliveries.review.items[]` | Parked emails: `jobId`, `kind`, `recipientRole`, `reason`, `provider`, `attempts`, `firstAttemptAt`, `updatedAt`, `resolvable`, `releasable` |
| `maintenance.lastAlarm.state` | `completed`, `failed` (with code), `running`, or `interrupted` (started more than 20 min ago with no completion recorded). A run that is running or was interrupted is never shown as completed. |
| `maintenance.lastWatchdogAt` | Last time the 5-minute cron reached this host. The cron handles 20 hosts per tick, so the interval grows with the number of hosts. |
| `storage.bookmark` | Current PITR bookmark on deployed objects, `null` locally |
| `outbound.frozen` / `.epoch` / `.reason` | Maintenance fence. `reason` is `operator`, `restore_detected`, `fence_mismatch` or `fence_unavailable`. Use `epoch` as `expectedEpoch` when freezing or resuming. |
| `outbound.inFlight` | `{calendar,deliveries}`: leases held by a provider call that started before the freeze. Wait for both to reach 0 before recording a restore point. |
| `outbound.lastRestoreDetected` | `{at,storageEpoch,fenceEpoch,quarantined}` for the most recent detected rollback |

### Issue codes and first actions

| Code | Severity | Action |
| --- | --- | --- |
| `calendar_authorization` | critical | Reconnect the Google calendar in Settings, then `POST /api/live/repair`. |
| `delivery_review` | critical | Follow "Uncertain email sends" below. |
| `restore_quarantine` | critical | Follow "After any restore" below. |
| `restore_detected` | critical | Host storage started older than its fence. Queued emails were quarantined and outbound work is frozen. Follow steps 5–6 of the restore procedure. |
| `outbound_paused` | warning | The host is frozen. Expected during maintenance; `alarm_missing` and `maintenance_stale` are suppressed while frozen. |
| `alarm_missing` | critical | Active work exists but no alarm is set. Run repair. If it comes back, check Worker logs for `booking_maintenance_failed`. |
| `maintenance_failed` | critical | Check `booking_maintenance_failed` logs, fix the cause, run repair. Alarms retry automatically. |
| `pending_stale` | warning | Pending for more than 10 min. Check calendar authorization and Google status. The guest's hold remains. Repair will reconcile it with a deterministic event GET and never inserts a second event. |
| `cancelling_stale` | warning | Same checks. Do not delete the Google event by hand while it is `cancelling`: the ledger deletes only events it owns, using an etag. |
| `confirmed_sync_overdue` | warning | Re-checks are late, so reminders for those bookings stay paused. Check authorization and account cool-down (`accounts.coolingDown`). |
| `delivery_retrying` | warning | Retrying for more than 1 h. Check provider status and `MAIL_FROM`. |
| `delivery_overdue` | warning | Overdue for more than 30 min and never attempted. The likely cause is sender configuration, or a `TOKEN_ENCRYPTION_KEY` that does not match the stored data, which stops messages from being prepared. |
| `maintenance_interrupted` / `maintenance_stale` | warning | Run repair and check logs. Repeated interruptions point to a provider call that hangs. |
| `booking_failed` | info | Open each listed booking. The guest may need a new time. |
| `job_scan_truncated` | info | More than 500 queued emails, so per-status counts are partial. |

`POST /api/live/repair` (owner session, same origin) runs one maintenance pass.
It is safe to repeat: every step is lease-guarded and idempotent. While the
host is frozen it returns `503` with `code: maintenance_frozen` and does nothing.

## Maintenance fence (freeze outbound work)

```http
POST /api/live/operations/maintenance
Origin: <PUBLIC_ORIGIN>
Content-Type: application/json

{"action":"freeze"|"resume","expectedEpoch":<outbound.epoch>}
```

While frozen, for that host only:

- No Google Calendar insert, patch or delete, and no email send, from any entry
  point. Requests, alarms, manual repair and the cron watchdog are all gated,
  and the provider clients themselves refuse writes as a last line of defence.
  A frozen host never records a send attempt, so nothing is parked by the freeze.
- Guests get `503 maintenance_frozen` for availability, booking, reschedule and
  cancel. Existing guest links can still view their booking. Owner approval
  decisions are refused too.
- Reads still work: owner settings, availability preview (Google free/busy),
  calendar listing, booking lists and operations status. Settings edits are
  stored but any resulting email waits until resume.
- Alarms do no work and are not rescheduled; resume schedules one.

A provider call that already started before the freeze cannot be cancelled.
`outbound.inFlight` shows active leases, not proof of provider completion. Leases
expire and opaque email bindings can still accept a message after a local
timeout. Reconcile ambiguous provider outcomes even when the lease count is zero.

`expectedEpoch` must match the current `outbound.epoch` (409 otherwise), so a
stale page cannot undo a newer freeze or a detected restore. Resume is refused
with `409 restore_quarantine` while any email quarantined after a restore is
unresolved.

How rollback detection works: each transition increments an epoch. Freeze closes
the host gate before publishing to the authoritative copy in `AUTH`
(`operations-fence:<hostId>`). Resume publishes to `AUTH` before opening the local
gate; publication failures leave the host frozen. A host restore does not roll
back the authoritative copy. On every
start, before any handler or alarm runs, the host compares the two. Host storage
older than the fence means a restore or rollback: every queued email is
quarantined in the same transaction that marks the host frozen with reason
`restore_detected`, and the `booking_restore_detected {quarantined}` log event is
written. A restore point taken while already frozen at the same epoch needs no
blanket quarantine, but pre-freeze calls may still complete later. Persisted
ambiguous Cloudflare attempts are parked instead of replayed after resume.
If `AUTH` is unreachable, the host fails to start rather than running unchecked.
An interrupted resume with `AUTH` ahead is conservatively quarantined and frozen.
A host ahead of the fence republishes only a closed gate; an unacknowledged open
gate is frozen and quarantined. Restoring `AUTH` itself is not covered by this check.

## Logs and tracing

Structured log events carry fixed codes and counts only:
`booking_request_failed`, `booking_reconciliation_failed`,
`booking_delivery_parked {kind,reason,provider}`,
`booking_delivery_resolved {kind,outcome,provider}`,
`booking_maintenance_failed {code}`, `booking_restore_quarantine {count}`,
`booking_restore_detected {quarantined}`, `booking_maintenance_fence {frozen}`,
`booking_maintenance_fence_failed`,
`booking_watchdog {checked,failed,wrapped,codes?}`.
No host, booking or job IDs, recipients or provider bodies appear in them.

Configuration (`wrangler.jsonc`): logs on, `invocation_logs: false`,
`redact_query_string: true`, **traces disabled**. Keep traces disabled.
According to Cloudflare's current spans-and-attributes reference, fetch-handler
spans record `url.full`, and subrequest spans record `url.full` and `url.query`,
with no documented redaction controls. With tracing on, this would capture:

- OAuth callback URLs (`?state=…&code=…`).
- Google Calendar subrequest paths, which carry calendar IDs (email addresses)
  and event IDs.
- Public booking and management paths that carry host and booking IDs.

Guest management capabilities stay in URL fragments, which never reach the
Worker. Even so, we cannot show that traces would be free of sensitive values,
so do not enable them.

## Uncertain email sends (parked delivery review)

A job parks (`needs_review`) when a provider call might have succeeded:
timeout, malformed success, an in-flight Cloudflare send interrupted by
eviction, a Resend attempt older than 23 h, a superseded or expired attempted
message, or a configuration rejection. Parked jobs keep their exact encrypted
payload and idempotency key. They are never retried automatically, and they
block retention of their booking.

Procedure:

1. `GET /api/live/operations`. Note each item's `jobId`, `kind`, `provider`,
   `firstAttemptAt` and `updatedAt`.
2. Look up provider activity near `firstAttemptAt`:
   - Resend: the dashboard or API, filtered by the idempotency key (which is
     the `jobId`) or by time and recipient.
   - Cloudflare Email Sending: the account's email sending activity for the
     sender address, around that time.
   Use the host booking detail (Studio) to see which guest the job targets. Do
   not copy guest data or the management link into tickets.
3. Decide, then record the decision:
   ```http
   POST /api/live/operations/deliveries/resolve
   Origin: <PUBLIC_ORIGIN>
   Content-Type: application/json

   {"jobId":"…","outcome":"delivered"|"not_delivered","expectedUpdatedAt":<updatedAt>}
   ```
   - `delivered`: the provider shows the message as accepted. The receipt
     becomes `sent` (using `firstAttemptAt` as the time) with
     `resolution: operator_asserted_delivered`. A follow-up also gets its
     `followUpSentAt` set.
   - `not_delivered`: there is no provider record. The receipt becomes
     `cancelled` with `resolution: operator_asserted_not_sent`. **Nothing is
     re-sent.** If the guest still needs the information, the host contacts
     them from their own mailbox. Do not paste the management link anywhere
     except in a direct message to the guest.
   - Every resolution is recorded with `resolutionEvidence: operator_assertion`.
     It is the operator's statement, not proof that the provider delivered.
4. The request returns 409 if the job changed, is leased, or is no longer
   parked. Refresh and review again.

Never replay a parked job under a new key, edit its payload, or "fix" it by
changing the provider. That risks a duplicate send.

## Secrets and key recovery

| Secret | If lost | Recovery |
| --- | --- | --- |
| `GOOGLE_CLIENT_SECRET` | Sign-in and token refresh fail (`calendar_authorization`) | Rotate in Google Cloud, then `npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.instance.generated.json` in `apps/booking` (stdin). Without `--config` it targets the neutral shared Worker, not this instance. Stored refresh tokens remain valid for the same client ID. |
| `TOKEN_ENCRYPTION_KEY` | Calendar refresh tokens, guest-link recovery copies and frozen email payloads cannot be decrypted. AES-GCM binds each value to its host ID. There is a single `v1` key with no rotation support. | See below. |
| Resend API key | Resend jobs retry and then park | Rotate and re-put. Parked jobs still need review. |

Store `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) in the team password
manager **before** the first deployment. Cloudflare secrets cannot be read back.
Never change it to "fix" errors: a different key does not decrypt existing data.
The drill shows that a wrong key refuses to send and reports `delivery_overdue`.

If the key is truly lost:

1. Put a new key. Existing guest management links still work, because they are
   checked against hashes, not ciphertext.
2. Reconnect every Google calendar (OAuth) so that refresh tokens are re-encrypted
   with the new key.
3. Queued emails for existing bookings cannot be prepared. Their management
   links cannot be recovered, and frozen payloads cannot be decrypted. They show
   as overdue or parked. Resolve them as `not_delivered` and have the host
   contact affected guests directly.
4. Booking a new meeting works normally.

Key rotation (re-encrypting under a new key while the old one is still known)
is **not implemented**. It needs a versioned-key change; do not attempt it by hand.

## Switching to a new Google OAuth client

Operator-run. Use this to move an instance to a different Google OAuth client,
for example one in a Google project whose consent screen carries the service's
own name. If the current client's project serves only this instance, renaming
its consent screen app is enough and nothing below is needed.

What carries over:

- **Hosts keep their profile, booking links, bookings, workspaces and
  settings.** A host ID is derived from the Google account ID (`sub`), which is
  the same under every OAuth client, so signing in through the new client opens
  the same host.
- **Browser sessions and desktop connections keep working.** Scheduling issues
  them, not Google.
- **Calendars must be reconnected.** Stored refresh tokens belong to the old
  client, and Google refreshes them only for that client. Each calendar keeps
  working until its current access token expires (within an hour). After that,
  guests can't book times that depend on it and calendar updates wait.
  Reconnecting keeps the calendar's destination and conflict choices and resumes
  the waiting updates.
- A sign-in that was in progress at the switch fails at the callback; start it
  again.

Before switching:

1. Create the new client as in
   [step 3 of the self-hosting guide](self-hosting.md#3-create-the-google-oauth-client):
   Google Calendar API enabled, the same scopes, and the single redirect URI
   `<PUBLIC_ORIGIN>/auth/google/callback`.
2. Set the new app's publishing status to **In production**. While it is in
   *Testing*, Google expires refresh tokens after seven days, so every calendar
   would disconnect a week after it is reconnected, and only listed test users
   can sign in. Until Google verifies the app, hosts see an unverified-app
   warning when they connect a calendar and Google caps it at 100 users.
3. Tell every host, and every team member who contributes a calendar, when to
   reconnect. Only the calendar's owner can reconnect it.

Switch, with the instance's merged config. Run `npm run instance:config` (set
`SCHEDULING_INSTANCE_CONFIG` to your overlay if it is not
`wrangler.instance.jsonc`) and check that it prints your Worker's name:

```sh
cd apps/booking
npx wrangler secret put GOOGLE_CLIENT_ID     --config wrangler.instance.generated.json
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.instance.generated.json
```

Run the two commands back to back: each one takes effect when it completes, and
sign-in fails while only one of the two has changed. No code deployment is
needed.

After switching:

1. Sign in to Studio. The same booking links should be there.
2. In Studio, Calendars, connect each Google calendar again with the same
   Google account and allow calendar access. It must update the existing entry.
   If a second entry for the same address appears, stop and check which one your
   booking links use before removing anything.
3. Check that Troubleshooting shows no `calendar_authorization` issue, then
   book and cancel one test meeting.
4. Keep the old client until every calendar is reconnected. To roll back, put
   the old client ID and secret back: calendars not yet reconnected work again,
   and calendars reconnected under the new client then need reconnecting once
   more.

## Backup and restore

### Backups available

- **Durable Object PITR**: Cloudflare keeps 30 days of history for every SQLite
  object. A restore covers the whole object (SQL and KV) and affects only that
  object. Restoring one host does not restore `AUTH` (sessions, registry).
- No export job exists. There is no off-platform backup. For a portable copy,
  a reviewed export endpoint would be needed (not implemented).

Before risky changes (migrations, bulk settings), record `storage.bookmark`
from the operations status, together with the time and the deployed version.

### Restore procedure (requires a reviewed deployment)

The Worker has no restore route by design. The Worker already has the outbound
guard and startup quarantine; the one-off build only needs the bookmark call.
Neither has been exercised against Cloudflare PITR.

1. Freeze: tell the host, then `POST /api/live/operations/maintenance` with
   `{"action":"freeze","expectedEpoch":<outbound.epoch>}`. Require a successful
   response: status alone can show a locally closed gate after a failed fence
   publication, which is insufficient for restore safety. Confirm the status
   shows `outbound.frozen: true` and wait for `outbound.inFlight` to reach
   `{calendar:0,deliveries:0}`.
2. Choose the target: a recorded bookmark, or a time no more than 30 days ago.
3. Deploy a one-off reviewed build. For the single affected host object, it
   must call `await ctx.storage.getBookmarkForTime(t)` (or use the recorded
   bookmark), then `const undo = await ctx.storage.onNextSessionRestoreBookmark(b)`,
   record `undo` outside the host (its own storage is about to be replaced), and
   call `ctx.abort()` so the object restarts and restores. Gate this behind owner
   auth plus an explicit host ID, refuse unless the host is frozen, and remove it
   afterwards.
4. On restart the fence check runs before any handler or alarm. A target older
   than the freeze makes the status show `restore_detected` and
   `restore_quarantine`, with every queued email parked with reason `restored`.
   Every one of them may already have been sent after the restore point; this
   matters most for Cloudflare `send_email`, which does no deduplication. If the
   target was taken after the acknowledged freeze, the host restarts frozen
   without blanket quarantine; pre-freeze in-flight calls may still complete,
   so reconcile every ambiguous attempt. If the status shows the
   host unfrozen, stop: the fence did not engage.
5. Reconcile external state:
   - Calendar: events created after the restore point are orphans (booking row
     gone), so review them in Google Calendar. Bookings that were cancelled after
     the restore point come back as active, so check them against the calendar
     and cancel through the host flow where needed. Pending creates reconcile
     automatically by deterministic event ID, without a second insert.
   - Email: for each quarantined job, check provider activity since the restore
     point, then resolve it as `delivered` or `not_delivered`, or release it:
     `{"jobId":…,"outcome":"release","expectedUpdatedAt":…}`. Release is allowed
     only for jobs never attempted in the restored state. **That does not prove
     they were never sent after the snapshot.** Release only after reconciling
     provider activity for the entire interval; leave unknown outcomes parked.
     Release retains the original job key and any frozen payload and schedules
     work for a subsequent maintenance pass; it does not send in the request.
6. Resume with `{"action":"resume","expectedEpoch":<outbound.epoch>}` (refused
   while quarantined emails remain), run repair and confirm the status shows no
   critical issues.
7. To undo a wrong restore, restore to the `undo` bookmark returned in step 3.

Do not restore `AUTH` unless sessions or the registry are themselves corrupted.
Restoring it can bring back revoked browser and device sessions. Keep public
access disabled until those credentials are invalidated; revoking them after
traffic resumes leaves a window of restored access. This recovery path is not
implemented or accepted by the current release.

### Drill evidence (local, isolated)

`tests/operations.integration.mjs` runs in workerd via Miniflare:

1. It persists state: one confirmed booking with a parked unknown send, and one
   pending booking whose create response was lost.
2. It copies the persistence directory as a snapshot.
3. It restarts on the original state: no replay, the pending booking reconciles,
   and there is still one calendar insert.
4. It wipes the object and restores the snapshot into a fresh runtime: the
   pending booking is back and reconciles again without a second insert, the
   parked send stays parked, the guest link still works, and resolution records
   an operator assertion.

Calendar and mail mocks live outside the object, so the restore cannot roll
them back. This exercises ledger restart and restore semantics only. It is not
PITR and not production.

Maintenance fence drills (local only):

- `tests/maintenance.test.mjs` (Node SQLite, 6 tests): a frozen host makes no
  calendar write or email send from alarm, watchdog, manual repair, booking,
  cancel, reschedule, approval, guest availability, `processJob` or direct
  provider calls, and records no send attempt; resume needs the reviewed epoch
  and then sends each queued email exactly once. A SQLite backup taken before a
  send and a freeze, restored into a fresh ledger with the same external fence,
  quarantines both queued emails, sends nothing, refuses resume until both are
  resolved or released, and after resume reaches the provider exactly once per
  original key. A restore point taken while frozen is not quarantined; older
  points are detected after several transitions. An unreachable fence refuses
  transitions and start-up checks; an interrupted transition stays frozen and
  catches up without quarantine.
- `tests/maintenance.integration.mjs` (workerd, real Worker/`LiveBookingHost`/
  `AuthStore`): freeze/resume require an owner session, same origin, exact keys
  and the reviewed epoch; frozen repair and guest availability return 503; a
  restart on unchanged storage detects nothing; replacing only the
  `LiveBookingHost` persistence directory with an earlier copy makes the next
  start report `restore_detected` and frozen, with no outbound requests.

A mutation check (disabling the `processJob` fence gate) made the Node suite
fail, so the tests depend on the gate rather than on incidental behavior.

## Remaining external gates

- No production PITR restore has been run. That needs an approved maintenance
  window, plus the one-off restore build described above. The maintenance fence
  and rollback detection are verified only locally (Node SQLite and workerd),
  not on Cloudflare.
- Studio has no freeze/resume or release control; those are operated through
  the JSON endpoints only.
- Provider-side reconciliation (Resend and Cloudflare activity lookups) is manual.
- No off-platform backup export exists, and `TOKEN_ENCRYPTION_KEY` rotation is
  not supported.
- Alerting on the log events above is not configured. Workers Logs exist, but no
  alert rules.

## Self-service account deletion

Studio → account menu → Manage account → Delete account opens a read-only impact
check and offers Export data before confirmation. Opening this dialog does not
start deletion. An accepted confirmation closes browser and desktop access
immediately. Old/revoked credentials continue to return HTTP 401; the separate
random status receipt permits only that deletion's status. It cannot sign in,
export data, select another account or authorize another deletion. The receipt
stays in the requesting browser tab's session storage and never in a URL.

### Dependencies and guest safety

This release **blocks confirmation** while the account owns any other booking
profile. Transfer ownership through Team first, including a profile with no other
members (invite a successor before transferring). Account deletion does not delete
an entire shared profile or its colleagues' accounts. There is no implicit
company/profile deletion action in this release.

Upcoming confirmed bookings, pending approval/create/cancel/replacement work,
unknown external effects and unacknowledged account writes block confirmation.
Existing booking controls must resolve those first; their normal calendar notices
remain in effect. Deletion itself does not send cancellation email or erase a
calendar event while guests still rely on it. A person must stop sharing connected
calendars with other profiles first; future/pending bookings involving even a
withdrawn connection must still be resolved. Older connections with ambiguous
ownership must be disconnected by that profile's administrator before confirmation.
Every known hosted ledger is inspected, including other individuals' profiles,
not only company records.

After fencing, the job removes non-owner memberships and invitations addressed to
that account. It erases the person's disconnected, proven-owned calendar rows and
private hours/preferences from other profiles and pauses affected booking links.
Those profiles retain their own past guest/booking business records under their
own authority; they are not part of the deleted account's personal host. No other
member's credentials, personal host, calendar preferences or bookings are purged.

### Exact active-store erasure and timing

The deadline is **one calendar month after an accepted confirmation**, clamped to
the last day of the following month when needed. The safe status response includes
`requestedAt` and `deleteBy`. The user remains in `fencing` or `needs_review` while
work is unresolved. A deadline never turns unknown outcomes into success and never
causes evidence to be discarded. Operations must resolve review cases before this
deadline; an overdue request is an incident, not a completed deletion.

| Data | Treatment after accepted confirmation |
| --- | --- |
| Personal host profile, picture/banner, booking links, schedules and preferences | Erased after the host fence and drain acknowledge. Only a minimal host ID and terminal fence remain. |
| Personal-host booking/guest rows, calendar/account metadata, encrypted Google grants and cached coordination data | Erased in the same acknowledged host purge. Future/unresolved bookings cannot reach this stage. Google-hosted calendar events remain in Google. |
| Queued personal notifications, follow-ups, integrations, delivery receipts, metrics and quota history | Suppressed by the fence, then erased with the host after uncertain sends/writes are accounted for. |
| Identity/email record, browser/desktop registries and token lookup objects | Authentication is rejected immediately; indexed and legacy-inventoried state is physically removed in acknowledged batches. |
| Account-associated pending OAuth/device handoffs and export cursor plans | Fenced against use/replay, then physically removed. New anonymous handoffs physically expire on their existing short alarm deadline; they contain no signed-in account identity. |
| Tracking records/history and pixel lookup state | Counting stops under the identity fence. Indexed and legacy-inventoried records/pixels are physically removed in acknowledged batches. |
| Account discovery/contribution indexes and personal inventory metadata | Removed only after their destinations and cleanup batches acknowledge. |
| Membership and disconnected owned calendar preferences in other profiles | Detached as described above. Other profiles and their independent records remain. |
| Lifecycle/cleanup receipts | Minimal pseudonymous operation IDs, generation/fence, receipt hash, timestamps and cleanup digest/cursor survive to prevent stale grants or restored hosts from recreating access. No email, token, guest data or private manifest remains after completion. |

Deletion normally completes during confirmation or subsequent background retries.
The lifecycle Durable Object retries unfinished work every minute; the existing
five-minute watchdog is a backup. A failed/unknown storage response is retried with
the same operation and batch cursor. The public status becomes `deleted` only
after host and AUTH cleanup acknowledge. Cancelled pre-Begin attempts leave the
account active and do not stop normal watchdog maintenance.

Google authorization is **not revoked project-wide** by this control: deletion
removes locally held grants. Users can remove Google's authorization separately
in their Google account. This avoids revoking a different client in a shared
Google Cloud project or another person's consent.

### Legacy inventory and recovery operations

Run the operator inventory once per instance, after its first deploy. Until it
has run, account deletion says "Account data inventory is being prepared". It
runs against the deployed `AccountDataOperator` service-binding entrypoint, has
no HTTP admin route and requires the operator's Cloudflare account credentials:

```
cd apps/booking
npm run instance:config                     # merges wrangler.instance.jsonc
node scripts/account-inventory.mjs          # read-only audit
node scripts/account-inventory.mjs --apply  # publish discovery proofs, never purge
```

If `getPlatformProxy` stalls in the installed Wrangler version, stop that run
and use the bounded loopback transport instead. In a separate terminal run
`node scripts/account-inventory-bridge.mjs`. Once its temporary authenticated
preview is ready on `127.0.0.1:8879`, run the two audit/apply commands with
`INVENTORY_OPERATOR_URL=http://127.0.0.1:8879`. Stop the preview afterwards.
This creates no persistent Worker or public production endpoint. HTTP requests
are bounded to 30 seconds; interrupted scans cannot seal completeness.

The scan enumerates the complete existing AUTH and LIVE_HOSTS namespaces via the
Cloudflare API, inspects only minimal ownership/reference projections, backfills
host discovery and seals per-account legacy object manifests. It never prints or
exports token bodies, guest data or secrets. New writes reserve their account
index before dispatch. New post-scan accounts use an empty legacy manifest only
when the sealed baseline proves they were not legacy hosts. Missing, interrupted,
changed or ambiguous inventory fails closed; it cannot prove erasure.

Review pending deletion status at least daily, including `deleteBy`; investigate
unknown provider/auth effects using preserved evidence rather than guessing from
lease expiry. Keep production access disabled during storage restoration. Restore
operators must reapply completed lifecycle tombstones before reopening service;
a host-only restore test does not certify arbitrary AUTH+HOST restoration.
Cloudflare recovery history is separate from active storage and may retain older
copies for up to 30 days. Do not quote the active-store completion timestamp as
proof that every provider recovery copy was immediately erased. Operational logs,
independently held company records and recovery copies need their stated separate
retention in the privacy policy.

Suggested privacy wording: “You can request deletion in your account settings.
We delete your account data from active storage within one calendar month of an
accepted request. We may first ask you to resolve upcoming bookings or transfer
ownership of a shared profile. Other organizations' independent records and
provider recovery copies follow the retention periods described in this policy.”

Do not delete a real person's account to test a release; mocked destructive
tests are the acceptance path.
