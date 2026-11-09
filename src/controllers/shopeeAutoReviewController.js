const {
  updateShopeeAutoReviewSettings,
  getShopeeAutoReviewStatus,
  runShopeeAutoReview,
} = require("../jobs/shopeeAutoReviewJob");

const ShopeeReviewReplyLog = require("../models/ShopeeReviewReplyLog");

function handleError(res, error) {
  console.error("[Shopee Auto Review Controller]", error);

  return res.status(500).json({
    success: false,
    message: error.message || "Có lỗi xảy ra.",
  });
}

// GET: Trạng thái tự động trả lời
exports.getStatus = async (req, res) => {
  try {
    const setting = await getShopeeAutoReviewStatus();

    return res.json({
      success: true,
      data: setting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// PUT: Cập nhật cấu hình
exports.updateSettings = async (req, res) => {
  try {
    const {
      enabled,
      intervalMinutes,
      maxRepliesPerRun,
      delayBetweenRepliesMs,
      runNow,
    } = req.body || {};

    const setting = await updateShopeeAutoReviewSettings({
      enabled,
      intervalMinutes,
      maxRepliesPerRun,
      delayBetweenRepliesMs,
      runNow: runNow === true,
    });

    return res.json({
      success: true,
      message: "Đã cập nhật cấu hình tự động trả lời.",
      data: setting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// POST: Chạy ngay
exports.runNow = async (req, res) => {
  try {
    const setting = await getShopeeAutoReviewStatus();

    if (!setting.enabled) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng bật tự động trả lời trước.",
      });
    }

    runShopeeAutoReview().catch((error) => {
      console.error("[Shopee Auto Review]", error);
    });

    return res.json({
      success: true,
      message: "Đã gửi yêu cầu chạy tự động trả lời.",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// POST: Bật
exports.enable = async (req, res) => {
  try {
    const setting = await updateShopeeAutoReviewSettings({
      enabled: true,
    });

    return res.json({
      success: true,
      message: "Đã bật tự động trả lời đánh giá Shopee.",
      data: setting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// POST: Tắt
exports.disable = async (req, res) => {
  try {
    const setting = await updateShopeeAutoReviewSettings({
      enabled: false,
    });

    return res.json({
      success: true,
      message: "Đã tắt tự động trả lời đánh giá Shopee.",
      data: setting,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// GET: Lịch sử tự động trả lời
exports.getHistory = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter = {};

    if (req.query.shopId) {
      filter.shopId = String(req.query.shopId);
    }

    if (req.query.status) {
      filter.status = String(req.query.status);
    }

    const [data, total] = await Promise.all([
      ShopeeReviewReplyLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeReviewReplyLog.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};
