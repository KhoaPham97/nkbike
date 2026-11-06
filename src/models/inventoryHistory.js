const mongoose = require("mongoose");

const inventoryHistorySchema = new mongoose.Schema(
  {
    // LOẠI BIẾN ĐỘNG KHO
    type: {
      type: String,
      enum: ["import", "export", "adjustment", "order", "cancel"],
      required: true,
      index: true,
    },

    // ĐỐI TƯỢNG THAM CHIẾU
    referenceType: {
      type: String,
      default: "",
      trim: true,
    },

    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    referenceCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    // PRODUCT
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },

    productTitle: {
      type: String,
      default: "",
      trim: true,
    },

    productCode: {
      type: String,
      default: "",
      trim: true,
    },

    // VARIANT
    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    variantCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    // LÔ NHẬP GỐC
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InventoryBatch",
      default: null,
      index: true,
    },

    batchCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    unitCost: {
      type: Number,
      default: 0,
    },

    // SỐ LƯỢNG THAY ĐỔI
    qty: {
      type: Number,
      required: true,
    },

    beforeQty: {
      type: Number,
      default: 0,
    },

    afterQty: {
      type: Number,
      default: 0,
    },

    // GHI CHÚ
    note: {
      type: String,
      default: "",
      trim: true,
    },

    // NGƯỜI THỰC HIỆN
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // ROLLBACK
    rollback: {
      type: Boolean,
      default: false,
      index: true,
    },

    rollback_at: {
      type: Date,
      default: null,
    },

    rollbackBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // THỜI GIAN TẠO
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
  },
);

// INDEX
inventoryHistorySchema.index({
  created_at: -1,
});

inventoryHistorySchema.index({
  productId: 1,
  created_at: -1,
});

// Tìm lịch sử theo biến thể
inventoryHistorySchema.index({
  productId: 1,
  variantCode: 1,
  created_at: -1,
});

// Tìm lịch sử theo đơn hàng
inventoryHistorySchema.index({
  referenceType: 1,
  referenceId: 1,
});

// Tìm theo mã đơn / mã phiếu
inventoryHistorySchema.index({
  referenceCode: 1,
  created_at: -1,
});

// Tìm lịch sử theo loại
inventoryHistorySchema.index({
  type: 1,
  created_at: -1,
});

// Tìm lịch sử theo lô
inventoryHistorySchema.index({
  batchId: 1,
  created_at: -1,
});

module.exports =
  mongoose.models.inventoryHistory ||
  mongoose.model("inventoryHistory", inventoryHistorySchema);
