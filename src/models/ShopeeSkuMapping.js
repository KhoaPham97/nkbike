const mongoose = require("mongoose");

const shopeeSkuMappingSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      index: true,
    },

    itemId: {
      type: String,
      required: true,
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

    itemName: {
      type: String,
      default: "",
    },

    modelName: {
      type: String,
      default: "",
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },

    // Product.variants không có _id nên dùng code.
    variantCode: {
      type: String,
      required: true,
      trim: true,
    },

    variantName: {
      type: String,
      required: true,
      trim: true,
    },

    // Số đơn vị tồn kho nội bộ tương ứng 1 đơn vị Shopee.
    quantityMultiplier: {
      type: Number,
      default: 1,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "quantityMultiplier phải là số nguyên dương",
      },
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    note: {
      type: String,
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Mỗi phân loại Shopee chỉ có một mapping trong một shop.
shopeeSkuMappingSchema.index(
  {
    shopId: 1,
    itemId: 1,
    modelId: 1,
  },
  {
    unique: true,
  },
);

shopeeSkuMappingSchema.index({
  productId: 1,
  variantCode: 1,
});

shopeeSkuMappingSchema.index({
  shopId: 1,
  isActive: 1,
});

module.exports =
  mongoose.models.ShopeeSkuMapping ||
  mongoose.model("ShopeeSkuMapping", shopeeSkuMappingSchema);
