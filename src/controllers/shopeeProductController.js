const {
  syncShopeeProducts,
  getShopeeProducts,
} = require("../services/shopeeProductService");

function getMessage(error) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    "Đã xảy ra lỗi khi xử lý sản phẩm Shopee"
  );
}

// POST /api/shopee/products/sync
exports.syncProducts = async (req, res) => {
  try {
    const {
      shopId,
      offset = 0,
      pageSize = 100,
      maxPages = 10,
      itemStatus = "NORMAL",
    } = req.body;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee",
      });
    }

    const allowedStatuses = [
      "NORMAL",
      "UNLIST",
      "BANNED",
      "REVIEWING",
      "SELLER_DELETE",
      "SHOPEE_DELETE",
    ];

    if (!allowedStatuses.includes(itemStatus)) {
      return res.status(400).json({
        success: false,
        message: "Trạng thái sản phẩm Shopee không hợp lệ",
      });
    }

    const result = await syncShopeeProducts({
      shopId: String(shopId),
      offset,
      pageSize,
      maxPages,
      itemStatus,
    });

    return res.json({
      success: true,
      message: "Đồng bộ sản phẩm Shopee hoàn tất",
      data: result,
    });
  } catch (error) {
    console.error("syncShopeeProducts:", error);

    return res.status(400).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// GET /api/shopee/products
exports.getProducts = async (req, res) => {
  try {
    const {
      shopId,
      page = 1,
      limit = 20,
      keyword = "",
      status = "",
    } = req.query;

    const result = await getShopeeProducts({
      shopId,
      page,
      limit,
      keyword,
      status,
    });

    return res.json({
      success: true,
      data: result.products,
      products: result.products,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("getShopeeProducts:", error);

    return res.status(500).json({
      success: false,
      message: getMessage(error),
    });
  }
};
