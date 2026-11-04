const mongoose = require("mongoose");

const shopeeShopSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    accessToken: {
      type: String,
      required: true,
      select: false,
    },
    refreshToken: {
      type: String,
      required: true,
      select: false,
    },
    accessTokenExpiresAt: Date,
    refreshTokenExpiresAt: Date,
    status: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "connected",
    },
    lastConnectedAt: Date,
    lastRefreshedAt: Date,
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.ShopeeShop || mongoose.model("ShopeeShop", shopeeShopSchema);
