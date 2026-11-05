const mongoose = require("mongoose");

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

    // Số lượng khách đặt trên Shopee.
    quantity: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "quantity phải là số nguyên không âm",
      },
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
    },

    mappingStatus: {
      type: String,
      enum: ["unmapped", "mapped", "ambiguous"],
      default: "unmapped",
    },

    // Số lượng đã trừ khỏi kho thực tế.
    // Đây là quantity sau khi nhân quantityMultiplier.
    deductedQty: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "deductedQty phải là số nguyên không âm",
      },
    },

    // Số lượng đã được xử lý trả hàng.
    returnedQty: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "returnedQty phải là số nguyên không âm",
      },
    },
  },
  {
    _id: false,
  },
);

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

    currency: {
      type: String,
      default: "VND",
    },

    buyerUserId: {
      type: String,
      default: "",
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
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    totalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentMethod: {
      type: String,
      default: "",
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

    payTime: {
      type: Date,
      default: null,
    },

    cancelReason: {
      type: String,
      default: "",
    },

    cancelBy: {
      type: String,
      default: "",
    },

    buyerCancelReason: {
      type: String,
      default: "",
    },

    items: {
      type: [shopeeOrderItemSchema],
      default: [],
    },

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

    stockDeductedAt: {
      type: Date,
      default: null,
    },

    stockDeductedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },

    rawData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Mỗi đơn chỉ được lưu một lần trong mỗi shop.
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
  createTime: -1,
});

shopeeOrderSchema.index({
  shopId: 1,
  orderStatus: 1,
});

shopeeOrderSchema.index({
  shopId: 1,
  stockStatus: 1,
});

module.exports =
  mongoose.models.ShopeeOrder ||
  mongoose.model("ShopeeOrder", shopeeOrderSchema);
