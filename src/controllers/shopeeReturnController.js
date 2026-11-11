const {
  syncShopeeReturns,
  getShopeeReturns,
  getShopeeReturnDetail,
  receiveShopeeReturn,
  inspectShopeeReturn,
  resolveShopeeReturn,
} = require("../services/shopeeReturnService");

// =====================================================
// HELPERS
// =====================================================

function getShopId(req) {
  return String(
    req.query?.shopId || req.body?.shopId || req.params?.shopId || "",
  ).trim();
}

function getUser(req) {
  return req.user || req.admin || req.auth || null;
}

function handleError(res, error) {
  console.error("[Shopee Return Controller]", error);

  const message = error?.message || "Có lỗi xảy ra.";

  const clientErrors = [
    "Thiếu shopId",
    "Không tìm thấy phiếu",
    "Không tìm thấy sản phẩm",
    "Không tìm thấy phân loại",
    "Phiếu này đã được xử lý",
    "Phiếu hàng hoàn đã được xử lý",
    "Phiếu phải được",
    "Chỉ được kiểm tra",
    "Chỉ được xử lý",
    "Trạng thái hiện tại",
    "Số lượng",
    "Danh sách kiểm tra",
    "Phương án xử lý",
    "SKU",
    "Thiếu productId",
  ];

  const statusCode = clientErrors.some((keyword) =>
    message.toLowerCase().includes(keyword.toLowerCase()),
  )
    ? 400
    : 500;

  return res.status(statusCode).json({
    success: false,
    message,
  });
}

function requireShopId(req, res) {
  const shopId = getShopId(req);

  if (!shopId) {
    res.status(400).json({
      success: false,
      message: "Vui lòng chọn shop Shopee.",
    });

    return null;
  }

  return shopId;
}

// =====================================================
// 1. SYNC
// POST /returns/sync
// =====================================================

async function syncReturnsAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const result = await syncShopeeReturns(shopId);

    return res.status(200).json({
      success: true,
      message: "Đồng bộ hàng hoàn Shopee hoàn tất.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// 2. GET LIST
// GET /returns
// =====================================================

async function getReturnsAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const result = await getShopeeReturns({
      shopId,

      page: req.query.page || 1,

      limit: req.query.limit || 20,

      keyword: req.query.keyword || "",

      warehouseStatus: req.query.warehouseStatus || req.query.status || "all",

      returnType: req.query.returnType || "all",
    });

    return res.status(200).json({
      success: true,
      data: result.returns,
      pagination: result.pagination,
      total: result.total,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// 3. GET DETAIL
// GET /returns/:returnSn
// =====================================================

async function getReturnDetailAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const returnSn = String(req.params.returnSn || "").trim();

    if (!returnSn) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã phiếu hàng hoàn.",
      });
    }

    const result = await getShopeeReturnDetail({
      shopId,
      returnSn,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// 4. RECEIVE
// POST /returns/:returnSn/receive
// =====================================================

async function receiveReturnAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const returnSn = String(req.params.returnSn || "").trim();

    const result = await receiveShopeeReturn({
      shopId,
      returnSn,

      note: req.body?.note || "",

      user: getUser(req),
    });

    return res.status(200).json({
      success: true,
      message: "Đã xác nhận nhận kiện hàng hoàn.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// 5. INSPECT
// POST /returns/:returnSn/inspect
// =====================================================

async function inspectReturnAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const returnSn = String(req.params.returnSn || "").trim();

    const items = req.body?.items;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: "Danh sách sản phẩm kiểm tra không hợp lệ.",
      });
    }

    const result = await inspectShopeeReturn({
      shopId,
      returnSn,

      items,

      note: req.body?.note || "",

      user: getUser(req),
    });

    return res.status(200).json({
      success: true,
      message: "Đã lưu kết quả kiểm tra hàng hoàn.",
      data: result,
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// 6. RESOLVE
// POST /returns/:returnSn/resolve
// =====================================================

async function resolveReturnStockAsync(req, res) {
  try {
    const shopId = requireShopId(req, res);

    if (!shopId) return;

    const returnSn = String(req.params.returnSn || "").trim();

    const resolution = String(req.body?.resolution || "")
      .trim()
      .toUpperCase();

    if (!["RESTOCK", "NO_RESTOCK"].includes(resolution)) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn RESTOCK hoặc NO_RESTOCK.",
      });
    }

    const result = await resolveShopeeReturn({
      shopId,
      returnSn,

      resolution,

      note: req.body?.note || "",

      user: getUser(req),
    });

    return res.status(200).json({
      success: true,

      message:
        resolution === "RESTOCK"
          ? "Đã nhập lại hàng tốt vào kho và tạo lô hàng hoàn."
          : "Đã xác nhận không nhập lại kho. Tồn kho không thay đổi.",

      data: {
        returnDoc: result.returnDoc,

        transaction: result.transaction,

        resolution: result.resolution,

        totalRestockedQty: result.totalRestockedQty,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  syncReturnsAsync,
  getReturnsAsync,
  getReturnDetailAsync,
  receiveReturnAsync,
  inspectReturnAsync,
  resolveReturnStockAsync,
};
