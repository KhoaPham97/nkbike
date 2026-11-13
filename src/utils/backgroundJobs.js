/**
 * Decide which deployment is allowed to run recurring/background jobs.
 *
 * Set ENABLE_BACKGROUND_JOBS=true on the primary Render backend and
 * ENABLE_BACKGROUND_JOBS=false on Cloudflare. When omitted, only Render
 * enables jobs by default.
 */
function isBackgroundJobsEnabled() {
  const configured = process.env.ENABLE_BACKGROUND_JOBS;

  if (configured !== undefined && configured !== null && String(configured).trim() !== "") {
    return /^(1|true|yes|on)$/i.test(String(configured).trim());
  }

  return String(process.env.RENDER || "").toLowerCase() === "true";
}

module.exports = { isBackgroundJobsEnabled };
