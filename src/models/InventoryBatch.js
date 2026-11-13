const mongoose = require("mongoose");

const inventoryBatchSchema = new mongoose.Schema(
  {
    batchCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
      index: true,
    },

    productTitle: {
      type: String,
      default: "",
    },

    productCode: {
      type: String,
      default: "",
    },

    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    // Mã biến thể chuẩn dùng để truy vấn FIFO.
    variantCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    importDate: {
      type: Date,
      default: Date.now,
      index: true,
    },

    importQty: {
      type: Number,
      required: true,
      min: 0,
    },

    remainingQty: {
      type: Number,
      required: true,
      min: 0,
    },

    // Số lượng đã được giữ cho các đơn chưa hoàn tất.
    reservedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Giá vốn lưu bằng CNY.
    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    importReceiptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryReceipt",
      default: null,
    },

    importHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryHistory",
      default: null,
    },

    source: {
      type: String,
      enum: ["IMPORT", "OPENING", "ADJUSTMENT", "RETURN", "OTHER"],
      default: "IMPORT",
      set: (value) => {
        const normalized = String(value || "IMPORT")
          .trim()
          .toUpperCase();

        const aliases = {
          MANUAL: "IMPORT",
          HISTORICAL: "OTHER",
        };

        return aliases[normalized] || normalized;
      },
    },
    sourceConfidence: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "high",
      set: (value) =>
        String(value || "high")
          .trim()
          .toLowerCase(),
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

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// =====================================================
// INDEX FIFO
// =====================================================

// Ưu tiên tìm theo variantCode.
inventoryBatchSchema.index({
  productId: 1,
  variantCode: 1,
  importDate: 1,
  _id: 1,
});

// Tương thích dữ liệu lô cũ chưa có variantCode.
inventoryBatchSchema.index({
  productId: 1,
  variantName: 1,
  importDate: 1,
  _id: 1,
});

// Truy vấn lô còn tồn.
inventoryBatchSchema.index({
  productId: 1,
  variantCode: 1,
  remainingQty: 1,
  isActive: 1,
});

const InventoryBatch =
  mongoose.models.InventoryBatch ||
  mongoose.model("InventoryBatch", inventoryBatchSchema);

module.exports = InventoryBatch;
