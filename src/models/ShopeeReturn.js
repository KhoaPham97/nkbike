const mongoose = require("mongoose");

const shopeeReturnItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, default: "" },
    modelId: { type: String, default: "0" },
    itemName: { type: String, default: "" },
    modelName: { type: String, default: "" },
    itemSku: { type: String, default: "" },
    variationSku: { type: String, default: "" },

    requestedQty: { type: Number, default: 0, min: 0 },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      default: null,
    },
    variantCode: { type: String, default: "" },
    variantName: { type: String, default: "" },

    mappingStatus: {
      type: String,
      enum: ["unmapped", "mapped", "ambiguous"],
      default: "unmapped",
    },

    receivedQty: { type: Number, default: 0, min: 0 },
    goodQty: { type: Number, default: 0, min: 0 },
    damagedQty: { type: Number, default: 0, min: 0 },
    restockedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const shopeeReturnSchema = new mongoose.Schema(
  {
    shopId: { type: String, required: true, index: true },
    returnSn: { type: String, required: true },
    orderSn: { type: String, default: "", index: true },

    shopeeStatus: { type: String, default: "" },
    reason: { type: String, default: "" },
    textReason: { type: String, default: "" },

    refundAmount: { type: Number, default: 0 },
    currency: { type: String, default: "VND" },

    needsLogistics: { type: Boolean, default: false },
    trackingNumber: { type: String, default: "" },
    validationType: { type: String, default: "" },
    requestType: { type: Number, default: null },

    createTime: { type: Date, default: null },
    updateTime: { type: Date, default: null },
    returnShipDueDate: { type: Date, default: null },
    returnSellerDueDate: { type: Date, default: null },
    orderItemKey: {
      type: String,
      default: "",
    },
    // Số lượng hàng hoàn theo đơn vị sản phẩm Shopee
    requestedShopeeQty: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Hệ số quy đổi tại thời điểm ghi nhận phiếu hoàn
    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "quantityMultiplier phải là số nguyên dương",
      },
    },

    // Số lượng đã thực sự cộng lại vào kho, theo đơn vị kho
    restockedStockQty: {
      type: Number,
      default: 0,
      min: 0,
    },
    items: { type: [shopeeReturnItemSchema], default: [] },

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

    receivedAt: { type: Date, default: null },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    inspectedAt: { type: Date, default: null },
    inspectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    lastSyncedAt: { type: Date, default: Date.now },
    rawData: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, versionKey: false },
);

shopeeReturnSchema.index({ shopId: 1, returnSn: 1 }, { unique: true });

shopeeReturnSchema.index({ shopId: 1, updateTime: -1 });
shopeeReturnSchema.index({ shopId: 1, warehouseStatus: 1 });

module.exports =
  mongoose.models.ShopeeReturn ||
  mongoose.model("ShopeeReturn", shopeeReturnSchema);
