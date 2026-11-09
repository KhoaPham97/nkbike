const mongoose = require("mongoose");

const shopeeReviewTemplateSchema = new mongoose.Schema(
  {
    // Shop Shopee sở hữu mẫu trả lời
    shopId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    // Mức đánh giá từ 1 đến 5 sao
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      index: true,
    },

    // Tên mẫu trả lời
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    // Nội dung phản hồi
    // Hỗ trợ: {shopName}, {productName}, {customerName}
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },

    // Mẫu mặc định của mức sao tương ứng
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Có được sử dụng khi tạo bản nháp không
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Tối ưu truy vấn mẫu theo shop và số sao
shopeeReviewTemplateSchema.index({
  shopId: 1,
  rating: 1,
  isActive: 1,
});

// Đảm bảo mỗi shop chỉ có một mẫu mặc định cho mỗi mức sao.
// Chỉ áp dụng với những mẫu có isDefault = true.
shopeeReviewTemplateSchema.index(
  { shopId: 1, rating: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDefault: true,
    },
  },
);

module.exports =
  mongoose.models.ShopeeReviewTemplate ||
  mongoose.model("ShopeeReviewTemplate", shopeeReviewTemplateSchema);
