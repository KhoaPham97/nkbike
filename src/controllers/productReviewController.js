const { Product } = require("../models/products");
const ShopeeReview = require("../models/ShopeeReview");

async function getProductReviews(req, res) {
  try {
    const product = await Product.findById(req.params.id).select("_id title shopeeItemId shopeeShopId").lean();
    if (!product) return res.status(404).json({ success: false, message: "Không tìm thấy sản phẩm." });

    const legacyItemFilter = product.shopeeItemId
      ? [{
          itemId: String(product.shopeeItemId),
          $or: [{ productId: "" }, { productId: { $exists: false } }],
        }]
      : [];

    const filter = {
      hidden: { $ne: true },
      ...(product.shopeeShopId ? { shopId: String(product.shopeeShopId) } : {}),
      $or: [
        { productId: String(product._id) },
        ...legacyItemFilter,
      ],
    };

    const requestedRating = Number(req.query.rating || 0);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;
    const pageFilter = {
      ...filter,
      ...(Number.isInteger(requestedRating) && requestedRating >= 1 && requestedRating <= 5
        ? { rating: requestedRating }
        : {}),
    };

    const [total, reviews, summary] = await Promise.all([
      ShopeeReview.countDocuments(pageFilter),
      ShopeeReview.find(pageFilter)
        .select("commentId customerName rating content images videos reviewCreatedAt shopeeReply shopeeRepliedAt variantCode variantName variationSku")
        .sort({ reviewCreatedAt: -1, createdAt: -1 })
        .skip(skip).limit(limit).lean(),
      ShopeeReview.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          averageRating: { $avg: "$rating" },
          five: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
          four: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
          three: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
          two: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
          one: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
        } },
      ]),
    ]);

    const stats = summary[0] || { count: 0, averageRating: 0, five: 0, four: 0, three: 0, two: 0, one: 0 };
    return res.json({
      success: true,
      productId: String(product._id),
      summary: {
        total: stats.count,
        averageRating: Number((stats.averageRating || 0).toFixed(1)),
        breakdown: { 5: stats.five, 4: stats.four, 3: stats.three, 2: stats.two, 1: stats.one },
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + reviews.length < total },
      data: reviews,
    });
  } catch (error) {
    console.error("GET PRODUCT REVIEWS ERROR:", error);
    return res.status(500).json({ success: false, message: error.message || "Không thể tải đánh giá sản phẩm." });
  }
}

module.exports = { getProductReviews };
