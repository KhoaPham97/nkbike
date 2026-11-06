const mongoose = require("mongoose");

// =====================================================
// SHOPEE ORDER ITEM
// =====================================================

const shopeeOrderItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: String,
      default: "",
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

    itemSku: {
      type: String,
      default: "",
    },

    variationSku: {
      type: String,
      default: "",
    },

    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },

    unitPrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalPrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    // =================================================
    // MAPPING SNAPSHOT
    // =================================================

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      default: null,
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

    mappingStatus: {
      type: String,
      enum: ["unmapped", "mapped", "ambiguous"],
      default: "unmapped",
    },

    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 0.000001,
    },

    allowStockDeduction: {
      type: Boolean,
      default: false,
    },

    // =================================================
    // INVENTORY TRACKING
    // =================================================

    // Số lượng đang giữ cho đơn này.
    reservedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng đã xuất kho thực tế.
    deductedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng đã nhận hàng hoàn.
    returnedQty: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    _id: false,
  },
);

// =====================================================
// SHOPEE ORDER
// =====================================================

const shopeeOrderSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      index: true,
    },

    orderSn: {
      type: String,
      required: true,
      trim: true,
    },

    orderStatus: {
      type: String,
      default: "",
      index: true,
    },

    buyerUsername: {
      type: String,
      default: "",
    },

    recipientName: {
      type: String,
      default: "",
    },

    recipientPhone: {
      type: String,
      default: "",
    },

    recipientAddress: {
      type: String,
      default: "",
    },

    paymentMethod: {
      type: String,
      default: "",
    },

    totalAmount: {
      type: Number,
      default: 0,
    },

    shippingCarrier: {
      type: String,
      default: "",
    },

    createTime: {
      type: Date,
      default: null,
    },

    updateTime: {
      type: Date,
      default: null,
    },

    items: {
      type: [shopeeOrderItemSchema],
      default: [],
    },

    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },

    // =================================================
    // STOCK STATUS
    // =================================================

    stockStatus: {
      type: String,
      enum: [
        "pending",
        "unmapped",
        "ready",
        "partially_deducted",
        "deducted",
        "blocked",
      ],
      default: "pending",
      index: true,
    },

    // Đơn đã được xuất kho vật lý hoàn toàn hay chưa.
    stockDeducted: {
      type: Boolean,
      default: false,
      index: true,
    },

    stockReservedAt: {
      type: Date,
      default: null,
    },

    stockReleasedAt: {
      type: Date,
      default: null,
    },

    stockDeductedAt: {
      type: Date,
      default: null,
    },

    stockDeductedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "admins",
      default: null,
    },

    stockReturnedAt: {
      type: Date,
      default: null,
    },

    // Đánh dấu đã nhận đủ hàng hoàn của đơn.
    returnReceived: {
      type: Boolean,
      default: false,
    },

    // Tổng số lượng đã nhận hoàn.
    returnedQty: {
      type: Number,
      default: 0,
      min: 0,
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

shopeeOrderSchema.index(
  {
    shopId: 1,
    orderSn: 1,
  },
  {
    unique: true,
  },
);

shopeeOrderSchema.index({
  shopId: 1,
  orderStatus: 1,
  updateTime: -1,
});

shopeeOrderSchema.index({
  shopId: 1,
  stockStatus: 1,
});

const ShopeeOrder =
  mongoose.models.ShopeeOrder ||
  mongoose.model("ShopeeOrder", shopeeOrderSchema);

module.exports = ShopeeOrder;
