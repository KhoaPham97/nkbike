const mongoose = require("mongoose");

const { Product } = require("../models/products");
const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");

// =====================================================
// HELPERS
// =====================================================

function getErrorMessage(error) {
  if (error.code === 11000) {
    return "Ánh xạ SKU này đã tồn tại";
  }

  return error.message || "Có lỗi xảy ra";
}

function getShopId(req) {
  return String(req.body.shopId || req.query.shopId || "").trim();
}

function getItemKey(itemId, modelId) {
  return `${String(itemId)}_${String(modelId || "0")}`;
}

// =====================================================
// 1. DANH SÁCH ÁNH XẠ SKU
// GET /api/shopee/management/sku-mappings
// =====================================================
exports.getShopsAsync = async (req, res) => {
  try {
    const shops = await ShopeeShop.find({}).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      data: shops,
      total: shops.length,
    });
  } catch (error) {
    console.error("[Shopee Shop] getShopsAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể lấy danh sách shop Shopee.",
    });
  }
};
exports.getSkuMappings = async (req, res) => {
  try {
    const { shopId, keyword, status } = req.query;

    const filter = {};

    if (shopId) {
      filter.shopId = String(shopId);
    }

    if (status === "active") {
      filter.isActive = true;
    } else if (status === "disabled") {
      filter.isActive = false;
    }

    if (keyword) {
      const regex = new RegExp(
        String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );

      filter.$or = [
        { itemName: regex },
        { modelName: regex },
        { itemSku: regex },
        { variationSku: regex },
        { variantCode: regex },
        { variantName: regex },
      ];
    }

    const mappings = await ShopeeSkuMapping.find(filter)
      .populate("productId", "title thumbnail variants")
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: mappings,
      total: mappings.length,
    });
  } catch (error) {
    console.error("getSkuMappings:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// =====================================================
// 2. TẠO / CẬP NHẬT ÁNH XẠ SKU
// POST /api/shopee/management/sku-mappings
// =====================================================

exports.saveSkuMapping = async (req, res) => {
  try {
    const {
      shopId,
      itemId,
      modelId,
      itemSku,
      variationSku,
      itemName,
      modelName,
      productId,
      variantCode,
      variantName,
      quantityMultiplier,
      allowStockDeduction,
      note,
    } = req.body;

    if (!shopId || !itemId || !productId || !variantCode) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId, itemId, productId hoặc variantCode",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const multiplier = Number(quantityMultiplier || 1);

    if (!Number.isInteger(multiplier) || multiplier < 1) {
      return res.status(400).json({
        success: false,
        message: "quantityMultiplier phải là số nguyên lớn hơn 0",
      });
    }

    const product = await Product.findById(productId).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm nội bộ",
      });
    }

    const variant = (product.variants || []).find((item) => {
      const code = String(item.variantCode || item.code || item.sku || "");

      return code === String(variantCode);
    });

    if (!variant) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy biến thể tương ứng trong sản phẩm",
      });
    }

    const normalizedModelId = String(modelId || "0");

    const mapping = await ShopeeSkuMapping.findOneAndUpdate(
      {
        shopId: String(shopId),
        itemId: String(itemId),
        modelId: normalizedModelId,
      },
      {
        $set: {
          shopId: String(shopId),
          itemId: String(itemId),
          modelId: normalizedModelId,

          itemSku: itemSku || "",
          variationSku: variationSku || "",
          itemName: itemName || "",
          modelName: modelName || "",

          productId: product._id,
          variantCode: String(variantCode),
          variantName: variant.name || variantName || "",

          quantityMultiplier: multiplier,

          allowStockDeduction: allowStockDeduction === true,

          isActive: true,
          note: note || "",
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.json({
      success: true,
      message: "Lưu ánh xạ SKU thành công",
      data: mapping,
    });
  } catch (error) {
    console.error("saveSkuMapping:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// =====================================================
// 3. TẮT ÁNH XẠ SKU
// PATCH /api/shopee/management/sku-mappings/:id/disable
// =====================================================

exports.disableSkuMapping = async (req, res) => {
  try {
    const { id } = req.params;

    const mapping = await ShopeeSkuMapping.findByIdAndUpdate(
      id,
      {
        $set: {
          isActive: false,
        },
      },
      {
        new: true,
      },
    );

    if (!mapping) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy ánh xạ SKU",
      });
    }

    return res.json({
      success: true,
      message: "Đã tắt ánh xạ SKU",
      data: mapping,
    });
  } catch (error) {
    console.error("disableSkuMapping:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
// =====================================================
// 4. DANH SÁCH ĐƠN SHOPEE ĐÃ LƯU
// GET /api/shopee/management/orders
// =====================================================

exports.getSavedOrders = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter = { shopId };

    if (req.query.orderSn) {
      filter.orderSn = {
        $regex: String(req.query.orderSn).trim(),
        $options: "i",
      };
    }

    if (req.query.stockStatus) {
      filter.stockStatus = req.query.stockStatus;
    }

    if (req.query.orderStatus) {
      filter.orderStatus = req.query.orderStatus;
    }

    const [orders, total] = await Promise.all([
      ShopeeOrder.find(filter)
        .sort({ createTime: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeOrder.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// 5. CHI TIẾT ĐƠN SHOPEE
// GET /api/shopee/management/orders/:orderSn
// =====================================================

exports.getSavedOrderDetail = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const order = await ShopeeOrder.findOne({
      shopId,
      orderSn: req.params.orderSn,
    }).lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    return res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// 6. DANH SÁCH YÊU CẦU TRẢ HÀNG
// GET /api/shopee/management/returns
// =====================================================

exports.getSavedReturns = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter = { shopId };

    if (req.query.returnSn) {
      filter.returnSn = {
        $regex: String(req.query.returnSn).trim(),
        $options: "i",
      };
    }

    if (req.query.orderSn) {
      filter.orderSn = String(req.query.orderSn);
    }

    if (req.query.warehouseStatus) {
      filter.warehouseStatus = req.query.warehouseStatus;
    }

    const [returns, total] = await Promise.all([
      ShopeeReturn.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeReturn.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: returns,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// 7. CHI TIẾT YÊU CẦU TRẢ HÀNG
// GET /api/shopee/management/returns/:returnSn
// =====================================================

exports.getSavedReturnDetail = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const returnDoc = await ShopeeReturn.findOne({
      shopId,
      returnSn: req.params.returnSn,
    }).lean();

    if (!returnDoc) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy yêu cầu trả hàng",
      });
    }

    return res.json({
      success: true,
      data: returnDoc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};
