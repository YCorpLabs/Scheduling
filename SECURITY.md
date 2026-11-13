# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately.

1. **GitHub private vulnerability reporting** (preferred):
   [report a vulnerability](https://github.com/YCorpLabs/Scheduling/security/advisories/new), or open the
   repository's **Security** tab and choose **Report a vulnerability**.
2. **Email**: support@ycorplabs.com, with "Security" in the subject.

Include what you found, how to reproduce it, the affected version or commit and
the impact you expect. Please do not include real guest data, OAuth tokens or
booking links in your report; redact them.

We aim to acknowledge reports within three working days and to agree a
disclosure date with you once we understand the issue. We credit reporters who
want to be credited.

## Scope

In scope:

- The code in this repository: the Worker, Studio, guest pages, embeds,
  device grant and scripts.
- The hosted service at meet.ycorplabs.com.

When testing the hosted service, use only accounts and calendars you own, do
not access other people's data, and avoid degrading the service for others.
Denial-of-service, spam and social-engineering tests are out of scope.

Self-hosted instances are run by their operators. Report a flaw in the code to
us; report a problem with someone's instance to that operator.

## Supported versions

Security fixes go to `main`. Self-hosters should upgrade by deploying the
latest `main`.

## Hardening notes for operators

- Keep secrets in `wrangler secret put`, never in config files or Git.
- Back up `TOKEN_ENCRYPTION_KEY` before deploying; it cannot be read back.
- Keep Workers traces disabled. They would record OAuth callback codes and
  private booking paths.
- Restrict generic webhooks with `INTEGRATION_WEBHOOK_HOSTS`.
- See [operations and recovery](docs/booking-operations.md).
