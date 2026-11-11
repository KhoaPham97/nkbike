const mongoose = require("mongoose");

const ShopeeStockSyncResultSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      default: "",
      index: true,
    },

    itemId: {
      type: String,
      default: "",
      index: true,
    },

    modelId: {
      type: String,
      default: "0",
    },

    itemName: {
      type: String,
      default: "",
    },

    modelName: {
      type: String,
      default: "",
    },

    shopeeSku: {
      type: String,
      default: "",
      index: true,
    },

    variantCode: {
      type: String,
      default: "",
      index: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      default: null,
    },

    physicalQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    reservedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    bufferQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    targetQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    previousShopeeQty: {
      type: Number,
      default: null,
      min: 0,
    },

    syncedShopeeQty: {
      type: Number,
      default: null,
      min: 0,
    },

    status: {
      type: String,
      enum: [
        "success",
        "failed",
        "skipped",
        "unchanged",
        "unmapped",
        "ambiguous",
      ],
      default: "skipped",
      index: true,
    },

    message: {
      type: String,
      default: "",
    },

    requestId: {
      type: String,
      default: "",
    },

    errorCode: {
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

const ShopeeStockSyncLogSchema = new mongoose.Schema(
  {
    trigger: {
      type: String,
      enum: ["cron", "manual"],
      default: "cron",
      index: true,
    },

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

    totalMappings: {
      type: Number,
      default: 0,
      min: 0,
    },

    scannedCount: {
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

    unchangedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    unmappedCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    error: {
      type: String,
      default: "",
    },

    results: {
      type: [ShopeeStockSyncResultSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "shopeestock synclogs".replace(/\s/g, ""),
  },
);

ShopeeStockSyncLogSchema.index({ startedAt: -1 });
ShopeeStockSyncLogSchema.index({ trigger: 1, startedAt: -1 });
ShopeeStockSyncLogSchema.index({ status: 1, startedAt: -1 });

module.exports =
  mongoose.models.ShopeeStockSyncLog ||
  mongoose.model("ShopeeStockSyncLog", ShopeeStockSyncLogSchema);
