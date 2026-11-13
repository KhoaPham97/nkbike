const ShopeeReviewTemplate = require("../models/ShopeeReviewTemplate");
const ShopeeReview = require("../models/ShopeeReview");

const {
  getShopeeReviews,
  getAllShopeeReviews,
  generateDraft,
  sendShopeeReviewReply,
} = require("../services/shopeeReviewService");
const { getShopeeItemIds } = require("../services/shopeeService");
const { persistShopeeReviews } = require("../services/shopeeReviewSyncService");
// =====================================================
// HELPERS
// =====================================================

function getShopId(req) {
  return String(
    req.body?.shopId || req.query?.shopId || req.query?.shop_id || "",
  ).trim();
}

function getErrorMessage(error) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.msg ||
    error?.message ||
    "Đã xảy ra lỗi."
  );
}

// =====================================================
// GET REVIEWS - ONE PAGE
// GET /reviews
// =====================================================

async function getReviews(req, res) {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const pageSize = Number(req.query.limit || 100);
    const cursor = req.query.cursor || "";
    const itemId = req.query.itemId || "";

    const result = await getShopeeReviews({
      shopId,
      pageSize,
      cursor,
      itemId,
    });

    await persistShopeeReviews({ shopId, reviews: result.reviews || [] });

    return res.json({
      success: true,
      data: result.reviews,
      pagination: {
        total: result.total,
        more: result.more,
        nextCursor: result.nextCursor,
      },
    });
  } catch (error) {
    console.error("GET SHOPEE REVIEWS ERROR:", getErrorMessage(error));

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

// =====================================================
// GET ALL REVIEWS
// GET /reviews/all
//
// Query:
// shopId
// limit
// itemIds=123,456,789 (optional)
// =====================================================

async function getAllReviews(req, res) {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const pageSize = Math.min(Math.max(Number(req.query.limit) || 100, 1), 100);

    // Nếu không truyền itemIds, tự lấy danh sách sản phẩm Shopee.
    let itemIds = String(req.query.itemIds || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    let productCount = 0;

    if (itemIds.length === 0) {
      const products = await getShopeeItemIds({
        shopId,
        itemStatuses: ["NORMAL"],
        pageSize: 100,
      });

      itemIds = products.map((item) => item.itemId);
      productCount = itemIds.length;
    } else {
      productCount = itemIds.length;
    }

    if (itemIds.length === 0) {
      return res.json({
        success: true,
        message: "Gian hàng chưa có sản phẩm để quét đánh giá.",
        data: [],
        pagination: {
          total: 0,
          productCount: 0,
        },
      });
    }

    const result = await getAllShopeeReviews({
      shopId,
      pageSize,
      itemIds,
    });

    const reviews = result.reviews || [];
    const sync = await persistShopeeReviews({ shopId, reviews });

    return res.json({
      success: true,
      message: "Đã đồng bộ và lưu đánh giá từ các sản phẩm Shopee.",
      sync,
      data: reviews,
      pagination: {
        total: reviews.length,
        productCount,
        mode: "product_scan",
      },
    });
  } catch (error) {
    console.error("GET ALL SHOPEE REVIEWS ERROR:", getErrorMessage(error));

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

// =====================================================
// GET REVIEW REPLY SUGGESTION
// POST /reviews/suggest
// =====================================================

async function suggestReply(req, res) {
  try {
    const shopId = getShopId(req);
    const { rating, review, shopName } = req.body || {};

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId.",
      });
    }

    const result = await generateDraft({
      shopId,
      rating,
      review: review || {},
      shopName: shopName || "",
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

// =====================================================
// SEND REPLY DIRECTLY TO SHOPEE
// POST /reviews/reply
// =====================================================

async function replyReview(req, res) {
  try {
    const shopId = getShopId(req);
    const { commentId, comment } = req.body || {};

    if (!shopId || !commentId || !comment) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId, commentId hoặc nội dung trả lời.",
      });
    }

    const result = await sendShopeeReviewReply({
      shopId,
      commentId,
      comment,
    });

    return res.json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    console.error("SHOPEE REVIEW REPLY ERROR:", getErrorMessage(error));

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

// =====================================================
// TEMPLATE MANAGEMENT
// =====================================================

async function getTemplates(req, res) {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId.",
      });
    }

    const templates = await ShopeeReviewTemplate.find({
      shopId,
    })
      .sort({ rating: -1, isDefault: -1, createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

async function createTemplate(req, res) {
  try {
    const shopId = getShopId(req);
    const { rating, name, content, isDefault, isActive } = req.body || {};

    if (!shopId || !rating || !name || !content) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ thông tin mẫu trả lời.",
      });
    }

    const star = Number(rating);

    if (!Number.isInteger(star) || star < 1 || star > 5) {
      return res.status(400).json({
        success: false,
        message: "Số sao phải từ 1 đến 5.",
      });
    }

    if (isDefault) {
      await ShopeeReviewTemplate.updateMany(
        { shopId, rating: star },
        { $set: { isDefault: false } },
      );
    }

    const template = await ShopeeReviewTemplate.create({
      shopId,
      rating: star,
      name: String(name).trim(),
      content: String(content).trim(),
      isDefault: Boolean(isDefault),
      isActive: isActive !== false,
    });

    return res.status(201).json({
      success: true,
      data: template,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

async function updateTemplate(req, res) {
  try {
    const shopId = getShopId(req);
    const { id } = req.params;

    const template = await ShopeeReviewTemplate.findOne({
      _id: id,
      shopId,
    });

    if (!template) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy mẫu trả lời.",
      });
    }

    const { rating, name, content, isDefault, isActive } = req.body || {};

    const nextRating = rating !== undefined ? Number(rating) : template.rating;

    if (!Number.isInteger(nextRating) || nextRating < 1 || nextRating > 5) {
      return res.status(400).json({
        success: false,
        message: "Số sao phải từ 1 đến 5.",
      });
    }

    if (isDefault === true) {
      await ShopeeReviewTemplate.updateMany(
        {
          shopId,
          rating: nextRating,
          _id: { $ne: template._id },
        },
        { $set: { isDefault: false } },
      );
    }

    template.rating = nextRating;

    if (name !== undefined) template.name = String(name).trim();
    if (content !== undefined) template.content = String(content).trim();
    if (isDefault !== undefined) template.isDefault = Boolean(isDefault);
    if (isActive !== undefined) template.isActive = Boolean(isActive);

    await template.save();

    return res.json({
      success: true,
      data: template,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

async function deleteTemplate(req, res) {
  try {
    const shopId = getShopId(req);

    const deleted = await ShopeeReviewTemplate.findOneAndDelete({
      _id: req.params.id,
      shopId,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy mẫu trả lời.",
      });
    }

    return res.json({
      success: true,
      message: "Đã xóa mẫu trả lời.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getReviews,
  getAllReviews,
  suggestReply,
  replyReview,
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
