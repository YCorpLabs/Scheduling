# Self-hosting Scheduling

This guide deploys your own Scheduling instance to your own Cloudflare account,
under your own domain, Google OAuth client, sender address and name. Nothing in
it uses Y Corp's accounts, and an instance that follows it shows none of Y
Corp's identity.

It takes about an hour, most of it in the Google Cloud console.

## What you need

- A Cloudflare account. Durable Objects with SQLite storage are available on the
  Workers Free plan; check Cloudflare's current limits for your expected use.
- A domain on Cloudflare if you want a custom domain (optional: a `workers.dev`
  address works).
- A Google Cloud project where you can create an OAuth client.
- Node.js 24 and Git.
- Optional, for booking emails: a domain onboarded to Cloudflare Email Service,
  or a Resend account. Google Calendar invitations work without either.

## How configuration is split

`apps/booking/wrangler.jsonc` is shared by every instance. It defines the Worker
code, the three Durable Object classes and their migrations, the five-minute
maintenance cron and the logging settings. It names no operator.

Your instance's identity lives in a small **instance overlay**: Worker name,
routes, public origin, sender and optional branding.
`apps/booking/scripts/instance-config.mjs` checks the overlay, merges it into the shared
file and writes `apps/booking/wrangler.instance.generated.json`, which Wrangler
deploys. The overlay cannot change Durable Objects, migrations or tracing, so
pulling new code never leaves your instance out of step with it.

Secrets never go in either file. They are stored in Cloudflare with
`wrangler secret put`.

## 1. Get the code

```sh
git clone https://github.com/YCorpLabs/Scheduling.git
cd Scheduling/apps/booking
npm ci
npx wrangler login
```

If you have several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` in your
shell or put `account_id` in your overlay.

## 2. Write your instance overlay

```sh
cp wrangler.instance.example.jsonc wrangler.instance.jsonc
```

`wrangler.instance.jsonc` is ignored by Git. You can also keep the overlay
anywhere outside the checkout and point to it with
`SCHEDULING_INSTANCE_CONFIG=/path/to/overlay.jsonc`.

Edit it:

- `name`: your Worker's name. Choose once. A different name later is a
  different Worker with empty storage.
- `routes`: your custom domain, for example
  `{ "pattern": "meet.example.com", "custom_domain": true }`. Cloudflare
  creates the DNS record when you deploy. To use `workers.dev` instead, remove
  `routes` and set `"workers_dev": true`.
- `vars.PUBLIC_ORIGIN`: the exact HTTPS origin people will use, such as
  `https://meet.example.com`. For `workers.dev` this is
  `https://<name>.<your-subdomain>.workers.dev`.
- `vars.LIVE_ENABLED`: keep `"true"`. Until the secrets in step 4 exist, the
  service stays in setup mode anyway.
- `vars.MAIL_FROM` and `send_email`: they still hold example addresses, which
  the checker refuses. Fill them in now (see step 5), or delete
  `NOTIFICATION_PROVIDER`, `MAIL_FROM` and the `send_email` block to start
  without booking emails.

Check it without deploying:

```sh
npm run instance:config
npm run build:instance   # Wrangler dry run of your merged config
```

The checker refuses example values, unknown keys, secrets in `vars` and any
attempt to override shared configuration.

## 3. Create the Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/), inside your
own project:

1. **Enable the Google Calendar API** (APIs & Services, Library).
2. **Configure the OAuth consent screen** (Google Auth Platform). Use your own
   app name, support email, logo, home page and privacy policy. Choose
   *External* unless all users are in one Google Workspace organisation.
3. **Add these scopes** (Data access):
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.freebusy`

   Signing in to Studio requests identity only. The calendar scopes are
   requested separately when a host connects a calendar.
4. **Create an OAuth client** (Clients, Create client) of type
   **Web application**. Add exactly one authorised redirect URI:
   `<PUBLIC_ORIGIN>/auth/google/callback`, for example
   `https://meet.example.com/auth/google/callback`. No JavaScript origin is
   needed.
5. While the app is in *Testing*, add every host's Google address as a test
   user. In *Testing*, Google expires calendar refresh tokens after seven days,
   so connected calendars disconnect every week. For lasting use, set the
   app's publishing status to *In production*. Until Google verifies the app,
   hosts see an unverified-app warning and Google caps it at 100 users.
   Calendar scopes are sensitive, so verification reviews your app, domain and
   privacy policy.

Use a separate client for local development, with
`http://127.0.0.1:8788/auth/google/callback` as its redirect URI. Do not reuse a
desktop or mobile client.

## 4. Set the secrets

The Google values are prompted for, so they never land in your shell history.
The encryption key is generated into a private file outside the checkout and
put from that file, so the key you back up is exactly the deployed one:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID     --config wrangler.instance.generated.json
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.instance.generated.json

umask 077
KEY_FILE="$HOME/scheduling-token-encryption.key"
openssl rand -base64 32 > "$KEY_FILE"
npx wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.instance.generated.json < "$KEY_FILE"
```

Back up `$KEY_FILE` as described in [key backup](booking-key-backup.md), then
delete it once the backup is confirmed.

`TOKEN_ENCRYPTION_KEY` encrypts stored calendar grants, guest-link recovery
copies and queued emails. Cloudflare cannot show it back to you. If you lose it,
every host must reconnect their calendar and queued emails cannot be sent.
Never change it to fix an error: a new key cannot read existing data.

If the Worker does not exist yet, Wrangler offers to create it when you put the
first secret. You can also deploy first (step 6) and set the secrets afterwards;
the service then shows setup mode until all three exist.

## 5. Booking emails (optional)

Google sends calendar invitations, updates and cancellations either way. The
service's own emails (approval outcomes, confirmations, reminders and the
follow-up) need one of these.

**Cloudflare Email Service**

1. Onboard your sender domain to Cloudflare Email Service in the Cloudflare
   dashboard and complete its DNS records. See
   [Cloudflare's Email Service docs](https://developers.cloudflare.com/email-service/).
2. In your overlay set `"NOTIFICATION_PROVIDER": "cloudflare"`, set
   `"MAIL_FROM": "Your Product <notifications@example.com>"`, and list the
   same address in `send_email[0].allowed_sender_addresses`.

**Resend**

1. Verify your domain in Resend and create an API key.
2. In your overlay set `"NOTIFICATION_PROVIDER": "resend"` and `MAIL_FROM`, and
   remove the `send_email` block.
3. `npx wrangler secret put RESEND_API_KEY --config wrangler.instance.generated.json`

Without a working sender, Studio says email delivery is not connected and only
Google invitations go out.

## 6. Deploy

```sh
npm run deploy:instance
```

This merges your overlay and runs `wrangler deploy` with the result. On the
first deploy Cloudflare creates the Worker, applies the Durable Object
migrations (`v1` and `v2`), attaches your custom domain and starts the cron.

**Durable Object migrations.** Migrations are recorded per Worker and applied
automatically by `wrangler deploy`; there is no separate migration command.
Never rename or remove the classes `BookingHost`, `LiveBookingHost` and
`AuthStore`, never edit or reorder existing migration tags, and keep the Worker
name. Any of those would orphan stored bookings and grants. New versions add
migrations to the shared `wrangler.jsonc`; deploying them applies them.

## 7. Check it

```sh
python3 ../../scripts/check-booking-deployment.py --origin https://meet.example.com
```

This read-only check confirms that public health reports ready, owner routes
refuse anonymous requests, framing protection is in place and every public
asset matches your checkout. It does not sign in, book or send mail.

Then, by hand:

1. Open `<PUBLIC_ORIGIN>/studio` and sign in with Google.
2. Connect a calendar and choose which calendars count as busy.
3. Publish a booking link, book it from a private window with an address you
   own, then reschedule and cancel it from the guest email or link.

**Account deletion.** Once, after the first deploy, run the account-data
inventory. Until it has run, Delete account in Studio says "Account data
inventory is being prepared".

```sh
npm run instance:config && node scripts/account-inventory.mjs --apply
```

It uses your Wrangler login and the deployed Worker, records the instance's
starting state and never deletes anything. If it stalls, see "Legacy inventory
and recovery operations" in [operations](booking-operations.md). A Deploy to
Cloudflare instance has no overlay: in a local clone of your repository run
`npm ci` and `npx wrangler login`, create `wrangler.instance.jsonc` with just
your Worker's `name` and `vars.PUBLIC_ORIGIN`, then run the same command from
the repository root.

## Branding

Unset values use neutral defaults: the product is called "Scheduling" and no
organisation, logo, legal link or support address is shown. Add any of these to
`vars` in your overlay:

| Variable | Shown as | Default |
| --- | --- | --- |
| `PRODUCT_NAME` | Sign-in heading, Studio wordmark, page titles | `Scheduling` |
| `BRAND_NAME` | Booking-page footer and title, Studio tab title | product name |
| `DESKTOP_APP_NAME` | Desktop client named on `/device` | brand name, else "your desktop app" |
| `ORGANIZATION_NAME` | Sign-in header | none |
| `ORGANIZATION_URL` | Link on the organisation name | none |
| `ORGANIZATION_MARK_PATH` | SVG path drawn in a 32×32 mark beside it | none |
| `PRIVACY_URL`, `TERMS_URL` | Links on the sign-in page and booking-page footer | none |
| `SUPPORT_EMAIL` | Support link beside them | none |
| `WEBHOOK_USER_AGENT` | `User-Agent` of outgoing webhooks | `Scheduling-Webhooks/1` |

Names may be up to 60 characters; a longer one wraps onto two lines in the
Studio sidebar and on the sign-in page. Links must be HTTPS. Invalid values are
ignored rather than shown. The sender
name and address in emails come from `MAIL_FROM`, and the Google consent screen
shows the app name from your Google project. Read [TRADEMARKS.md](../TRADEMARKS.md)
before choosing a name.

The device-connection URL is built from `PUBLIC_ORIGIN`, so a build of the
Email app configured with your origin connects to your instance.

## Deploy to Cloudflare button

The README's button clones `apps/booking` into a new repository in your GitHub
or GitLab account, creates the Worker with its Durable Objects and sets up
Workers Builds to deploy on every push. It asks for the values listed in
`.dev.vars.example` and stores them as secrets. That is a quicker start; the
overlay flow above keeps upgrades simpler.

After the button finishes:

1. Note your `workers.dev` address and update the `PUBLIC_ORIGIN` secret to
   it (Worker settings, Variables and Secrets).
2. Create the Google client with that origin's callback (step 3), then set the
   Google secrets and the encryption key, and set `LIVE_ENABLED` to `true`.
3. To use your own domain or branding, edit `wrangler.jsonc` at the root of
   *your* new repository (the button copies `apps/booking` as the root) and
   push. For a new domain, also update the `PUBLIC_ORIGIN` secret.

Workers Builds runs in your account and may count against your plan's build
allowance. The button only works for public repositories on github.com or
gitlab.com.

## Upgrading

From the repository root:

```sh
git pull
cd apps/booking
npm ci
npm run check && npm test && npm run test:runtime
npm run build:instance
npm run deploy:instance
```

Read the commit messages since your last pull for new variables or migrations
first. Back up your encryption key before every change.

A repository made with the Deploy to Cloudflare button has `apps/booking` as
its root, so add YCorpLabs/Scheduling as an upstream remote and pull its
`apps/booking` into yours:

```sh
git remote add upstream https://github.com/YCorpLabs/Scheduling.git
git pull --no-rebase --allow-unrelated-histories -X subtree=apps/booking -X theirs upstream main   # first time
git pull --no-rebase -X subtree=apps/booking upstream main                                          # later
```

The first pull takes upstream's version of every file, so re-apply your own
`wrangler.jsonc` changes and commit them before you push, because Workers
Builds deploys every push. After every pull, check that `name` in
`wrangler.jsonc` is still your Worker's name: the first pull resets it to
`scheduling`, and a different name deploys a new, empty Worker.

## Running it

- [Operations and recovery](booking-operations.md): status, parked emails,
  freezing outbound work and restores.
- [Key backup](booking-key-backup.md) and [PITR drill](booking-pitr-drill.md).
- Keep Workers traces disabled. They would record OAuth callback codes and
  private booking paths. The shared config already disables them.
- Generic signed webhooks only go to hosts listed in
  `INTEGRATION_WEBHOOK_HOSTS`.

## Local development against Google

```sh
cp .dev.vars.example .dev.vars   # ignored by Git
npm run dev
```

Fill in `.dev.vars` with your local OAuth client, a separate encryption key and
`PUBLIC_ORIGIN=http://127.0.0.1:8788`, then set `LIVE_ENABLED=true`. Without `.dev.vars`, local pages use
fixture data and contact no provider.
