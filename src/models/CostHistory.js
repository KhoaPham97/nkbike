const mongoose = require("mongoose");

const costHistorySchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
      index: true,
    },
    productTitle: { type: String, default: "" },
    productCode: { type: String, default: "" },
    variantName: { type: String, required: true },
    oldUnitCost: { type: Number, default: 0 },
    newUnitCost: { type: Number, required: true },
    changedBy: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

costHistorySchema.index({ productId: 1, variantName: 1, createdAt: -1 });

module.exports = mongoose.model("CostHistory", costHistorySchema);
