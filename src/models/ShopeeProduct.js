const mongoose = require("mongoose");

const shopeeProductModelSchema = new mongoose.Schema(
  {
    modelId: { type: String, default: "0" },
    modelName: { type: String, default: "" },
    modelSku: { type: String, default: "" },
    price: { type: Number, default: 0 },
    originalPrice: { type: Number, default: 0 },
    stock: { type: Number, default: 0 },
    normalStock: { type: Number, default: 0 },
    reservedStock: { type: Number, default: 0 },
    status: { type: String, default: "" },
  },
  { _id: false },
);

const shopeeProductSchema = new mongoose.Schema(
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

    itemName: {
      type: String,
      default: "",
      index: true,
    },

    itemSku: {
      type: String,
      default: "",
      index: true,
    },

    image: {
      type: String,
      default: "",
    },

    images: {
      type: [String],
      default: [],
    },

    description: {
      type: String,
      default: "",
    },

    categoryId: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      default: 0,
    },

    maxPrice: {
      type: Number,
      default: 0,
    },

    stock: {
      type: Number,
      default: 0,
    },

    status: {
      type: String,
      default: "",
      index: true,
    },

    itemStatus: {
      type: String,
      default: "",
      index: true,
    },

    models: {
      type: [shopeeProductModelSchema],
      default: [],
    },

    isDeletedOnShopee: {
      type: Boolean,
      default: false,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
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

shopeeProductSchema.index({ shopId: 1, itemId: 1 }, { unique: true });

shopeeProductSchema.index({ shopId: 1, itemSku: 1 });
shopeeProductSchema.index({ shopId: 1, itemName: 1 });
shopeeProductSchema.index({ shopId: 1, lastSyncedAt: -1 });

module.exports =
  mongoose.models.ShopeeProduct ||
  mongoose.model("ShopeeProduct", shopeeProductSchema);
