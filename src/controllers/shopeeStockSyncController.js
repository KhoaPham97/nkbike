const {
  getStockSyncSettings,
  updateStockSyncSettings,
  runShopeeStockSync,
  getShopeeStockSyncStatus,
  getShopeeStockSyncHistory,
} = require("../services/shopeeStockSyncService");

function handleError(res, error) {
  console.error("[Shopee Stock Sync Controller]", error);

  return res.status(500).json({
    success: false,
    message: error.message || "Có lỗi khi xử lý đồng bộ tồn kho Shopee.",
  });
}

// GET /api/shopee/stock-sync/status
async function getStatusAsync(req, res) {
  try {
    const result = await getShopeeStockSyncStatus();

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// GET /api/shopee/stock-sync/settings
async function getSettingsAsync(req, res) {
  try {
    const settings = await getStockSyncSettings();

    return res.json({
      success: true,
      data: settings,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// PUT /api/shopee/stock-sync/settings
async function updateSettingsAsync(req, res) {
  try {
    const settings = await updateStockSyncSettings(
      req.body || {},
      req.user?._id || req.user?.id || null,
    );

    return res.json({
      success: true,
      message: "Đã cập nhật cấu hình đồng bộ tồn kho Shopee.",
      data: settings,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// POST /api/shopee/stock-sync/run
async function runNowAsync(req, res) {
  try {
    const result = await runShopeeStockSync({
      trigger: "manual",
    });

    return res.json({
      success: true,
      message: result.message || "Đã hoàn tất đồng bộ tồn kho Shopee.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// GET /api/shopee/stock-sync/history?page=1&limit=20
async function getHistoryAsync(req, res) {
  try {
    const result = await getShopeeStockSyncHistory({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = {
  getStatusAsync,
  getSettingsAsync,
  updateSettingsAsync,
  runNowAsync,
  getHistoryAsync,
};
