const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeAutoStockJobLog = require("../models/ShopeeAutoStockJobLog");

const {
  processOrders,
  getAutoStockSettings,
  updateAutoStockSettings,
} = require("../jobs/shopeeAutoStockJob");

const ALLOWED_INTERVALS = [1, 5, 10, 15, 30, 60];

function getErrorMessage(error) {
  return error?.message || "Đã xảy ra lỗi Backend.";
}

// =====================================================
// GET AUTO STOCK ORDERS
// GET /auto-stock/orders
// =====================================================

exports.getAutoStockOrdersAsync = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const query = {
      orderStatus: "COMPLETED",
    };

    const [orders, total] = await Promise.all([
      ShopeeOrder.find(query)
        .sort({ createTime: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeOrder.countDocuments(query),
    ]);

    return res.json({
      success: true,
      orders: orders.map((order) => ({
        _id: order._id,
        shopId: order.shopId,
        orderSn: order.orderSn,
        orderStatus: order.orderStatus,
        status: order.orderStatus,
        stockStatus: order.stockStatus,
        stockDeducted: order.stockDeducted,

        shopName: order.shopName || "",

        createdAt: order.createTime || order.createdAt,
        updatedAt: order.updateTime || order.updatedAt,

        itemCount: order.items?.length || 0,

        totalQty: (order.items || []).reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0,
        ),

        deductedQty: (order.items || []).reduce(
          (sum, item) => sum + Number(item.deductedQty || 0),
          0,
        ),

        items: order.items || [],
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Auto Stock] Get orders:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// GET AUTO STOCK HISTORY
// GET /auto-stock/history
// =====================================================

exports.getAutoStockHistoryAsync = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const history = await ShopeeAutoStockJobLog.find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();

    const formattedHistory = history.map((job) => {
      const results = Array.isArray(job.results) ? job.results : [];

      return {
        ...job,

        // Giữ nguyên toàn bộ dữ liệu từng đơn
        results: results.map((item) => ({
          ...item,
          shopId: item.shopId || "",
          orderSn: item.orderSn || "",
          status: item.status || "unknown",
          stockStatus: item.stockStatus || "pending",
          message: item.message || "",
          processedAt: item.processedAt || null,
        })),

        // Thống kê số lượng đơn thực tế
        resultCount: results.length,
      };
    });

    return res.json({
      success: true,
      total: formattedHistory.length,
      history: formattedHistory,
    });
  } catch (error) {
    console.error("[Auto Stock] Get history:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};
// =====================================================
// GET SETTINGS
// GET /auto-stock/settings
// =====================================================

exports.getAutoStockSettingsAsync = async (req, res) => {
  try {
    const settings = await getAutoStockSettings();

    return res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error("[Auto Stock] Get settings:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// UPDATE SETTINGS
// PUT /auto-stock/settings
// =====================================================

exports.updateAutoStockSettingsAsync = async (req, res) => {
  try {
    const { enabled, intervalMinutes, batchSize } = req.body || {};

    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "Trường enabled phải là true hoặc false.",
      });
    }

    const normalizedInterval =
      intervalMinutes !== undefined ? Number(intervalMinutes) : undefined;

    if (
      normalizedInterval !== undefined &&
      !ALLOWED_INTERVALS.includes(normalizedInterval)
    ) {
      return res.status(400).json({
        success: false,
        message: "Chu kỳ không hợp lệ. Chọn 1, 5, 10, 15, 30 hoặc 60 phút.",
      });
    }

    const normalizedBatchSize =
      batchSize !== undefined ? Number(batchSize) : undefined;

    if (
      normalizedBatchSize !== undefined &&
      (!Number.isInteger(normalizedBatchSize) ||
        normalizedBatchSize < 1 ||
        normalizedBatchSize > 500)
    ) {
      return res.status(400).json({
        success: false,
        message: "Batch Size phải là số nguyên từ 1 đến 500.",
      });
    }

    if (
      enabled === undefined &&
      normalizedInterval === undefined &&
      normalizedBatchSize === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Không có thông tin cấu hình cần cập nhật.",
      });
    }

    // Cập nhật đúng Settings mà Cron đang sử dụng.
    // Hàm này cũng cấu hình lại lịch Cron sau khi lưu.
    const settings = await updateAutoStockSettings({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(normalizedInterval !== undefined
        ? { intervalMinutes: normalizedInterval }
        : {}),
      ...(normalizedBatchSize !== undefined
        ? { batchSize: normalizedBatchSize }
        : {}),
    });

    return res.json({
      success: true,
      message: "Đã cập nhật cấu hình Auto Stock.",
      settings,
    });
  } catch (error) {
    console.error("[Auto Stock] Update settings:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// RUN NOW
// POST /auto-stock/run
// =====================================================

exports.runAutoStockNowAsync = async (req, res) => {
  try {
    const settings = await getAutoStockSettings();

    const result = await processOrders({
      trigger: "manual",
      batchSize: settings?.batchSize || 100,
    });

    if (result.skipped) {
      return res.status(409).json({
        success: false,
        skipped: true,
        message: result.message,
      });
    }

    return res.json({
      success: result.failedCount === 0,
      message: "Đã hoàn thành lần chạy Auto Stock.",
      ...result,
    });
  } catch (error) {
    console.error("[Auto Stock] Run now:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// PROCESS SELECTED ORDERS
// POST /auto-stock/process-selected
// =====================================================

exports.processSelectedOrdersAsync = async (req, res) => {
  try {
    const orderSns = req.body.orderSns;

    if (!Array.isArray(orderSns) || orderSns.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn ít nhất một đơn hàng.",
      });
    }

    if (orderSns.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Mỗi lần chỉ được xử lý tối đa 500 đơn.",
      });
    }

    const normalizedOrderSns = [
      ...new Set(
        orderSns.map((item) => String(item || "").trim()).filter(Boolean),
      ),
    ];

    if (!normalizedOrderSns.length) {
      return res.status(400).json({
        success: false,
        message: "Danh sách mã đơn không hợp lệ.",
      });
    }

    const result = await processOrders({
      trigger: "selected",
      orderSns: normalizedOrderSns,
      batchSize: normalizedOrderSns.length,
    });

    if (result.skipped) {
      return res.status(409).json({
        success: false,
        skipped: true,
        message: result.message,
      });
    }

    return res.json({
      success: result.failedCount === 0,
      message: "Đã hoàn thành xử lý các đơn được chọn.",
      ...result,
    });
  } catch (error) {
    console.error("[Auto Stock] Process selected:", error);

    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};
