/**
 * Enable scheduled/background jobs on exactly one designated primary backend.
 *
 * - On the Cloudflare migration, ENABLE_BACKGROUND_JOBS=true is injected only
 *   into the single Cloudflare Container configured by wrangler.toml.
 * - Leave it false/unset on secondary APIs, staging deployments and workers
 *   that must not execute Shopee jobs.
 * - Keep the Cloudflare Container max_instances at 1.
 * - MongoDB job locks/idempotency remain required because containers can restart.
 *
 * Deliberately do not infer the primary role from RENDER=true: every Render
 * replica receives that variable, which could start duplicate cron schedulers.
 */
function isBackgroundJobsEnabled() {
  const configured = process.env.ENABLE_BACKGROUND_JOBS;
  return /^(1|true|yes|on)$/i.test(String(configured || "").trim());
}

module.exports = { isBackgroundJobsEnabled };
