# Contributing to Scheduling

Thanks for helping out!

Bug reports and ideas go in
[issues](https://github.com/YCorpLabs/Scheduling/issues), and questions and
self-hosting notes in [Discussions](https://github.com/YCorpLabs/Scheduling/discussions).
Small pull requests (fixes, docs) are welcome. For anything bigger, open an
issue first so we can talk it through.

## License of contributions

Scheduling is MIT licensed, and so are contributions to it. Only submit work
you have the right to license this way.

## Before you start

- Security problems go through the [security policy](SECURITY.md), never a
  public issue.

## Set up

```sh
cd apps/booking
npm ci
npm run dev
```

Open `http://127.0.0.1:8788/studio`, `/book` or `/site`. Without `.dev.vars` the
service uses loopback-only fixture data and contacts no Google or email
provider. For connected development see the
[self-hosting guide](docs/self-hosting.md#local-development-against-google).

## Checks

Run these in `apps/booking` before opening a pull request:

```sh
npm run check
npm test
npm run test:runtime
BOOKING_BROWSER=/path/to/chromium npm run test:e2e   # when you change UI
npm run build                                        # dry run only
```

Say in your pull request which checks you ran and what they printed.

## Ground rules for changes

- **Compatibility.** Keep existing API routes, response fields, embed
  attributes and Durable Object classes working. Never rename or reorder
  Durable Object classes or migration tags in `apps/booking/wrangler.jsonc`.
  New migrations are appended.
- **Operator-neutral code.** Names, domains, senders, links and logos come from
  configuration (see [branding](docs/self-hosting.md#branding)). Do not
  hard-code an operator's identity.
- **No secrets or personal data.** Never commit keys, tokens, `.dev.vars`,
  instance overlays, real guest data or screenshots of real calendars. Test
  fixtures use reserved domains such as `example.com` or `.test`.
- **Privacy.** Keep Workers traces disabled, keep management capabilities in
  URL fragments, and do not log guest details, tokens or provider bodies.
- **Guest copy.** Keep it short. Keep labels, validation, confirmations and
  material limits; skip decorative explanations. Guests must never need an
  account to book.
- **Plain JavaScript and CSS.** No framework runtime, no external fonts and no
  third-party scripts in guest pages.

## Pull requests

- Keep each pull request to one change, with tests.
- Describe what changed, why, and how you verified it.
- Update documentation when behaviour or configuration changes.
- Every change gets reviewed. We might ask for changes, or pass on things that
  don't fit the project.
