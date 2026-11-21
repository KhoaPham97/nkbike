# Cloudflare deployment — Nhật Khang Bike

## Architecture

- Cloudflare Worker (worker.js) is the public API gateway.
- One named Durable Object routes all traffic to one Cloudflare Container.
- The container runs the existing Node 22 backend (node index.js) unchanged.
- Express routes, Mongoose models, Socket.IO namespaces and existing Shopee
  services/jobs remain in the Node process.
- No Render URL is used as an origin. There is no Worker-to-itself proxy.
- The existing MongoDB Atlas database is retained; this deployment does not
  create, migrate, drop or rewrite collections.

## Required Cloudflare account capability

Cloudflare Containers are available on Workers Paid plans. Container compute is
billed separately from ordinary Worker requests; the five-minute keepalive is
intended to keep the scheduler running and therefore keeps the backend warm.
Review the account's current Containers pricing before enabling production.
Workers Builds connected to Git can build and publish the Docker image.

## Secrets and variables

Set the backend's existing environment variables as Worker secrets/vars in
Cloudflare (Workers & Pages > nkbike > Settings > Variables and Secrets).
The current source references these variables (use Secret for credentials and
ordinary Variables for non-sensitive settings):

- MONGODB_URI
- JWT_SECRET
- SHOPEE_PARTNER_ID
- SHOPEE_PARTNER_KEY
- SHOPEE_API_BASE_URL
- SHOPEE_ENV
- SHOPEE_FRONTEND_URL
- SHOPEE_REDIRECT_URI
- CLOUDINARY_API_KEY
- CLOUDINARY_API_SECRET
- CLOUDINARY_CLOUD_NAME
- CLOUDINARY_NAME
- CLOUDINARY_URL
- STRIPE_SECRET_KEY
- STRIPE_SHIPPING_RATE_ID
- WEB_APP_URL
- CNY_VND_RATE

The Worker forwards all string-valued bindings to the container at startup.
Re-check the source when adding new integrations and add their variables too.
Never commit secret values to Git.

## Build and deploy

Connect repository KhoaPham97/nkbike to Workers Builds and use this repository
root as the build directory. Set the production build/deploy command to:

npx wrangler deploy

The Dockerfile uses Node 22 and npm ci. The GitHub Actions workflow validates
locked dependencies, the Wrangler bundle/configuration and a Linux AMD64 Docker
build. Workers Builds must have Cloudflare Containers image builds enabled.

## Validation before frontend cutover

1. Confirm the Worker deployment and Container image rollout both succeed.
2. Check the Worker URL / and confirm it returns the existing API greeting.
3. Test login, product reads, order reads, inventory reservation/release and
   stock deduction with controlled test data.
4. Test Socket.IO namespaces and a real WebSocket upgrade.
5. Verify Shopee OAuth, order sync, order notification, stock reservation,
   return handling and manual sync.
6. Verify only one container is running and background jobs are enabled only
   in this container. The Worker keepalive runs every five minutes. Keep the old
   Render deployment stopped/disabled before enabling this scheduler to avoid
   duplicate jobs.
7. Only after all checks pass, update admin/storefront/Zalo API base URLs.

## Important operational notes

- max_instances = 1 and the stable Durable Object name are intentional.
- The container's local filesystem is ephemeral. Persistent data must remain in
  MongoDB/Cloudinary/R2, not local files.
- Cloudflare can restart containers during maintenance. Jobs must be safe to
  restart and retain their MongoDB overlap/idempotency protections.
- Requests and Socket.IO use Container.fetch, not containerFetch.
