const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "SHOPEE_AUTO_STOCK",
    },

    ownerToken: {
      type: String,
      default: "",
    },

    lockedUntil: {
      type: Date,
      default: null,
    },

    acquiredAt: {
      type: Date,
      default: null,
    },
  },
  {
    versionKey: false,
  },
);

module.exports =
  mongoose.models.ShopeeAutoStockJobLock ||
  mongoose.model("ShopeeAutoStockJobLock", schema);
