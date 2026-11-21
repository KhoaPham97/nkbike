# Nhật Khang Bike — Cloudflare Workers Free (staging)

This is an isolated compatibility spike. It does not replace Render and does not perform business writes.

## Cloudflare Git build settings

Set the Worker project's root directory to `cloudflare-worker`.

- Build command: `npm install`
- Deploy command: `npm run deploy`
- Node.js version: `22.22.0` (read from `.node-version`)

The Worker name is `nkbike-free-staging`; it is intentionally separate from the existing `nkbike` Worker so the current endpoint is not overwritten.

## Required secrets

Set these in Cloudflare Worker > Settings > Variables and Secrets:

- `MONGODB_URI`: existing MongoDB Atlas connection string for database `nhatkhang`.
- `MIGRATION_PROBE_TOKEN`: a newly generated random token used only to protect the read-only probe.

Never commit either value or send them in chat. Add the Cloudflare outbound IP access policy needed by the Atlas cluster if the cluster's network access list requires it.

## Smoke tests

- `GET /` or `GET /health` — Worker health only.
- `GET /api/health` — same health response.
- `POST /api/_migration/db-check` with header `x-migration-probe-token: <token>` — read-only MongoDB ping.

All other paths return HTTP 501 intentionally until their business routes are migrated and tested.

## Safety

- Does not change MongoDB collections or documents.
- Does not start cron jobs or Shopee sync.
- Does not expose the production API through a proxy.
- Does not replace or disable Render.
- Do not point any frontend at this staging Worker until route parity and write-flow acceptance tests pass.
