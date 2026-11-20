/**
 * Enable scheduled/background jobs on exactly the designated primary backend.
 *
 * IMPORTANT:
 * - Set ENABLE_BACKGROUND_JOBS=true only on the single primary Render service.
 * - Leave it false (or unset) on Cloudflare and every secondary API deployment.
 * - Keep the primary Render service at one instance/replica. The MongoDB job
 *   locks remain a second layer of protection against overlapping executions.
 *
 * Deliberately do not infer the primary role from RENDER=true: every Render
 * replica receives that variable, which would start duplicate cron schedulers.
 */
function isBackgroundJobsEnabled() {
  const configured = process.env.ENABLE_BACKGROUND_JOBS;

  return /^(1|true|yes|on)$/i.test(String(configured || "").trim());
}

module.exports = { isBackgroundJobsEnabled };
