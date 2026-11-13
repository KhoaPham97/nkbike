const ShopeeReview = require("../models/ShopeeReview");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const { Product } = require("../models/products");

const toText = (value) =>
  value === undefined || value === null ? "" : String(value).trim();

function buildSkuMappingIndex(mappings = []) {
  const byItem = new Map();

  for (const mapping of mappings) {
    const itemId = toText(mapping.itemId);
    if (!itemId) continue;

    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(mapping);
  }

  return byItem;
}

function resolveReviewMapping(review, mappingsByItem) {
  const itemId = toText(review.itemId || review.item_id);
  const modelIdFromList =
    Array.isArray(review.modelIdList) && review.modelIdList.length === 1
      ? toText(review.modelIdList[0])
      : "";
  const modelId = toText(review.modelId || review.model_id || modelIdFromList);
  const candidates = mappingsByItem.get(itemId) || [];

  if (!candidates.length) {
    return { mapping: null, status: "unmapped", itemId, modelId };
  }

  if (modelId) {
    const exact = candidates.filter(
      (mapping) => toText(mapping.modelId || "0") === modelId,
    );

    if (exact.length === 1) {
      return { mapping: exact[0], status: "mapped", itemId, modelId };
    }

    if (exact.length > 1) {
      return { mapping: null, status: "ambiguous", itemId, modelId };
    }
  }

  // Review API đôi khi không trả model_id. Chỉ gắn khi item đó có đúng
  // một mapping đang hoạt động; tuyệt đối không đoán giữa nhiều phân loại.
  if (candidates.length === 1) {
    return {
      mapping: candidates[0],
      status: "mapped",
      itemId,
      modelId: modelId || toText(candidates[0].modelId || "0"),
    };
  }

  return { mapping: null, status: "ambiguous", itemId, modelId };
}

async function persistShopeeReviews({ shopId, reviews = [] }) {
  const normalizedShopId = toText(shopId);
  if (!normalizedShopId) throw new Error("Thiếu shopId để lưu đánh giá.");

  const validReviews = (Array.isArray(reviews) ? reviews : []).filter((review) => {
    const id = toText(review?.commentId || review?.comment_id);
    const rating = Number(review?.rating || review?.rating_star || 0);
    return id && rating >= 1 && rating <= 5;
  });

  const itemIds = [
    ...new Set(
      validReviews
        .map((review) => toText(review.itemId || review.item_id))
        .filter(Boolean),
    ),
  ];

  const mappings = itemIds.length
    ? await ShopeeSkuMapping.find({
        shopId: normalizedShopId,
        itemId: { $in: itemIds },
        isActive: true,
      })
        .select("shopId itemId modelId itemSku variationSku productId variantCode variantName")
        .lean()
    : [];

  const mappingsByItem = buildSkuMappingIndex(mappings);
  const mappedProductIds = [
    ...new Set(
      mappings
        .map((mapping) => toText(mapping.productId))
        .filter(Boolean),
    ),
  ];

  const legacyItemIds = itemIds.filter(
    (itemId) => !(mappingsByItem.get(itemId) || []).length,
  );

  const [mappedProducts, legacyProducts] = await Promise.all([
    mappedProductIds.length
      ? Product.find({ _id: { $in: mappedProductIds } })
          .select("_id title thumbnail")
          .lean()
      : [],
    legacyItemIds.length
      ? Product.find({
          shopeeItemId: { $in: legacyItemIds },
          $or: [
            { shopeeShopId: normalizedShopId },
            { shopeeShopId: "" },
            { shopeeShopId: { $exists: false } },
          ],
        })
          .select("_id title thumbnail shopeeItemId")
          .lean()
      : [],
  ]);

  const productById = new Map(
    [...mappedProducts, ...legacyProducts].map((product) => [
      String(product._id),
      product,
    ]),
  );
  const legacyProductByItemId = new Map(
    legacyProducts.map((product) => [toText(product.shopeeItemId), product]),
  );

  const operations = validReviews.map((review) => {
    const commentId = toText(review.commentId || review.comment_id);
    const itemId = toText(review.itemId || review.item_id);
    const resolved = resolveReviewMapping(review, mappingsByItem);
    const mapping = resolved.mapping;
    const legacyProduct =
      !mapping && resolved.status === "unmapped"
        ? legacyProductByItemId.get(itemId)
        : null;
    const productId = mapping
      ? toText(mapping.productId)
      : legacyProduct
        ? String(legacyProduct._id)
        : "";
    const product = productById.get(productId) || legacyProduct || null;
    const reply = toText(review.shopeeReply || review.reply);

    const set = {
      shopId: normalizedShopId,
      commentId,
      orderSn: toText(review.orderSn),
      itemId,
      modelId: resolved.modelId,
      itemSku: toText(mapping?.itemSku || review.itemSku),
      variationSku: toText(mapping?.variationSku || review.variationSku),
      productId,
      productName: product?.title || "",
      productImage: product?.thumbnail || "",
      variantCode: mapping ? toText(mapping.variantCode) : "",
      variantName: mapping ? toText(mapping.variantName) : "",
      mappingStatus: mapping
        ? "mapped"
        : resolved.status === "ambiguous"
          ? "ambiguous"
          : product
            ? "mapped"
            : "unmapped",
      customerName: toText(review.customerName || review.customerUsername),
      customerUsername: toText(review.customerUsername || review.customerName),
      rating: Number(review.rating || review.rating_star || 0),
      content: toText(review.content),
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

  if (operations.length) {
    await ShopeeReview.bulkWrite(operations, { ordered: false });
  }

  const linked = operations.filter((operation) => {
    const set = operation.updateOne.update.$set;
    return Boolean(set.productId);
  }).length;

  const ambiguous = operations.filter(
    (operation) =>
      operation.updateOne.update.$set.mappingStatus === "ambiguous",
  ).length;

  return {
    received: Array.isArray(reviews) ? reviews.length : 0,
    saved: operations.length,
    linked,
    unlinked: operations.length - linked,
    ambiguous,
    matchedBySku: operations.filter(
      (operation) =>
        operation.updateOne.update.$set.variantCode &&
        operation.updateOne.update.$set.mappingStatus === "mapped",
    ).length,
  };
}

module.exports = { persistShopeeReviews };
