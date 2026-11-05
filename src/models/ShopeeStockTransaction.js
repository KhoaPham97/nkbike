const mongoose = require("mongoose");

const stockAllocationSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },
    variantCode: { type: String, default: "" },
    variantName: { type: String, default: "" },

    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryBatch",
      default: null,
    },
    batchCode: { type: String, default: "" },

    qty: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    beforeQty: { type: Number, default: 0 },
    afterQty: { type: Number, default: 0 },
  },
  { _id: false },
);

const shopeeStockTransactionSchema = new mongoose.Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true },

    shopId: { type: String, required: true, index: true },

    kind: {
      type: String,
      enum: ["order_export", "return_import", "return_adjustment"],
      required: true,
      index: true,
    },

    orderSn: { type: String, default: "", index: true },
    returnSn: { type: String, default: "", index: true },

    // Khóa dòng sản phẩm trong đơn/yêu cầu trả.
    itemKey: { type: String, default: "" },

    allocations: {
      type: [stockAllocationSchema],
      default: [],
    },

    totalQty: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["completed"],
      default: "completed",
    },

    note: { type: String, default: "" },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

shopeeStockTransactionSchema.index({ shopId: 1, orderSn: 1 });
shopeeStockTransactionSchema.index({ shopId: 1, returnSn: 1 });

module.exports =
  mongoose.models.ShopeeStockTransaction ||
  mongoose.model("ShopeeStockTransaction", shopeeStockTransactionSchema);
