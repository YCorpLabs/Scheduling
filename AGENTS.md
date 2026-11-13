# Scheduling repository

The Worker, Studio, guest UI and tests live in apps/booking. Keep API routes
and device-grant scopes backward compatible; the Email desktop app depends on
them.

Keep an existing instance's Worker name, DO classes and migration tags.
Secrets stay in remote bindings or ignored local configuration, never Git.
Traces remain disabled to avoid capturing OAuth callback codes and private
booking capabilities.

apps/booking/wrangler.jsonc is shared and operator-neutral. Each instance's
identity is an overlay merged by apps/booking/scripts/instance-config.mjs; deploy
with npm run deploy:instance, never a bare wrangler deploy. Code reads names,
domains, senders and links from configuration with neutral defaults; never
hard-code Y Corp values. Never rewrite main's history.

Run npm run check, npm test, npm run test:runtime and the relevant browser tests
in apps/booking. npm run build is a dry run. Local mocked checks do not establish
live OAuth, delivery or restore acceptance. Record limits plainly. There is no
hosted CI; don't add workflows that spend compute.

Keep guest copy concise. Preserve necessary labels, validation, confirmations
and material limits. Do not add decorative explanations or sample/sandbox text.
Guests should not need an account to book.
