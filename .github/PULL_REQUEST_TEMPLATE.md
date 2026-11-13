## What and why

<!-- What changes, and the problem it solves. Link the issue if there is one. -->

## How I verified it

<!-- Commands you ran in apps/booking and their results. -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:runtime`
- [ ] `npm run test:e2e` (UI changes; say which browser)
- [ ] `npm run build` (dry run)

## Not verified

<!-- Anything mocked or untested: live Google, email delivery, restores, browsers. -->

## Checklist

- [ ] Existing routes, response fields, embed attributes and Durable Object migrations still work.
- [ ] No operator identity (names, domains, senders, links) is hard-coded; it comes from configuration.
- [ ] No secrets, instance overlays, real guest data or personal data are included.
- [ ] Documentation is updated where behaviour or configuration changed.
