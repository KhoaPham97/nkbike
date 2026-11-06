const mongoose = require("mongoose");

const shopeeAutoStockJobResultSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      default: "",
      index: true,
    },

    orderSn: {
      type: String,
      default: "",
      index: true,
    },

    status: {
      type: String,
      enum: ["success", "failed", "skipped", "partial"],
      default: "skipped",
    },

    stockStatus: {
      type: String,
      enum: [
        "pending",
        "ready",
        "deducted",
        "partially_deducted",
        "blocked",
        "failed",
        "unmapped",
      ],
      default: "pending",
    },

    message: {
      type: String,
      default: "",
    },

    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  },
);

const shopeeAutoStockJobLogSchema = new mongoose.Schema(
  {
    // Loại chạy: cron hoặc manual
    trigger: {
      type: String,
      enum: ["cron", "manual"],
      default: "cron",
      index: true,
    },

    // Trạng thái tổng thể của lần chạy
    status: {
      type: String,
      enum: ["running", "completed", "partial", "failed", "skipped"],
      default: "running",
      index: true,
    },

    startedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    finishedAt: {
      type: Date,
      default: null,
    },

    durationMs: {
      type: Number,
      default: 0,
      min: 0,
    },

    scannedOrders: {
      type: Number,
      default: 0,
      min: 0,
    },

    successCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    failedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    skippedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    partialCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    error: {
      type: String,
      default: "",
    },

    results: {
      type: [shopeeAutoStockJobResultSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "shopeeautostockjoblogs",
  },
);

shopeeAutoStockJobLogSchema.index({ startedAt: -1 });
shopeeAutoStockJobLogSchema.index({ trigger: 1, startedAt: -1 });

module.exports =
  mongoose.models.ShopeeAutoStockJobLog ||
  mongoose.model("ShopeeAutoStockJobLog", shopeeAutoStockJobLogSchema);
