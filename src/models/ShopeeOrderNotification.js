const mongoose = require("mongoose");

const shopeeOrderNotificationSchema = new mongoose.Schema(
  {
    source: { type: String, default: "shopee", immutable: true },
    shopId: { type: String, required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "ShopeeOrder", default: null },
    orderSn: { type: String, required: true, trim: true },
    customerName: { type: String, default: "Khách Shopee" },
    // Snapshot tên sản phẩm và số lượng để thông báo không phụ thuộc dữ liệu đơn tải riêng.
    items: {
      type: [{
        itemName: { type: String, default: "Sản phẩm Shopee" },
        modelName: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
      }],
      default: [],
    },
    totalAmount: { type: Number, default: 0 },
    orderCreatedAt: { type: Date, default: null },
    read: { type: Boolean, default: false, index: true },
    notifiedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false },
);

shopeeOrderNotificationSchema.index({ shopId: 1, orderSn: 1 }, { unique: true });
shopeeOrderNotificationSchema.index({ notifiedAt: -1, read: 1 });

module.exports =
  mongoose.models.ShopeeOrderNotification ||
  mongoose.model("ShopeeOrderNotification", shopeeOrderNotificationSchema);
