const mongoose = require("mongoose");

// =====================================================
// STOCK ALLOCATION
// =====================================================

const allocationSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },

    variantCode: {
      type: String,
      default: "",
      trim: true,
    },

    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryBatch",
      default: null,
    },

    batchCode: {
      type: String,
      default: "",
    },

    qty: {
      type: Number,
      required: true,
      min: 0,
    },

    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    beforeQty: {
      type: Number,
      default: 0,
    },

    afterQty: {
      type: Number,
      default: 0,
    },
  },
  {
    _id: false,
  },
);

// =====================================================
// SHOPEE STOCK TRANSACTION
// =====================================================

const shopeeStockTransactionSchema = new mongoose.Schema(
  {
    // Khóa chống xử lý trùng.
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    shopId: {
      type: String,
      required: true,
      index: true,
    },

    kind: {
      type: String,
      required: true,
      enum: [
        "order_reserve",
        "order_release",
        "order_export",
        "return_import",
        "return_adjustment",
      ],
      index: true,
    },

    orderSn: {
      type: String,
      default: "",
      index: true,
    },

    returnSn: {
      type: String,
      default: "",
      index: true,
    },

    // Khóa dòng hàng hoặc mã tham chiếu riêng.
    itemKey: {
      type: String,
      default: "",
    },

    allocations: {
      type: [allocationSchema],
      default: [],
    },

    totalQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: ["completed", "failed"],
      default: "completed",
      index: true,
    },

    note: {
      type: String,
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "admins",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// =====================================================
// INDEX
// =====================================================

shopeeStockTransactionSchema.index({
  shopId: 1,
  orderSn: 1,
  kind: 1,
  createdAt: -1,
});

shopeeStockTransactionSchema.index({
  shopId: 1,
  returnSn: 1,
  kind: 1,
});

const ShopeeStockTransaction =
  mongoose.models.ShopeeStockTransaction ||
  mongoose.model("ShopeeStockTransaction", shopeeStockTransactionSchema);

module.exports = ShopeeStockTransaction;
