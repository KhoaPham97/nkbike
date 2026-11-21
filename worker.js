/**
 * Nhật Khang Bike — Cloudflare Worker entrypoint (migration foundation).
 *
 * IMPORTANT:
 * - This Worker is intentionally NOT a proxy. It never calls itself or Render.
 * - Business routes are enabled only as they are ported and tested.
 * - No database writes, Shopee jobs, or cron triggers are started here.
 * - Configure secrets/bindings in Cloudflare, never in this file.
 */

const ALLOWED_ORIGINS = new Set([
  "https://nk-admin.onrender.com",
  "https://nk-admin.phamdangkhoa0403.workers.dev",
  "https://zalo-app.onrender.com",
  "https://nkbike.phamdangkhoa0403.workers.dev",
  "http://localhost:3000",
  "http://localhost:2999",
  "http://localhost:5173",
]);

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS =
  "Content-Type, Authorization, Accept, Origin, X-Requested-With";

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  return headers;
}

function json(request, status, payload, extraHeaders = {}) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(payload), { status, headers });
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const method = request.method.toUpperCase();

    // CORS preflight must be answered before route matching.
    if (method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json(request, 403, {
          success: false,
          message: "Origin is not allowed by Cloudflare Worker CORS policy.",
        });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (path === "/" || path === "/api" || path === "/api/health") {
      if (method !== "GET" && method !== "HEAD") {
        return json(request, 405, {
          success: false,
          message: "Method not allowed.",
        }, { Allow: "GET, HEAD, OPTIONS" });
      }

      return json(request, 200, {
        success: true,
        service: "nhat-khang-bike-cloudflare-api",
        runtime: "cloudflare-workers",
        status: "migration-foundation",
        renderProxy: false,
        databaseConnected: false,
        businessRoutesEnabled: false,
        scheduledJobsEnabled: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Explicitly report routes not yet ported rather than returning a misleading
    // generic 404 or forwarding requests to a suspended/recursive origin.
    if (path.startsWith("/api/")) {
      return json(request, 501, {
        success: false,
        code: "API_ROUTE_NOT_MIGRATED",
        message: "This API route has not yet been ported to the Cloudflare backend.",
        path,
        method,
      });
    }

    return json(request, 404, {
      success: false,
      message: "Not found.",
      path,
    });
  },
};
