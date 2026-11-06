const mongoose = require("mongoose");

const shopeeSkuMappingSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Shopee item
    itemId: {
      type: String,
      required: true,
      trim: true,
    },

    // Shopee model; sản phẩm không có phân loại thường dùng "0".
    modelId: {
      type: String,
      default: "0",
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

    // Sản phẩm nội bộ Nhật Khang Bike
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
      index: true,
    },

    variantCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    // Một đơn vị Shopee tương ứng bao nhiêu đơn vị kho nội bộ.
    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "quantityMultiplier phải là số nguyên",
      },
    },

    // Bật/tắt ánh xạ.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Bật/tắt tác động đến tồn kho.
    // false: vẫn đồng bộ đơn nhưng không giữ/trừ kho.
    allowStockDeduction: {
      type: Boolean,
      default: false,
      index: true,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Mỗi Shopee SKU chỉ có một ánh xạ trong một shop.
shopeeSkuMappingSchema.index(
  {
    shopId: 1,
    itemId: 1,
    modelId: 1,
  },
  {
    unique: true,
    name: "unique_shopee_sku_mapping",
  },
);

shopeeSkuMappingSchema.index({
  shopId: 1,
  isActive: 1,
  allowStockDeduction: 1,
});

shopeeSkuMappingSchema.index({
  productId: 1,
  variantCode: 1,
});

module.exports =
  mongoose.models.ShopeeSkuMapping ||
  mongoose.model("ShopeeSkuMapping", shopeeSkuMappingSchema);
