const mongoose = require("mongoose");

// =====================================================
// SHOPEE RETURN ITEM
// =====================================================

const shopeeReturnItemSchema = new mongoose.Schema(
  {
    itemId: {
      type: String,
      default: "",
      trim: true,
    },

    modelId: {
      type: String,
      default: "0",
      trim: true,
    },

    itemName: {
      type: String,
      default: "",
      trim: true,
    },

    modelName: {
      type: String,
      default: "",
      trim: true,
    },

    itemSku: {
      type: String,
      default: "",
      trim: true,
    },

    variationSku: {
      type: String,
      default: "",
      trim: true,
    },

    image: {
      type: String,
      default: "",
    },

    // Số lượng theo đơn vị Shopee đã quy đổi sang đơn vị kho.
    requestedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Hệ số quy đổi SKU Shopee sang đơn vị kho.
    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 1,
    },

    receivedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    goodQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    damagedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    restockedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

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

    // Trạng thái mapping SKU mới.
    mappingStatus: {
      type: String,
      enum: ["unmapped", "mapped", "ambiguous"],
      default: "unmapped",
    },

    // Tương thích dữ liệu cũ.
    isMapped: {
      type: Boolean,
      default: false,
    },

    inspectionNote: {
      type: String,
      default: "",
      trim: true,
    },

    stockProcessed: {
      type: Boolean,
      default: false,
    },

    stockProcessedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: true,
  },
);

// =====================================================
// SHOPEE RETURN
// =====================================================

const shopeeReturnSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // CUSTOMER_RETURN hoặc DELIVERY_FAILED.
    returnType: {
      type: String,
      enum: ["CUSTOMER_RETURN", "DELIVERY_FAILED"],
      default: "CUSTOMER_RETURN",
      index: true,
    },

    sourceType: {
      type: String,
      enum: ["CUSTOMER_RETURN", "DELIVERY_FAILED"],
      default: "CUSTOMER_RETURN",
    },

    // Mã phiếu nội bộ.
    // Khách trả hàng: return_sn của Shopee.
    // Giao thất bại: DELIVERY-{package_number}.
    returnSn: {
      type: String,
      required: true,
      trim: true,
    },

    orderSn: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Chỉ có với phiếu giao thất bại.
    packageNumber: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    buyerUsername: {
      type: String,
      default: "",
      trim: true,
    },

    returnReason: {
      type: String,
      default: "",
    },

    returnDescription: {
      type: String,
      default: "",
    },

    // Các trường chuẩn hóa từ Shopee.
    reason: {
      type: String,
      default: "",
    },

    textReason: {
      type: String,
      default: "",
    },

    refundAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    currency: {
      type: String,
      default: "VND",
    },

    // Trạng thái gốc từ Shopee.
    shopeeReturnStatus: {
      type: String,
      default: "",
      index: true,
    },

    shopeeStatus: {
      type: String,
      default: "",
      index: true,
    },

    // Mã vận đơn.
    trackingNumber: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    needsLogistics: {
      type: Boolean,
      default: false,
    },

    validationType: {
      type: String,
      default: "",
    },

    requestType: {
      type: Number,
      default: null,
    },

    createTime: {
      type: Date,
      default: null,
    },

    updateTime: {
      type: Date,
      default: null,
      index: true,
    },

    returnShipDueDate: {
      type: Date,
      default: null,
    },

    returnSellerDueDate: {
      type: Date,
      default: null,
    },

    orderItemKey: {
      type: String,
      default: "",
    },

    requestedShopeeQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 1,
    },

    restockedStockQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    items: {
      type: [shopeeReturnItemSchema],
      default: [],
    },

    // =================================================
    // TRẠNG THÁI KHO MỚI
    // =================================================

    warehouseStatus: {
      type: String,
      enum: [
        "waiting",
        "in_transit",
        "received",
        "inspected",
        "partially_restocked",
        "restocked",
        "closed",
      ],
      default: "waiting",
      index: true,
    },

    // =================================================
    // TƯƠNG THÍCH TRẠNG THÁI CŨ
    // =================================================

    status: {
      type: String,
      enum: [
        "RETURN_REQUESTED",
        "RETURN_APPROVED",
        "RETURN_SHIPPING",
        "RETURNED",
        "RECEIVED",
        "INSPECTED",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "RETURN_REQUESTED",
      index: true,
    },

    isReceived: {
      type: Boolean,
      default: false,
      index: true,
    },

    receivedAt: {
      type: Date,
      default: null,
    },

    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    isInspected: {
      type: Boolean,
      default: false,
    },

    inspectedAt: {
      type: Date,
      default: null,
    },

    inspectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    // =================================================
    // QUYẾT ĐỊNH NHẬP KHO
    // =================================================

    resolution: {
      type: String,
      enum: ["RESTOCK", "NO_RESTOCK", null],
      default: null,
    },

    resolutionNote: {
      type: String,
      default: "",
      trim: true,
    },

    resolutionAt: {
      type: Date,
      default: null,
    },

    resolutionBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    // Alias tương thích service mới.
    resolvedAt: {
      type: Date,
      default: null,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    stockProcessed: {
      type: Boolean,
      default: false,
      index: true,
    },

    stockProcessedAt: {
      type: Date,
      default: null,
    },

    // =================================================
    // THỐNG KÊ
    // =================================================

    totalRequestedQty: {
      type: Number,
      default: 0,
    },

    totalReceivedQty: {
      type: Number,
      default: 0,
    },

    totalGoodQty: {
      type: Number,
      default: 0,
    },

    totalDamagedQty: {
      type: Number,
      default: 0,
    },

    // =================================================
    // DỮ LIỆU ĐỒNG BỘ
    // =================================================

    rawShopeeData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    syncedAt: {
      type: Date,
      default: Date.now,
    },

    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },

    lastSyncError: {
      type: String,
      default: "",
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
    collection: "shopee_returns",
  },
);

// =====================================================
// INDEX
// =====================================================

// Mỗi phiếu chỉ tồn tại một lần trong mỗi shop.
shopeeReturnSchema.index(
  {
    shopId: 1,
    returnSn: 1,
  },
  {
    unique: true,
    name: "unique_shopee_return_per_shop",
  },
);

shopeeReturnSchema.index({
  shopId: 1,
  status: 1,
  createdAt: -1,
});

shopeeReturnSchema.index({
  shopId: 1,
  warehouseStatus: 1,
  updateTime: -1,
});

shopeeReturnSchema.index({
  shopId: 1,
  returnType: 1,
  updateTime: -1,
});

shopeeReturnSchema.index({
  orderSn: 1,
  shopId: 1,
});

shopeeReturnSchema.index({
  packageNumber: 1,
  shopId: 1,
});

// =====================================================
// MODEL
// =====================================================

const ShopeeReturn =
  mongoose.models.ShopeeReturn ||
  mongoose.model("ShopeeReturn", shopeeReturnSchema);

module.exports = ShopeeReturn;
