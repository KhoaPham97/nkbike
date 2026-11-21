# Cloudflare Backend Migration — Nhật Khang Bike

## Chosen architecture

Use Cloudflare Workers + Cloudflare Containers to host the existing Node.js API,
rather than rewriting hundreds of Express/Mongoose business routes into a
different runtime.

- Public entrypoint: worker.js
- Container runtime: Dockerfile, Node 22, existing index.js
- Routing: one stable Durable Object identity and max_instances = 1
- Database: existing MongoDB Atlas database, unchanged
- Realtime: existing Socket.IO server inside the Node container; Worker uses
  Container.fetch so WebSocket upgrades are forwarded.
- Scheduled jobs: existing six jobs run in the single Node process. A Cloudflare
  Cron Trigger pings the container every five minutes to keep the one scheduler
  alive during periods without storefront traffic.
- No Render URL, self-proxy, database migration or new database is involved.

## Implemented in this branch

- worker.js: Cloudflare Container gateway, forwarding HTTP and WebSocket
  requests unchanged; one fixed backend identity; safe 503 on startup failure.
- Dockerfile: Node 22 production image running node index.js.
- .dockerignore: excludes .env, local dependencies, Git and temporary files.
- wrangler.toml: Worker, Durable Object Container binding, one instance,
  standard-1 instance sizing, and five-minute scheduled keepalive.
- package.json / package-lock.json: @cloudflare/containers runtime dependency.
- CLOUDFLARE_DEPLOYMENT.md: setup and cutover checklist.

## Important prerequisites

Cloudflare Containers require a Workers Paid plan. Container image deployment
from a Dockerfile requires a Docker-compatible image build environment. A Git
connected Workers Builds deployment can build and publish the image.

Set every environment variable currently used by the Node backend as a
Cloudflare Worker secret or variable. At minimum this includes MONGODB_URI and
JWT_SECRET, plus all existing Shopee, Cloudinary, payment and integration
credentials. Do not commit secret values.

## Scheduler safety

The Cloudflare Container is deliberately configured with max_instances = 1 and
a stable Durable Object name. ENABLE_BACKGROUND_JOBS is set to true only inside
that container. The old Render scheduler must be stopped/disabled before this
new scheduler is enabled in production. Do not run both at once. Existing
MongoDB job locks and idempotency protections must remain enabled because
Cloudflare may restart a container during infrastructure maintenance.

## Deployment and validation status

The source configuration has been committed to this feature branch only. It
has NOT been deployed to the user's Cloudflare account, and no live credentials
or production database connection have been tested from this environment.

Before changing frontend API URLs:
1. Configure all Worker secrets/vars in Cloudflare.
2. Connect this repository to Workers Builds, with repository root as build
   directory and npx wrangler deploy as the production deploy command.
3. Confirm the Worker and Container image both deploy successfully.
4. Confirm GET / returns the existing backend greeting.
5. Test login, token validation, admin authorization and all API domains.
6. Test Socket.IO WebSocket upgrades and notification events.
7. Test Shopee order sync, notifications, reservation, deduction, release,
   returns, stock sync and review/document jobs.
8. Verify only one Container instance is active and no Render scheduler runs.
9. Only after successful checks, switch Admin, storefront and Zalo API URLs.

## Data and rollback safeguards

- No MongoDB collections or records are changed by this migration branch.
- Do not use local container disk for persistent files. Keep data in MongoDB,
  Cloudinary or R2.
- Keep existing frontend API URLs unchanged until parity tests pass.
- Do not delete the Render deployment configuration until Cloudflare is proven
  stable and a rollback path has been confirmed.
