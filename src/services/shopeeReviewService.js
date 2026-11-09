const ShopeeReviewTemplate = require("../models/ShopeeReviewTemplate");
const { callShopeeShopApi } = require("./shopeeService");

// =====================================================
// CONFIG
// =====================================================

const MAX_PAGE_SIZE = 100;
const MAX_PAGES_PER_ITEM = 1000;
const REQUEST_DELAY_MS = 300;

// =====================================================
// HELPERS
// =====================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReview(review) {
  const reply = review?.comment_reply || {};
  const media = review?.media || {};

  return {
    commentId: String(review?.comment_id || ""),
    itemId: String(review?.item_id || ""),
    modelId: String(review?.model_id || ""),
    modelIdList: review?.model_id_list || [],
    orderSn: review?.order_sn || "",
    customerName: review?.buyer_username || "",
    rating: Number(review?.rating_star || 0),
    content: review?.comment || "",
    images: media.image_url_list || [],
    videos: media.video_url_list || [],
    createdAt: review?.create_time
      ? new Date(Number(review.create_time) * 1000)
      : null,
    editable: review?.editable || "",
    hidden: Boolean(review?.hidden),
    shopeeReply: reply.reply || "",
    repliedAt: reply.create_time
      ? new Date(Number(reply.create_time) * 1000)
      : null,
    hasReply: Boolean(reply.reply),
  };
}

function getResponseData(result) {
  if (result?.error) {
    throw new Error(result.message || result.error);
  }

  const data = result?.response || result;

  if (data?.error) {
    throw new Error(data.message || data.error);
  }

  return data || {};
}

// =====================================================
// GET ONE PAGE
// GET /api/v2/product/get_comment
// =====================================================

async function getShopeeReviews({
  shopId,
  pageSize = 100,
  cursor = "",
  itemId,
  commentId,
}) {
  if (!shopId) {
    throw new Error("Vui lòng chọn gian hàng Shopee.");
  }

  const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 100);

  const params = {
    page_size: limit,
  };

  if (cursor) {
    params.cursor = String(cursor);
  }

  if (itemId !== undefined && itemId !== null && String(itemId).trim() !== "") {
    const normalizedItemId = String(itemId).trim();

    if (!/^\d+$/.test(normalizedItemId)) {
      throw new Error(`itemId không hợp lệ: ${normalizedItemId}`);
    }

    params.item_id = normalizedItemId;
  }

  if (
    commentId !== undefined &&
    commentId !== null &&
    String(commentId).trim() !== ""
  ) {
    const normalizedCommentId = String(commentId).trim();

    if (!/^\d+$/.test(normalizedCommentId)) {
      throw new Error(`commentId không hợp lệ: ${normalizedCommentId}`);
    }

    params.comment_id = normalizedCommentId;
  }

  console.log("[SHOPEE GET COMMENTS]", {
    shopId: String(shopId),
    pageSize: limit,
    itemId: params.item_id || null,
    cursor: params.cursor || null,
  });

  const result = await callShopeeShopApi({
    shopId,
    path: "/api/v2/product/get_comment",
    method: "GET",
    params,
  });

  const data = getResponseData(result);

  const reviews = (data.item_comment_list || []).map(normalizeReview);

  return {
    shopId: String(shopId),
    reviews,
    total: reviews.length,
    more: Boolean(data.more),
    nextCursor: data.next_cursor || "",
  };
}

// =====================================================
// GET ALL REVIEWS
//
// - Có itemIds: quét từng sản phẩm.
// - Không có itemIds: quét phạm vi toàn shop API trả về.
// - Phân trang cho đến khi hết dữ liệu.
// - Chống trùng commentId.
// =====================================================

async function getAllShopeeReviews({
  shopId,
  pageSize = 100,
  itemIds = [],
  onProgress,
  requestDelay = REQUEST_DELAY_MS,
  maxPagesPerItem = MAX_PAGES_PER_ITEM,
}) {
  if (!shopId) {
    throw new Error("Vui lòng chọn gian hàng Shopee.");
  }

  const limit = Math.min(
    Math.max(Number(pageSize) || MAX_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );

  const uniqueItemIds = [
    ...new Set(
      (Array.isArray(itemIds) ? itemIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ];

  const targets = uniqueItemIds.length ? uniqueItemIds : [null];

  const reviewMap = new Map();

  let completedTargets = 0;
  let totalPages = 0;
  let failedTargets = 0;

  const errors = [];

  for (const itemId of targets) {
    let cursor = "";
    let pageCount = 0;

    const visitedCursors = new Set();

    try {
      while (true) {
        if (pageCount >= maxPagesPerItem) {
          throw new Error(
            `Sản phẩm ${itemId || "toàn shop"} vượt quá giới hạn ${maxPagesPerItem} trang.`,
          );
        }

        const result = await getShopeeReviews({
          shopId,
          pageSize: limit,
          cursor,
          itemId,
        });

        pageCount += 1;
        totalPages += 1;

        for (const review of result.reviews) {
          if (!review.commentId) continue;

          reviewMap.set(review.commentId, review);
        }

        if (typeof onProgress === "function") {
          onProgress({
            itemId,
            completedTargets,
            totalTargets: targets.length,
            pageCount,
            totalPages,
            loaded: reviewMap.size,
          });
        }

        if (!result.more) {
          break;
        }

        if (!result.nextCursor) {
          errors.push({
            itemId,
            message: "Shopee báo còn dữ liệu nhưng không trả next_cursor.",
          });
          break;
        }

        if (visitedCursors.has(result.nextCursor)) {
          errors.push({
            itemId,
            message: "Shopee trả cursor lặp, đã dừng phân trang.",
          });
          break;
        }

        visitedCursors.add(result.nextCursor);
        cursor = result.nextCursor;

        if (requestDelay > 0) {
          await sleep(requestDelay);
        }
      }
    } catch (error) {
      failedTargets += 1;

      errors.push({
        itemId,
        message: error.message || "Không thể tải đánh giá sản phẩm.",
      });
    }

    completedTargets += 1;

    if (typeof onProgress === "function") {
      onProgress({
        itemId,
        completedTargets,
        totalTargets: targets.length,
        pageCount,
        totalPages,
        loaded: reviewMap.size,
        done: true,
        failedTargets,
      });
    }

    // Nghỉ giữa các sản phẩm.
    if (completedTargets < targets.length && requestDelay > 0) {
      await sleep(requestDelay);
    }
  }

  const reviews = Array.from(reviewMap.values());

  reviews.sort((a, b) => {
    return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
  });

  return {
    shopId: String(shopId),
    reviews,
    total: reviews.length,
    totalPages,
    totalItems: uniqueItemIds.length,
    completedTargets,
    failedTargets,
    errors,
    mode: uniqueItemIds.length ? "by_products" : "shop",
  };
}

// =====================================================
// REPLACE PLACEHOLDERS
// =====================================================

function replacePlaceholders(content, review, shopName = "") {
  return String(content || "")
    .replace(/\{shopName\}/gi, shopName || "Shop")
    .replace(/\{productName\}/gi, review?.productName || "sản phẩm")
    .replace(/\{customerName\}/gi, review?.customerName || "bạn");
}

// =====================================================
// GENERATE REPLY DRAFT
// =====================================================

async function generateDraft({ shopId, rating, review, shopName = "" }) {
  const star = Number(rating);

  if (!shopId || !Number.isInteger(star) || star < 1 || star > 5) {
    throw new Error("shopId hoặc số sao không hợp lệ.");
  }

  const templates = await ShopeeReviewTemplate.find({
    shopId: String(shopId),
    rating: star,
    isActive: true,
  })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  if (!templates.length) {
    return {
      content: "",
      templateId: null,
      message: `Chưa có mẫu trả lời đang bật cho đánh giá ${star} sao.`,
    };
  }

  const selected =
    templates.find((template) => template.isDefault) || templates[0];

  return {
    content: replacePlaceholders(selected.content, review || {}, shopName),
    templateId: String(selected._id),
    templateName: selected.name,
  };
}

// =====================================================
// SEND REPLY TO SHOPEE
//
// POST /api/v2/product/reply_comment
// =====================================================

async function sendShopeeReviewReply({ shopId, commentId, comment }) {
  if (!shopId) {
    throw new Error("Thiếu shopId.");
  }

  if (!commentId) {
    throw new Error("Thiếu commentId.");
  }

  const content = String(comment || "").trim();

  if (!content) {
    throw new Error("Nội dung trả lời không được để trống.");
  }

  if (content.length > 500) {
    throw new Error("Nội dung trả lời không được vượt quá 500 ký tự.");
  }

  const result = await callShopeeShopApi({
    shopId,
    path: "/api/v2/product/reply_comment",
    method: "POST",
    body: {
      comment_list: [
        {
          comment_id: Number(commentId),
          comment: content,
        },
      ],
    },
  });

  const data = getResponseData(result);

  const resultList = data.result_list || [];

  const itemResult =
    resultList.find((item) => String(item.comment_id) === String(commentId)) ||
    resultList[0];

  if (itemResult?.fail_error || itemResult?.fail_message) {
    throw new Error(
      itemResult.fail_message ||
        itemResult.fail_error ||
        "Shopee không chấp nhận phản hồi.",
    );
  }

  return {
    success: true,
    commentId: String(commentId),
    message: "Đã gửi phản hồi lên Shopee.",
    data,
  };
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  normalizeReview,
  getShopeeReviews,
  getAllShopeeReviews,
  generateDraft,
  replacePlaceholders,
  sendShopeeReviewReply,
};
