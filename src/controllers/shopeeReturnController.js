const ShopeeShop = require("../models/ShopeeShop");

const {
  syncShopeeReturns,
  getShopeeReturns,
  getShopeeReturnBySn,
  getShopeeReturnDetail,
  saveShopeeReturn,
  receiveShopeeReturn,
  inspectShopeeReturn,
  resolveShopeeReturnStock,
} = require("../services/shopeeReturnService");

// =====================================================
// HELPERS
// =====================================================

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function getShopId(req) {
  return String(req.body?.shopId || req.query?.shopId || "").trim();
}

function handleError(res, error, fallback) {
  console.error("[Shopee Return Controller]", error);

  return res.status(500).json({
    success: false,
    message: error.message || fallback,
  });
}

async function validateShop(shopId) {
  if (!shopId) {
    throw new Error("Vui lòng chọn shop Shopee.");
  }

  const shop = await ShopeeShop.findOne({
    shopId,
    status: "connected",
  }).lean();

  if (!shop) {
    throw new Error("Không tìm thấy shop Shopee đang kết nối.");
  }

  return shop;
}

// =====================================================
// 1. SYNC RETURNS
// =====================================================
//
// POST /api/shopee/returns/sync
//
// Body:
// {
//   "shopId": "123456789",
//   "updateTimeFrom": 1794000000,
//   "updateTimeTo": 1795000000
// }
//
// Nếu không truyền ngày: lấy 14 ngày gần nhất.
//
// =====================================================

const syncReturnsAsync = async (req, res) => {
  try {
    const shopId = getShopId(req);

    await validateShop(shopId);

    const result = await syncShopeeReturns({
      shopId,

      updateTimeFrom: req.body?.updateTimeFrom,
      updateTimeTo: req.body?.updateTimeTo,

      pageSize: req.body?.pageSize || 100,
      maxPages: req.body?.maxPages || 100,

      fetchDetails: req.body?.fetchDetails !== false,
    });

    return res.status(200).json({
      success: true,
      message: "Đồng bộ hàng hoàn Shopee hoàn tất.",
      result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể đồng bộ hàng hoàn Shopee.");
  }
};

// =====================================================
// 2. GET RETURNS
// =====================================================
//
// GET /api/shopee/returns
//
// Query:
// shopId
// page
// limit
// warehouseStatus
// shopeeStatus
// mappingStatus
// keyword
//
// =====================================================

const getReturnsAsync = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      warehouseStatus,
      shopeeStatus,
      mappingStatus,
      keyword,
    } = req.query;

    const shopId = getShopId(req);

    if (shopId) {
      await validateShop(shopId);
    }

    const result = await getShopeeReturns({
      shopId: shopId || undefined,
      page,
      limit,

      warehouseStatus: warehouseStatus === "all" ? undefined : warehouseStatus,

      shopeeStatus: shopeeStatus === "all" ? undefined : shopeeStatus,

      mappingStatus: mappingStatus === "all" ? undefined : mappingStatus,

      keyword,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể lấy danh sách hàng hoàn.");
  }
};

// =====================================================
// 3. GET RETURN DETAIL
// =====================================================
//
// GET /api/shopee/returns/:returnSn
//
// Query:
// shopId
// refresh=true: lấy lại dữ liệu mới nhất từ Shopee
//
// =====================================================

const getReturnDetailAsync = async (req, res) => {
  try {
    const shopId = getShopId(req);
    const returnSn = String(req.params.returnSn || "").trim();

    if (!returnSn) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã yêu cầu trả hàng.",
      });
    }

    await validateShop(shopId);

    let result;

    if (String(req.query.refresh) === "true") {
      const detail = await getShopeeReturnDetail(shopId, returnSn);

      result = await saveShopeeReturn(shopId, detail);
      result = result.toObject();
    } else {
      result = await getShopeeReturnBySn(shopId, returnSn);
    }

    return res.status(200).json({
      success: true,
      return: result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể lấy chi tiết hàng hoàn.");
  }
};

// =====================================================
// 4. RECEIVE RETURN
// =====================================================
//
// POST /api/shopee/returns/:returnSn/receive
//
// Body:
// {
//   "shopId": "123456789",
//   "note": "Đã nhận hàng từ đơn vị vận chuyển"
// }
//
// Chỉ xác nhận hàng đã về kho.
// KHÔNG cộng tồn kho.
//
// =====================================================

const receiveReturnAsync = async (req, res) => {
  try {
    const shopId = getShopId(req);
    const returnSn = String(req.params.returnSn || "").trim();

    await validateShop(shopId);

    const result = await receiveShopeeReturn({
      shopId,
      returnSn,
      userId: getUserId(req),
      note: req.body?.note || "",
    });

    return res.status(200).json({
      success: true,
      message: "Đã xác nhận nhận hàng hoàn. Chưa thay đổi tồn kho.",
      return: result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể xác nhận nhận hàng hoàn.");
  }
};

// =====================================================
// 5. INSPECT RETURN
// =====================================================
//
// POST /api/shopee/returns/:returnSn/inspect
//
// Body:
// {
//   "shopId": "123456789",
//   "note": "Kiểm tra hàng hoàn",
//   "items": [
//     {
//       "itemId": "123",
//       "modelId": "456",
//       "receivedQty": 2,
//       "goodQty": 1,
//       "damagedQty": 1
//     }
//   ]
// }
//
// Số lượng là đơn vị sản phẩm trong kho nội bộ.
// Chưa cộng tồn kho.
//
// =====================================================

const inspectReturnAsync = async (req, res) => {
  try {
    const shopId = getShopId(req);
    const returnSn = String(req.params.returnSn || "").trim();

    await validateShop(shopId);

    const result = await inspectShopeeReturn({
      shopId,
      returnSn,
      userId: getUserId(req),

      items: req.body?.items,

      note: req.body?.note || "",
    });

    return res.status(200).json({
      success: true,
      message: "Đã lưu kết quả kiểm tra hàng hoàn.",
      return: result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể lưu kết quả kiểm tra hàng hoàn.");
  }
};

// =====================================================
// 6. RESOLVE RETURN STOCK
// =====================================================
//
// POST /api/shopee/returns/:returnSn/resolve
//
// Body - LƯU KHO:
// {
//   "shopId": "123456789",
//   "resolution": "RESTOCK",
//   "note": "Hàng tốt đã kiểm tra"
// }
//
// Body - KHÔNG LƯU KHO:
// {
//   "shopId": "123456789",
//   "resolution": "NO_RESTOCK",
//   "note": "Hàng lỗi / không nhập lại"
// }
//
// RESTOCK:
// - Chỉ cộng goodQty.
// - Không cộng damagedQty.
//
// NO_RESTOCK:
// - Không thay đổi tồn kho.
//
// =====================================================

const resolveReturnStockAsync = async (req, res) => {
  try {
    const shopId = getShopId(req);
    const returnSn = String(req.params.returnSn || "").trim();

    const resolution = String(req.body?.resolution || "")
      .trim()
      .toUpperCase();

    if (!["RESTOCK", "NO_RESTOCK"].includes(resolution)) {
      return res.status(400).json({
        success: false,
        message: "resolution phải là RESTOCK hoặc NO_RESTOCK.",
      });
    }

    await validateShop(shopId);

    const result = await resolveShopeeReturnStock({
      shopId,
      returnSn,
      resolution,

      userId: getUserId(req),

      note: req.body?.note || "",
    });

    return res.status(200).json({
      success: true,

      message:
        resolution === "RESTOCK"
          ? "Đã nhập lại hàng tốt vào kho."
          : "Đã xử lý hàng hoàn theo phương án không nhập kho.",

      result,
    });
  } catch (error) {
    return handleError(res, error, "Không thể xử lý tồn kho hàng hoàn.");
  }
};

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
