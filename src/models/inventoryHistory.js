const mongoose = require("mongoose");

const inventoryHistorySchema = new mongoose.Schema(
  {
    // ========================================================
    // LOẠI BIẾN ĐỘNG KHO
    // ========================================================
    type: {
      type: String,

      enum: ["import", "export", "adjustment", "order", "cancel"],

      required: true,

      index: true,
    },

    // ========================================================
    // LOẠI ĐỐI TƯỢNG THAM CHIẾU
    // ========================================================
    // Ví dụ:
    // Order
    // InventoryReceipt
    // Product
    // ========================================================

    referenceType: {
      type: String,

      default: "",

      trim: true,
    },

    // ========================================================
    // ID ĐỐI TƯỢNG THAM CHIẾU
    // ========================================================

    referenceId: {
      type: mongoose.Schema.Types.ObjectId,

      default: null,

      index: true,
    },

    // ========================================================
    // MÃ THAM CHIẾU
    // Ví dụ:
    // DH20260924-0004
    // NK260926001
    // ========================================================

    referenceCode: {
      type: String,

      default: "",

      trim: true,

      index: true,
    },

    // ========================================================
    // PRODUCT
    // ========================================================

    productId: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "Product",

      required: true,

      index: true,
    },

    // ========================================================
    // TÊN SẢN PHẨM
    // ========================================================

    productTitle: {
      type: String,

      default: "",

      trim: true,
    },

    // ========================================================
    // MÃ SẢN PHẨM
    // ========================================================

    productCode: {
      type: String,

      default: "",

      trim: true,
    },

    // ========================================================
    // PHÂN LOẠI
    // ========================================================

    variantName: {
      type: String,

      default: "",

      trim: true,
    },

    // ========================================================
    // SỐ LƯỢNG THAY ĐỔI
    //
    // Nhập kho  : +100
    // Xuất kho  : -100
    // Rollback  : +100
    // ========================================================

    qty: {
      type: Number,

      required: true,
    },

    // ========================================================
    // TỒN TRƯỚC KHI THAY ĐỔI
    // ========================================================

    beforeQty: {
      type: Number,

      default: 0,
    },

    // ========================================================
    // TỒN SAU KHI THAY ĐỔI
    // ========================================================

    afterQty: {
      type: Number,

      default: 0,
    },

    // ========================================================
    // GHI CHÚ
    // ========================================================

    note: {
      type: String,

      default: "",

      trim: true,
    },

    // ========================================================
    // NGƯỜI THỰC HIỆN
    // ========================================================

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      default: null,

      index: true,
    },

    // ========================================================
    // ĐÁNH DẤU ĐÃ ROLLBACK
    // ========================================================

    rollback: {
      type: Boolean,

      default: false,

      index: true,
    },

    // ========================================================
    // THỜI GIAN ROLLBACK
    // ========================================================

    rollback_at: {
      type: Date,

      default: null,
    },

    // ========================================================
    // NGƯỜI THỰC HIỆN ROLLBACK
    // ========================================================

    rollbackBy: {
      type: mongoose.Schema.Types.ObjectId,

      ref: "User",

      default: null,
    },

    // ========================================================
    // THỜI GIAN TẠO
    // ========================================================

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

// ============================================================
// INDEX
// ============================================================

// Lấy lịch sử mới nhất
inventoryHistorySchema.index({
  created_at: -1,
});

// Tìm lịch sử theo sản phẩm
inventoryHistorySchema.index({
  productId: 1,
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

// Tìm theo loại lịch sử
inventoryHistorySchema.index({
  type: 1,
  created_at: -1,
});

module.exports = mongoose.model("inventoryHistory", inventoryHistorySchema);
