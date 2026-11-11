const service = require("../services/shopeeProductManagementService");

function getMessage(error) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.msg ||
    error?.message ||
    "Có lỗi khi xử lý sản phẩm Shopee."
  );
}

function sendError(res, error, status = 400) {
  console.error("[SHOPEE PRODUCT MANAGEMENT]", {
    message: error?.message,
    shopeeError: error?.shopeeError,
    requestId: error?.shopeeRequestId,
  });

  return res.status(status).json({
    success: false,
    message: getMessage(error),
    requestId: error?.shopeeRequestId || null,
  });
}

function getShopId(req) {
  return String(
    req.query.shopId ||
      req.query.shop_id ||
      req.body.shopId ||
      req.body.shop_id ||
      "",
  ).trim();
}

// =====================================================
// 1. DANH SÁCH SẢN PHẨM
// GET /api/shopee/management/products
// =====================================================

exports.getProducts = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));

    const pageSize = Math.min(
      100,
      Math.max(1, Math.floor(Number(req.query.pageSize) || 20)),
    );

    const status = String(req.query.status || "NORMAL").toUpperCase();

    const keyword = String(req.query.keyword || "")
      .trim()
      .toLowerCase();

    const list = await service.getShopeeProductList({
      shopId,
      page,
      pageSize,
      itemStatus: status,
    });

    const itemIds = list.items.map((item) => item.itemId).filter(Boolean);

    const baseItems = await service.getShopeeProductBaseInfo(shopId, itemIds);

    const statusMap = new Map(
      list.items.map((item) => [String(item.itemId), item.itemStatus]),
    );

    const products = baseItems.map((item) => {
      const normalized = {
        ...item,
        item_status:
          item.item_status || statusMap.get(String(item.item_id)) || status,
      };

      return normalized;
    });

    const data = products.map((item) => {
      const priceInfo = Array.isArray(item.price_info)
        ? item.price_info[0] || {}
        : item.price_info || {};

      const stockInfo = item.stock_info_v2 || {};
      const summary = stockInfo.summary_info || {};

      return {
        itemId: String(item.item_id || ""),
        itemName: item.item_name || "",
        itemSku: item.item_sku || "",
        itemStatus: item.item_status || status,

        categoryId: String(item.category_id || ""),
        hasModel: Boolean(item.has_model),

        image: item.image?.image_url_list?.[0] || "",
        images: item.image?.image_url_list || [],

        originalPrice: Number(
          priceInfo.original_price ?? priceInfo.current_price ?? 0,
        ),

        currentPrice: Number(priceInfo.current_price || 0),

        stock: Number(summary.total_available_stock || 0),
        reservedStock: Number(summary.total_reserved_stock || 0),

        models: [],
      };
    });

    const filtered = keyword
      ? data.filter((item) => {
          return (
            item.itemName.toLowerCase().includes(keyword) ||
            item.itemSku.toLowerCase().includes(keyword) ||
            item.itemId.includes(keyword)
          );
        })
      : data;

    return res.json({
      success: true,
      source: "shopee_live",
      data: filtered,

      pagination: {
        page,
        pageSize,
        total: list.total,
        totalPages: Math.ceil(list.total / pageSize),
        hasMore: list.hasMore,
        nextOffset: list.nextOffset,
      },

      requestId: list.requestId,
    });
  } catch (error) {
    return sendError(res, error, 500);
  }
};

// =====================================================
// 2. CHI TIẾT SẢN PHẨM
// GET /api/shopee/management/products/:itemId
// =====================================================

exports.getProductDetail = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const data = await service.getShopeeProductDetail(
      shopId,
      req.params.itemId,
    );

    return res.json({
      success: true,
      source: "shopee_live",
      data,
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
};

// =====================================================
// 3. CẬP NHẬT THÔNG TIN CƠ BẢN
// PUT /api/shopee/management/products/:itemId
// =====================================================

exports.updateProductInfo = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const { itemName, description, weight, dimension } = req.body;

    const result = await service.updateShopeeProductInfo(
      shopId,
      req.params.itemId,
      {
        itemName,
        description,
        weight,
        dimension,
      },
    );

    return res.json({
      success: true,
      message: "Đã gửi cập nhật thông tin lên Shopee.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
};

// =====================================================
// 4. CẬP NHẬT GIÁ
// PUT /api/shopee/management/products/:itemId/prices
// =====================================================

exports.updateProductPrices = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const result = await service.updateShopeeProductPrices(
      shopId,
      req.params.itemId,
      req.body.priceList,
    );

    return res.status(result.success ? 200 : 207).json({
      success: result.success,
      message: result.success
        ? "Cập nhật giá Shopee thành công."
        : "Một số phân loại chưa cập nhật được giá.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
};

// =====================================================
// 5. CẬP NHẬT TỒN KHO
// PUT /api/shopee/management/products/:itemId/stock
// =====================================================

exports.updateProductStock = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const result = await service.updateShopeeProductStock(
      shopId,
      req.params.itemId,
      req.body.stockList,
    );

    return res.status(result.success ? 200 : 207).json({
      success: result.success,
      message: result.success
        ? "Cập nhật tồn kho Shopee thành công."
        : "Một số phân loại chưa cập nhật được tồn kho.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error, 400);
  }
};
