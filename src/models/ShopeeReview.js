const mongoose = require("mongoose");

const shopeeReviewSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    commentId: {
      type: String,
      required: true,
      trim: true,
    },

    orderSn: {
      type: String,
      default: "",
      trim: true,
    },

    productId: {
      type: String,
      default: "",
      trim: true,
    },

    itemId: {
      type: String,
      default: "",
      trim: true,
    },

    modelId: {
      type: String,
      default: "",
      trim: true,
    },

    productName: {
      type: String,
      default: "",
      trim: true,
    },

    productImage: {
      type: String,
      default: "",
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

    variantCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    mappingStatus: {
      type: String,
      enum: ["unmapped", "mapped", "ambiguous"],
      default: "unmapped",
      index: true,
    },

    customerName: {
      type: String,
      default: "",
      trim: true,
    },

    customerUsername: {
      type: String,
      default: "",
      trim: true,
    },

    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      index: true,
    },

    content: {
      type: String,
      default: "",
      trim: true,
    },

    hidden: { type: Boolean, default: false, index: true },

    images: {
      type: [String],
      default: [],
    },

    videos: {
      type: [String],
      default: [],
    },

    reviewCreatedAt: {
      type: Date,
      default: null,
    },

    // Phản hồi đã tồn tại trên Shopee
    shopeeReply: {
      type: String,
      default: "",
      trim: true,
    },

    shopeeRepliedAt: {
      type: Date,
      default: null,
    },

    // Nội dung phản hồi đang chờ duyệt
    replyDraft: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShopeeReviewTemplate",
      default: null,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "drafted",
        "approved",
        "rejected",
        "sending",
        "replied",
        "failed",
      ],
      default: "pending",
      index: true,
    },

    // Lỗi gần nhất khi gửi phản hồi
    lastError: {
      type: String,
      default: "",
    },

    // Thời điểm đồng bộ gần nhất
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },

    // Thời điểm admin duyệt
    approvedAt: {
      type: Date,
      default: null,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // Thời điểm gửi phản hồi thành công
    repliedAt: {
      type: Date,
      default: null,
    },

    // Lưu lịch sử thay đổi nội dung phản hồi
    replyHistory: [
      {
        content: {
          type: String,
          default: "",
        },

        action: {
          type: String,
          enum: ["draft", "approve", "reject", "send", "sync"],
          default: "draft",
        },

        adminId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null,
        },

        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Một đánh giá chỉ được lưu một lần trong mỗi shop
shopeeReviewSchema.index({ shopId: 1, commentId: 1 }, { unique: true });

shopeeReviewSchema.index({
  shopId: 1,
  status: 1,
  reviewCreatedAt: -1,
});

shopeeReviewSchema.index({
  shopId: 1,
  rating: 1,
  reviewCreatedAt: -1,
});

shopeeReviewSchema.index({
  productId: 1,
  hidden: 1,
  reviewCreatedAt: -1,
});

shopeeReviewSchema.index({
  shopId: 1,
  itemId: 1,
  hidden: 1,
  reviewCreatedAt: -1,
});

module.exports =
  mongoose.models.ShopeeReview ||
  mongoose.model("ShopeeReview", shopeeReviewSchema);
