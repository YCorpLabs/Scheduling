# Isolated remote SQLite PITR drill

The drill deploys a disposable, authenticated Cloudflare Worker that exercises
real SQLite Durable Object point-in-time recovery, the special undo bookmark and
the scheduling ledger's maintenance fence, then deletes its Worker and its three
namespaces. It touches no existing Worker, namespace, domain route, calendar or
mail provider. It last passed on 11 November 2026.

It tests **PITR mechanics only**. It does not certify a restore of real data, an
encryption-key backup, provider reconciliation, recovery objectives or a
production restore deployment.

## What ran

The fixture imports the actual `BookingLedger`, maintenance implementation and
`AuthStore`. It creates its own SQLite host, AUTH fence and external-effects
Durable Objects. The host constructor checks the external fence before accepting
handlers, matching the production startup boundary. It deliberately does not
expose the production Worker router or OAuth flows.

Calendar and email calls are injected mocks whose effects are persisted in a
separate object. They survive a host-only restore. A global fetch deny function
blocks accidental provider requests; there are no real provider credentials,
Email Sending binding, existing namespace bindings or custom-domain routes.
Every fixture action requires a generated bearer secret. Only synthetic
`example.test` identities are seeded. Traces and Worker observability are off.

Automatic fixture alarms are delayed beyond the drill window. The controller
explicitly invokes the genuine ledger alarm handler to test frozen/resumed
behavior. This does not test a real alarm firing autonomously after remote PITR.

## Observed acceptance

1. Created two synthetic confirmed bookings, two mock calendar events and two
   queued confirmation emails. Recorded a **nonzero real Cloudflare bookmark**,
   with both SQL and KV markers set to `baseline`.
2. Delivered one mock email and changed both host markers to `advanced`.
3. Received successful freeze acknowledgement, checked that the authoritative
   AUTH epoch matched, and verified zero active fixture leases. Scheduled a
   restore using `onNextSessionRestoreBookmark()`, saved its special undo bookmark
   outside the host, then restarted only the fixture host with `ctx.abort()`.
4. Observed both markers return to `baseline`. Startup reported
   `restore_detected`, remained frozen and quarantined both restored email jobs.
   External mock state still contained two calendar events and the previously
   delivered email. Frozen repair and guest availability were refused.
5. Reconciled each restored email against external mock evidence: marked the
   already-delivered job and released only the never-delivered job. Resume and
   manual alarm passes produced exactly two total email attempts and two unique
   accepted emails. Calendar insert attempts remained two. Duplicate attempts
   remained zero, and the original synthetic guest capability still worked.
6. Froze again and performed a **second real recovery to the special undo
   bookmark**. Both markers returned to `advanced`. The newer AUTH fence caused
   the remaining restored job to be quarantined. It had already been delivered
   after that restore point, so mock reconciliation marked it without sending.
   Resume left total email and calendar attempts unchanged, with zero duplicates.
7. Injected failure after AUTH acknowledged resume but before the host's local
   open-gate commit. The action returned an error; a fresh remote host session
   conservatively reported `restore_detected` and stayed frozen. No extra mock
   effect occurred.

A newly deployed `workers.dev` route can take a moment before it serves the
fixture, so the driver bounds its readiness probes instead of treating
deployment completion as proof that every edge can already invoke the Worker.

## Reproduce

Use an authorized Wrangler login and the installed booking dependencies.
The script uses the project's Wrangler, Python's standard library and a new
unique Worker name. It does not change login scopes
or billing, and it must never be edited to bind an existing namespace.

```sh
node scripts/booking-pitr-drill/local-check.mjs
CLOUDFLARE_ACCOUNT_ID='<authorized-fixture-account>' \
  python3 scripts/booking-pitr-drill/run.py
```

The local smoke checks only fixture authentication, synthetic effects and freeze
admission. Local workerd cannot prove real PITR. The remote driver creates a
private state directory outside Git and reports its location. Secrets are passed
through a protected JSON secrets file rather than command arguments. Successful
and failed drill paths retire only the new fixture classes, then delete only the
uniquely named fixture Worker. If cleanup fails, inspect the protected logs and
finish that exact fixture's cleanup; do not delete unrelated resources.

## Limits before a production recovery

- No real booking data or production secret was backed up or restored. The
  fixture used a new disposable encryption key kept outside the host.
- AUTH was **not restored**. Restoring AUTH can resurrect sessions or roll back
  the authoritative fence and requires a separate isolated recovery procedure.
- Mock acceptance is not evidence of real Google/Cloudflare email delivery,
  cancellation, late provider acceptance, orphan-calendar reconciliation, backup
  export or an off-device encryption-key recovery.
- No pre-freeze opaque provider call was in flight during this remote run.
  Expired leases do not prove a provider rejected or stopped an earlier call.
  Real recovery still requires provider reconciliation; the separate local
  regression covers a late accepted Cloudflare send in a frozen snapshot.
- The fixture's host wrapper injects mocks and defers automatic alarms. It does
  not validate an authenticated production restore route, the production
  deployment process, application alerts or a maintenance window.
- No claim is made about recovery time or data-loss objectives from one drill.

Cloudflare documents that PITR restores SQL and KV together and is unsupported
in local development; the restore API returns the special undo bookmark.
See the [SQLite/PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
and [abort semantics](https://developers.cloudflare.com/durable-objects/api/state/#abort).
Cleanup uses [declarative class deletion](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class).
The readiness symptom is described in [Worker error 1042](https://developers.cloudflare.com/workers/observability/errors/).
