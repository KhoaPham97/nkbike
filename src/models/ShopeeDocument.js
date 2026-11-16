const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  kind: { type: String, enum: ["income_statement", "income_report"], required: true },
  periodKey: { type: String, required: true },
  periodFrom: { type: Date, required: true },
  periodTo: { type: Date, required: true },
  remoteId: { type: String, default: "" },
  requestId: { type: String, default: "" },
  fileName: { type: String, default: "" },
  filePublicId: { type: String, default: "" },
  fileFormat: { type: String, default: "zip" },
  status: { type: String, enum: ["requested","processing","ready","downloaded","failed"], default: "requested", index: true },
  remoteStatus: { type: Number, default: null },
  error: { type: String, default: "" },
  lastCheckedAt: { type: Date, default: null },
  downloadedAt: { type: Date, default: null },
  createdBy: { type: String, default: "" },
}, { timestamps: true, versionKey: false });
schema.index({ shopId: 1, kind: 1, periodKey: 1 }, { unique: true });
schema.index({ shopId: 1, createdAt: -1 });
module.exports = mongoose.models.ShopeeDocument || mongoose.model("ShopeeDocument", schema);
