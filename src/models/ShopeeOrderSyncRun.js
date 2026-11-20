const mongoose = require("mongoose");

const shopeeOrderSyncOrderSchema = new mongoose.Schema(
  {
    shopId: { type: String, default: "" },
    orderSn: { type: String, default: "" },
    orderStatus: { type: String, default: "" },
    stockStatus: { type: String, default: "" },
    action: { type: String, default: "checked" },
    reservedQty: { type: Number, default: 0 },
    reservedAdded: { type: Number, default: 0 },
    itemCount: { type: Number, default: 0 },
    message: { type: String, default: "" },
    processedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    status: { type: String, enum: ["running", "success", "partial", "failed", "skipped"], default: "running", index: true },
    trigger: { type: String, enum: ["cron", "manual"], default: "cron" },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
    shopCount: { type: Number, default: 0 },
    fetched: { type: Number, default: 0 },
    saved: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    deducted: { type: Number, default: 0 },
    released: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    message: { type: String, default: "" },
    orders: { type: [shopeeOrderSyncOrderSchema], default: [] },
    shopResults: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true, versionKey: false },
);

schema.index({ startedAt: -1 });

module.exports =
  mongoose.models.ShopeeOrderSyncRun ||
  mongoose.model("ShopeeOrderSyncRun", schema);
