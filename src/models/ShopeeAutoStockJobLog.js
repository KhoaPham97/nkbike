const mongoose = require("mongoose");

const shopeeAutoStockSettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "SHOPEE_AUTO_STOCK_SETTINGS",
    },

    enabled: {
      type: Boolean,
      default: false,
    },

    intervalMinutes: {
      type: Number,
      enum: [1, 5, 10, 15, 30, 60],
      default: 5,
    },

    batchSize: {
      type: Number,
      default: 100,
      min: 1,
      max: 500,
    },

    lastRunAt: {
      type: Date,
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "admins",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

module.exports =
  mongoose.models.ShopeeAutoStockSettings ||
  mongoose.model("ShopeeAutoStockSettings", shopeeAutoStockSettingsSchema);
