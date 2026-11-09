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

exports.runNow = async (req, res) => {
  try {
    const setting = await getShopeeAutoReviewStatus();

    if (!setting.enabled) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng bật tự động trả lời trước.",
      });
    }

    const result = await runShopeeAutoReview();

    return res.json({
      success: true,
      message: result?.skipped
        ? "Một lượt xử lý khác đang chạy."
        : "Đã gửi yêu cầu chạy tự động trả lời.",
      data: result || null,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

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
