const mongoose = require("mongoose");

const ShopeeReviewReplyLogSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      index: true,
    },

    commentId: {
      type: String,
      required: true,
    },

    itemId: {
      type: String,
      default: "",
    },

    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 0,
    },

    customerName: {
      type: String,
      default: "",
    },

    reviewContent: {
      type: String,
      default: "",
    },

    replyContent: {
      type: String,
      default: "",
    },

    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShopeeReviewTemplate",
      default: null,
    },

    status: {
      type: String,
      enum: ["processing", "sent", "failed"],
      default: "processing",
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    errorMessage: {
      type: String,
      default: "",
    },

    processingAt: {
      type: Date,
      default: Date.now,
    },

    sentAt: {
      type: Date,
      default: null,
    },

    lastAttemptAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Một đánh giá chỉ có một bản ghi cho mỗi shop
ShopeeReviewReplyLogSchema.index(
  {
    shopId: 1,
    commentId: 1,
  },
  {
    unique: true,
    name: "unique_shopee_review_per_shop",
  },
);

// Tra cứu lịch sử theo shop và trạng thái
ShopeeReviewReplyLogSchema.index({
  shopId: 1,
  status: 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.ShopeeReviewReplyLog ||
  mongoose.model("ShopeeReviewReplyLog", ShopeeReviewReplyLogSchema);
