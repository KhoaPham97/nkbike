const mongoose = require("mongoose");

const ShopeeReviewScanProgressSchema = new mongoose.Schema(
  {
    // Mỗi shop có một tiến độ quét riêng.
    _id: {
      type: String,
      required: true,
    },

    shopId: {
      type: String,
      required: true,
      index: true,
    },

    // Danh sách sản phẩm được chụp tại đầu chu kỳ quét.
    itemIds: {
      type: [String],
      default: [],
    },

    // Vị trí sản phẩm hiện tại trong itemIds.
    itemIndex: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Cursor của trang đang quét.
    cursor: {
      type: String,
      default: "",
    },

    // Số trang đã quét ở sản phẩm hiện tại.
    pageCount: {
      type: Number,
      default: 0,
    },

    lastScannedAt: {
      type: Date,
      default: null,
    },

    cycleCompletedAt: {
      type: Date,
      default: null,
    },

    lastError: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
    collection: "shopee_review_scan_progress",
  },
);

module.exports =
  mongoose.models.ShopeeReviewScanProgress ||
  mongoose.model("ShopeeReviewScanProgress", ShopeeReviewScanProgressSchema);
