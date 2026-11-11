const mongoose = require("mongoose");

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

    // Số lượng khách yêu cầu trả
    requestedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng shop thực tế nhận lại
    receivedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng hàng tốt có thể nhập lại kho bán
    goodQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng hàng lỗi/hỏng
    damagedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Liên kết sản phẩm nội bộ
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

    // Đánh dấu đã mapping SKU
    isMapped: {
      type: Boolean,
      default: false,
    },

    // Ghi chú kiểm hàng
    inspectionNote: {
      type: String,
      default: "",
      trim: true,
    },

    // Đánh dấu đã xử lý tồn kho
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

const shopeeReturnSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Mã yêu cầu trả hàng Shopee
    returnSn: {
      type: String,
      required: true,
      trim: true,
    },

    // Mã đơn hàng Shopee
    orderSn: {
      type: String,
      required: true,
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

    refundAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    currency: {
      type: String,
      default: "VND",
    },

    // Trạng thái gốc từ Shopee
    shopeeReturnStatus: {
      type: String,
      default: "",
      index: true,
    },

    // Trạng thái xử lý nội bộ
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

    items: {
      type: [shopeeReturnItemSchema],
      default: [],
    },

    // Đã thực sự nhận hàng hoàn hay chưa
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

    // Đã kiểm tra hàng hoàn hay chưa
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

    // Phương án xử lý:
    // RESTOCK: nhập lại kho
    // NO_RESTOCK: không nhập lại, giữ nguyên phần tồn đã xuất
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

    // Đã hoàn tất xử lý kho
    stockProcessed: {
      type: Boolean,
      default: false,
      index: true,
    },

    stockProcessedAt: {
      type: Date,
      default: null,
    },

    // Tổng số lượng
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

    // Dữ liệu gốc từ Shopee để đối chiếu
    rawShopeeData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    syncedAt: {
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

// Một yêu cầu trả hàng chỉ được lưu một lần trong mỗi shop.
shopeeReturnSchema.index(
  {
    shopId: 1,
    returnSn: 1,
  },
  {
    unique: true,
  },
);

shopeeReturnSchema.index({
  shopId: 1,
  status: 1,
  createdAt: -1,
});

shopeeReturnSchema.index({
  orderSn: 1,
  shopId: 1,
});

const ShopeeReturn =
  mongoose.models.ShopeeReturn ||
  mongoose.model("ShopeeReturn", shopeeReturnSchema);

module.exports = ShopeeReturn;
