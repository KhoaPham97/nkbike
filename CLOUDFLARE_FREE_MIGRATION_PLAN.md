# Nhật Khang Bike — Cloudflare Workers Free migration

## Status

This is a separate, Free-plan migration track. It is not a deployable replacement yet.
Do not merge this branch into `main`, point any frontend at it, or enable Shopee writes until the acceptance checklist below passes.

The previous `cloudflare-backend-migration` branch and PR #8 use Cloudflare Containers. They require paid Container capacity and are explicitly not part of this Free-plan implementation.

## Confirmed repository scope

The existing backend is a Node.js 22 / Express application with:
- Express routes and controllers for auth, users, products, categories, carts, orders, checkout, customers, inventory, inventory batches/history, analytics, settings, vehicles, costs, media and administration.
- Shopee OAuth, shops, orders, returns, inventory/stock sync, reviews, documents, chat and related management endpoints.
- Mongoose models and the existing MongoDB Atlas database `nhatkhang`.
- Six in-process Shopee scheduled jobs.
- Socket.IO namespaces for chat, stock, internal orders, Shopee orders and Shopee reviews.

The existing application must not be run unchanged as a Cloudflare Worker. Workers use the Fetch API and do not provide a conventional always-listening Node.js server process. Socket.IO server behavior also needs a deliberate replacement.

## Free-plan architecture target

- Cloudflare Worker Fetch handler for the public HTTP API.
- Cloudflare Durable Object(s) for stateful coordination and WebSocket handling.
- MongoDB Atlas remains the system of record. Use Cloudflare's documented MongoDB connectivity pattern and validate Mongoose compatibility in the Worker runtime before porting business operations.
- Upgrade Mongoose from the current v8 line to a Workers-compatible v9 release only after a compatibility spike and regression tests. Do not change database schemas or collections as part of the runtime migration.
- Replace Express route mounting with Fetch-native routing while preserving existing URL paths, methods, request/response JSON shapes, auth behavior and error codes.
- Replace Socket.IO with a compatible WebSocket protocol/API and update frontends only after the server contract is validated. This is a behavior migration, not a transparent drop-in Socket.IO server.
- Replace six in-process node-cron schedulers with one or fewer Cloudflare Cron Triggers that dispatch bounded job handlers. Use durable MongoDB locks/idempotency and ensure only one scheduler is active.
- Keep all secrets in Cloudflare Worker secrets. Never commit credentials or request them in chat.

## Free-plan constraints to design against

Cloudflare's published Workers Free limits include 100,000 requests/day, 10 ms CPU time per request, 128 MB memory, 50 subrequests per request and five Cron Triggers per account. These limits can affect heavy reports, file processing, bulk Shopee sync and large payloads. Validate actual workload and request volume before cutover.

MongoDB connectivity is supported in Workers through Node.js compatibility and TCP sockets. Cloudflare documents Mongoose v9 support on Workers; this repository currently uses Mongoose v8.16.4, so compatibility must be proven rather than assumed. MongoDB Atlas Data API is not the migration target.

## Migration phases

1. **Compatibility spike (no production behavior changes)**
   - Build a minimal Worker health endpoint.
   - Connect to the existing Atlas cluster using a secret in a read-only test.
   - Test Mongoose v9 in a Durable Object and verify connection lifecycle, timeouts and serialization.
   - Test one representative model read without changing data.
   - Test one signed/authenticated API request.
2. **Core read APIs**
   - Port health, auth/session validation, categories and product reads.
   - Verify response compatibility with current storefront/admin clients.
3. **Core write and inventory flows**
   - Port products, orders, reservations, completion/cancellation, inventory batches and stock history.
   - Add concurrency and idempotency tests before enabling writes.
4. **Admin/reporting and supporting services**
   - Port customers, costs, analytics, settings, vehicles, media and checkout integrations.
   - Move CPU-heavy reports/file conversion to bounded or separately reviewed workflows.
5. **Shopee integration**
   - Port OAuth, order/return sync, notifications, stock mapping/sync, reviews and documents.
   - Keep external write operations disabled until duplicate-job protection and test-shop validation pass.
6. **Realtime and scheduled work**
   - Replace Socket.IO namespaces with explicit WebSocket message contracts.
   - Replace node-cron with a single scheduler trigger and durable locks.
7. **Staging acceptance and cutover**
   - Run read-only parity tests first, then controlled write tests.
   - Verify frontend, Zalo, Shopee OAuth callbacks and webhook URLs.
   - Only then prepare a separate cutover PR. Keep the current production API available for rollback.

## Mandatory acceptance checklist

- [ ] Worker health endpoint deploys on Workers Free.
- [ ] MongoDB Atlas read-only connection succeeds without changing data.
- [ ] Mongoose v9 compatibility and Durable Object lifecycle are tested.
- [ ] All existing route paths and response contracts are inventoried.
- [ ] Login/JWT and admin authorization parity passes.
- [ ] Product/category reads match production.
- [ ] Order create/reserve/complete/cancel flows pass concurrency tests.
- [ ] Inventory batch costs and stock accounting match production.
- [ ] Shopee OAuth and API signatures pass with secrets configured.
- [ ] Exactly one scheduler runs; jobs are idempotent across retries/restarts.
- [ ] Realtime event contracts are tested with all frontends.
- [ ] Request volume, CPU time, Cron limits and external API quotas fit Free plan.
- [ ] Frontend API URLs are changed only after all previous checks pass.

## Non-goals / safety

- Do not create, drop, rename or bulk-migrate MongoDB collections.
- Do not delete the existing Render deployment or current production API.
- Do not run the paid Container branch on a Free account.
- Do not enable Shopee stock/order writes during the initial compatibility spike.
- Do not claim the system is migrated or production-ready based only on Wrangler dry-run or a health endpoint.
