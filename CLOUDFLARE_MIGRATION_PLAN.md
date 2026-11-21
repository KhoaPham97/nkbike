# Cloudflare Backend Migration Plan

## Goal

Move the Nhật Khang Bike API from the suspended Render service to a Cloudflare-hosted backend without changing the existing MongoDB Atlas database or business rules.

This branch is planning-only. It does not replace the production Worker, change frontend API URLs, connect to the database, or enable scheduled jobs.

## Current backend inventory

- Express application entry: `app.js`
- Node HTTP / Socket.IO / background-job startup: `index.js`
- MongoDB access: Mongoose in `src/db/mongoose.js`
- Authentication: JWT plus a MongoDB user/token lookup in `src/middlewares/auth.js`
- API domains registered in `app.js`: authentication, products, users, carts, checkout, orders, customers, inventory, analytics, settings, admin, vehicles, inventory batches, costs, Shopee, SKU, reviews, media and order outcome analytics.
- Realtime namespaces are initialized in `index.js` and `src/socket/*`.
- Scheduled Shopee jobs currently started by `index.js`: auto stock, order sync, auto review, review sync, stock sync and document sync.
- Job scheduling is intentionally gated by `ENABLE_BACKGROUND_JOBS` in `src/utils/backgroundJobs.js`.

## Migration constraints

1. Keep the existing MongoDB Atlas database and collection names. Do not run migrations, drops, renames, or data rewrites as part of the runtime cutover.
2. Do not configure the Worker to proxy to itself or to the suspended Render origin.
3. Do not enable scheduled jobs until the Cloudflare scheduler has a durable single-runner lock and idempotency checks. There must be one active scheduler only.
4. Keep the current Render/legacy code untouched during development. Cut over frontends only after parity tests pass.
5. Keep credentials in Cloudflare secrets/bindings, never in source control.
6. Preserve authentication semantics: Bearer JWT verification and database-backed session/token validation, including admin role checks.
7. Preserve existing route paths and HTTP methods, including `POST /api/analytics/track`.

## Runtime assessment

The current application is not a drop-in Worker entrypoint:

- Express uses Node's HTTP server and Socket.IO server startup.
- Mongoose is initialized as a process-level side effect and exits the process on connection failure.
- Several routes import Node-oriented libraries and perform file/PDF/XLSX operations.
- Six recurring jobs are started from the Node server startup path.

A Cloudflare runtime adapter and dependency-by-dependency compatibility work are required. The MongoDB connection strategy must be validated against Cloudflare Workers' supported outbound TCP/Node compatibility before migrating data access. Do not assume Mongoose works unchanged.

## Proposed phases

### Phase 0 — isolated Worker foundation
- Create a separate Worker deployment target and health endpoint.
- Add strict CORS handling for the known Admin, Zalo and storefront origins.
- Add structured request IDs and safe error responses.
- No production route traffic and no scheduled jobs yet.

### Phase 1 — database and auth proof
- Connect to the existing Atlas cluster using Cloudflare-supported connectivity and secrets.
- Verify read-only access to the existing database and expected collections.
- Port JWT verification and database-backed token lookup.
- Validate login/session/admin authorization without changing records.

### Phase 2 — API domains
Port and test each domain while retaining exact route contracts:
1. analytics and settings;
2. products, categories, users and customers;
3. orders and checkout;
4. inventory, reservations, batches and history;
5. Shopee account, orders, returns, reviews, chat, mappings and reports;
6. media, PDF/document and spreadsheet endpoints.

### Phase 3 — realtime
- Replace Socket.IO server behavior with a Cloudflare-compatible WebSocket design (likely Durable Objects).
- Preserve authentication and event semantics for admin notifications, stock, orders and Shopee.

### Phase 4 — one scheduler
- Port the six jobs to scheduled execution only after route parity.
- Use a durable database-backed lease/lock, bounded execution and idempotency.
- Ensure exactly one scheduler is enabled; leave any old scheduler disabled before enabling the new one.
- Verify order reservation/deduction/release invariants before production activation.

### Phase 5 — cutover
- Run smoke tests for every critical API, authentication, stock lifecycle, Shopee sync, reports and realtime.
- Update frontend API base URLs only after tests pass.
- Keep rollback instructions and do not delete the old deployment configuration until the new backend is proven stable.

## Required Cloudflare configuration (names only)

Store actual values as Cloudflare secrets/vars after the runtime design is validated:
- `MONGODB_URI` (secret)
- `JWT_SECRET` (secret)
- existing Shopee app credentials and encryption keys (secrets)
- existing Cloudinary credentials (secrets)
- other payment/provider secrets used by the application (secrets)

Do not paste secrets into GitHub issues, source files, or chat.

## Acceptance criteria

- Worker health endpoint responds independently of Render.
- Existing Atlas database name and data remain unchanged.
- Auth, admin permissions and all production route contracts pass tests.
- No self-proxy or Render dependency remains in the new runtime.
- No duplicate background processor can run.
- Shopee order status transitions preserve reserve / deduct / release behavior.
- Realtime notifications work for the existing frontend clients.
- Frontends are cut over only after the above checks pass.
