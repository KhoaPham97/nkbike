import { DurableObject } from "cloudflare:workers";
import mongoose from "mongoose";

export class MongoDBConnection extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.connectionPromise = null;
  }

  async pingDatabase() {
    if (!this.env.MONGODB_URI) {
      throw new Error("MONGODB_URI secret is not configured");
    }

    if (mongoose.connection.readyState !== 1) {
      if (!this.connectionPromise) {
        this.connectionPromise = mongoose.connect(this.env.MONGODB_URI, {
          dbName: "nhatkhang",
          serverSelectionTimeoutMS: 8000,
          connectTimeoutMS: 8000,
          maxPoolSize: 1,
          minPoolSize: 0,
          maxIdleTimeMS: 20000,
        }).finally(() => {
          this.connectionPromise = null;
        });
      }
      await this.connectionPromise;
    }

    const result = await mongoose.connection.db.admin().command({ ping: 1 });
    return {
      ok: result.ok === 1,
      database: mongoose.connection.name,
      readyState: mongoose.connection.readyState,
    };
  }
}
