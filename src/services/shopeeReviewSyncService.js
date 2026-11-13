const ShopeeReview = require("../models/ShopeeReview");
const { Product } = require("../models/products");

async function persistShopeeReviews({ shopId, reviews = [] }) {
  const normalizedShopId = String(shopId || "").trim();
  if (!normalizedShopId) throw new Error("Thiếu shopId để lưu đánh giá.");

  const validReviews = (Array.isArray(reviews) ? reviews : []).filter((review) => {
    const id = String(review?.commentId || review?.comment_id || "").trim();
    const rating = Number(review?.rating || review?.rating_star || 0);
    return id && rating >= 1 && rating <= 5;
  });

  const itemIds = [...new Set(validReviews.map((r) => String(r.itemId || r.item_id || "").trim()).filter(Boolean))];
  const products = itemIds.length ? await Product.find({
    shopeeItemId: { $in: itemIds },
    $or: [
      { shopeeShopId: normalizedShopId },
      { shopeeShopId: "" },
      { shopeeShopId: { $exists: false } },
    ],
  }).select("_id title thumbnail shopeeItemId").lean() : [];

  const productByItemId = new Map(products.map((p) => [String(p.shopeeItemId), p]));
  const operations = validReviews.map((review) => {
    const commentId = String(review.commentId || review.comment_id).trim();
    const itemId = String(review.itemId || review.item_id || "").trim();
    const product = productByItemId.get(itemId);
    const reply = String(review.shopeeReply || review.reply || "").trim();

    const set = {
      shopId: normalizedShopId,
      commentId,
      orderSn: String(review.orderSn || ""),
      itemId,
      modelId: String(review.modelId || ""),
      productId: product ? String(product._id) : "",
      productName: product?.title || "",
      productImage: product?.thumbnail || "",
      customerName: String(review.customerName || review.customerUsername || ""),
      customerUsername: String(review.customerUsername || review.customerName || ""),
      rating: Number(review.rating || review.rating_star || 0),
      content: String(review.content || ""),
      hidden: Boolean(review.hidden),
      images: Array.isArray(review.images) ? review.images : [],
      videos: Array.isArray(review.videos) ? review.videos : [],
      reviewCreatedAt: review.createdAt || review.reviewCreatedAt || null,
      shopeeReply: reply,
      shopeeRepliedAt: review.repliedAt || null,
      lastSyncedAt: new Date(),
    };

    return {
      updateOne: {
        filter: { shopId: normalizedShopId, commentId },
        update: {
          $set: set,
          $setOnInsert: { status: reply ? "replied" : "pending" },
        },
        upsert: true,
      },
    };
  });

  if (operations.length) await ShopeeReview.bulkWrite(operations, { ordered: false });

  const linked = validReviews.filter((r) => productByItemId.has(String(r.itemId || r.item_id || "").trim())).length;
  return {
    received: Array.isArray(reviews) ? reviews.length : 0,
    saved: operations.length,
    linked,
    unlinked: operations.length - linked,
  };
}

module.exports = { persistShopeeReviews };
