const mongoose = require("mongoose");

const inventoryBatchSchema = new mongoose.Schema(
  {
    batchCode: { type: String, required: true, unique: true, index: true },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
      index: true,
    },
    productTitle: { type: String, default: "" },
    productCode: { type: String, default: "" },
    variantName: { type: String, default: "", trim: true, index: true },
    importDate: { type: Date, default: Date.now, index: true },
    importQty: { type: Number, required: true, min: 0 },
    remainingQty: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    importReceiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryReceipt",
      default: null,
    },
    importHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    source: {
      type: String,
      enum: ["receipt", "historical", "opening", "manual"],
      default: "receipt",
      index: true,
    },
    sourceConfidence: {
      type: String,
      enum: ["recorded", "inferred", "unknown"],
      default: "recorded",
    },
    note: { type: String, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, versionKey: false },
);

inventoryBatchSchema.index({ productId: 1, variantName: 1, importDate: 1 });
inventoryBatchSchema.index({ productId: 1, variantName: 1, remainingQty: 1 });

module.exports =
  mongoose.models.InventoryBatch ||
  mongoose.model("InventoryBatch", inventoryBatchSchema);
