const mongoose = require("mongoose");

const shopeeReturnStockLogSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    returnSn: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    orderSn: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    returnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShopeeReturn",
      required: true,
      index: true,
    },

    // Phương án xử lý
    resolution: {
      type: String,
      enum: ["RESTOCK", "NO_RESTOCK"],
      required: true,
    },

    // Thông tin sản phẩm được xử lý
    items: [
      {
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

        itemId: {
          type: String,
          default: "",
        },

        modelId: {
          type: String,
          default: "0",
        },

        itemSku: {
          type: String,
          default: "",
        },

        variationSku: {
          type: String,
          default: "",
        },

        // Số lượng hàng tốt được nhập lại
        goodQty: {
          type: Number,
          default: 0,
          min: 0,
        },

        // Số lượng hàng hỏng không nhập kho
        damagedQty: {
          type: Number,
          default: 0,
          min: 0,
        },

        // Tồn kho trước khi xử lý
        beforeQty: {
          type: Number,
          default: 0,
        },

        // Tồn kho sau khi xử lý
        afterQty: {
          type: Number,
          default: 0,
        },

        // Số lượng thực tế đã cộng vào kho
        restockedQty: {
          type: Number,
          default: 0,
        },

        message: {
          type: String,
          default: "",
        },
      },
    ],

    // Tổng số lượng nhập kho
    totalRestockedQty: {
      type: Number,
      default: 0,
    },

    totalDamagedQty: {
      type: Number,
      default: 0,
    },

    // Người thực hiện
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    processedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },

    // Kết quả xử lý
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED", "PARTIAL"],
      default: "SUCCESS",
      index: true,
    },

    error: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
    collection: "shopee_return_stock_logs",
  },
);

// Một yêu cầu hoàn chỉ được xử lý kho một lần.
shopeeReturnStockLogSchema.index(
  {
    shopId: 1,
    returnSn: 1,
  },
  {
    unique: true,
  },
);

shopeeReturnStockLogSchema.index({
  returnSn: 1,
  processedAt: -1,
});

const ShopeeReturnStockLog =
  mongoose.models.ShopeeReturnStockLog ||
  mongoose.model("ShopeeReturnStockLog", shopeeReturnStockLogSchema);

module.exports = ShopeeReturnStockLog;
