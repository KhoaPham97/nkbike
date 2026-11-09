const ShopeeReviewReplyLog = require("../models/ShopeeReviewReplyLog");

// ==============================
// HELPERS
// ==============================

function getShopId(req) {
  return String(
    req.query?.shopId || req.body?.shopId || req.params?.shopId || "",
  ).trim();
}

function getErrorMessage(error) {
  return error?.message || "Đã xảy ra lỗi máy chủ.";
}

// ==============================
// GET STATISTICS
// ==============================

exports.getStatistics = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const [statistics] = await ShopeeReviewReplyLog.aggregate([
      {
        $match: {
          shopId,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    const counts = {
      processing: 0,
      sent: 0,
      failed: 0,
    };

    const results = await ShopeeReviewReplyLog.aggregate([
      {
        $match: {
          shopId,
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    results.forEach((item) => {
      counts[item._id] = item.count;
    });

    const total = counts.processing + counts.sent + counts.failed;

    return res.json({
      success: true,
      data: {
        total,
        sent: counts.sent,
        processing: counts.processing,
        failed: counts.failed,
      },
    });
  } catch (error) {
    console.error("[Shopee Review Log] Statistics:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// ==============================
// GET HISTORY
// ==============================

exports.getHistory = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn gian hàng Shopee.",
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const status = String(req.query.status || "").trim();

    const filter = { shopId };

    if (["processing", "sent", "failed"].includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      ShopeeReviewReplyLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeReviewReplyLog.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Shopee Review Log] History:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// ==============================
// GET ONE DETAIL
// ==============================

exports.getDetail = async (req, res) => {
  try {
    const shopId = getShopId(req);
    const commentId = String(req.params.commentId || "").trim();

    if (!shopId || !commentId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId hoặc commentId.",
      });
    }

    const item = await ShopeeReviewReplyLog.findOne({
      shopId,
      commentId,
    }).lean();

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lịch sử trả lời.",
      });
    }

    return res.json({
      success: true,
      data: item,
    });
  } catch (error) {
    console.error("[Shopee Review Log] Detail:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};
