import { MongoDBConnection } from "./MongoDBConnection.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization,x-migration-probe-token",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "nkbike-cloudflare-free-staging",
        phase: "compatibility-spike",
        database: "not-checked",
        productionCutover: false,
      });
    }

    if (url.pathname === "/api/_migration/db-check" && request.method === "POST") {
      const expected = env.MIGRATION_PROBE_TOKEN;
      const supplied = request.headers.get("x-migration-probe-token");
      if (!expected || supplied !== expected) {
        return json({ ok: false, message: "Unauthorized" }, 401);
      }
      try {
        const id = env.MONGODB_CONNECTION.idFromName("nhatkhang-readonly-probe");
        const stub = env.MONGODB_CONNECTION.get(id);
        const result = await stub.pingDatabase();
        return json({ ok: true, database: result });
      } catch (error) {
        return json({
          ok: false,
          message: "MongoDB connectivity check failed",
          error: String(error?.message || error),
        }, 503);
      }
    }

    return json({
      ok: false,
      message: "This staging Worker only exposes health and the protected read-only MongoDB compatibility probe. Business routes are not migrated yet.",
    }, 501);
  },
};

export { MongoDBConnection };
