/**
 * Nhật Khang Bike — Cloudflare edge gateway.
 *
 * The complete existing Node.js API runs inside one Cloudflare Container.
 * This preserves Express routes, Mongoose models, Socket.IO and the existing
 * Shopee/inventory code instead of attempting an unsafe partial Worker rewrite.
 *
 * All API paths, query strings, request bodies and WebSocket upgrades are
 * forwarded unchanged to the single primary container. There is no Render
 * origin and no self-proxy URL.
 */
import { Container } from "@cloudflare/containers";

const BACKEND_INSTANCE_NAME = "nhat-khang-bike-primary";
const BACKEND_PORT = 3001;

export class NKBikeBackend extends Container {
  defaultPort = BACKEND_PORT;
  // Keep one primary Node process warm between requests.
  sleepAfter = "24h";
  enableInternet = true;
  pingEndpoint = "/";

  constructor(ctx, env) {
    super(ctx, env);

    // Forward string-valued Worker vars/secrets only. Non-string bindings such
    // as Durable Object namespaces are deliberately excluded.
    const appEnv = {};
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value === "string" && value.length > 0) appEnv[key] = value;
    }

    this.envVars = {
      ...appEnv,
      NODE_ENV: "production",
      PORT: String(BACKEND_PORT),
      // One container instance owns the existing background scheduler.
      ENABLE_BACKGROUND_JOBS: "true",
    };
  }

  onStart() {
    console.log("[NKBike Cloudflare] Primary backend container started.");
  }

  onStop() {
    console.log("[NKBike Cloudflare] Primary backend container stopped.");
  }

  onError(error) {
    console.error("[NKBike Cloudflare] Backend container error:", error);
  }
}

export default {
  async fetch(request, env) {
    const container = env.NKBIKE_BACKEND.getByName(BACKEND_INSTANCE_NAME);
    try {
      // Container.fetch supports HTTP and WebSocket upgrades (Socket.IO).
      return await container.fetch(request);
    } catch (error) {
      console.error("[NKBike Cloudflare] Backend request failed:", error);
      return Response.json(
        {
          success: false,
          code: "BACKEND_CONTAINER_UNAVAILABLE",
          message: "Nhật Khang Bike backend is starting or temporarily unavailable.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },

  // Keep the one primary container awake so its existing in-process scheduler
  // continues running even when the shop website has no visitor traffic.
  async scheduled(controller, env, ctx) {
    const container = env.NKBIKE_BACKEND.getByName(BACKEND_INSTANCE_NAME);
    ctx.waitUntil(
      container.fetch(new Request("http://nkbike.internal/")).then(async (response) => {
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`Backend keep-alive returned HTTP ${response.status}`);
        }
      }).catch((error) => {
        console.error("[NKBike Cloudflare] Scheduled keep-alive failed:", error);
      }),
    );
  },
};
