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

exports.getSkuMappings = async (req, res) => {
  try {
    const shopId = getShopId(req);

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const mappings = await ShopeeSkuMapping.find({ shopId })
      .populate("productId", "title variants")
      .sort({ updatedAt: -1 });

    return res.json({
      success: true,
      data: mappings,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
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
      quantityMultiplier = 1,
      note = "",
    } = req.body;

    if (!shopId || !itemId || !productId || !variantCode || !variantName) {
      return res.status(400).json({
        success: false,
        message:
          "Vui lòng nhập đủ shopId, itemId, productId, variantCode và variantName",
      });
    }

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const multiplier = Number(quantityMultiplier);

    if (!Number.isInteger(multiplier) || multiplier <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantityMultiplier phải là số nguyên dương",
      });
    }

    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    const variants = product.variants.filter(
      (variant) =>
        String(variant.code || "").trim() === String(variantCode).trim() &&
        String(variant.name || "").trim() === String(variantName).trim(),
    );

    if (variants.length !== 1) {
      return res.status(400).json({
        success: false,
        message:
          "Không tìm thấy duy nhất một biến thể khớp variantCode và variantName",
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
          itemSku: itemSku || "",
          variationSku: variationSku || "",
          itemName: itemName || "",
          modelName: modelName || "",

          productId: product._id,
          variantCode: String(variantCode).trim(),
          variantName: String(variantName).trim(),

          quantityMultiplier: multiplier,
          active: true,
          note,
          updatedBy: req.user?._id || null,
        },
        $setOnInsert: {
          createdBy: req.user?._id || null,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      },
    );

    return res.json({
      success: true,
      message: "Đã lưu ánh xạ SKU",
      data: mapping,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
    });
  }
};

// =====================================================
// 3. TẮT ÁNH XẠ SKU
// PATCH /api/shopee/management/sku-mappings/:id/disable
// =====================================================

exports.disableSkuMapping = async (req, res) => {
  try {
    const mapping = await ShopeeSkuMapping.findByIdAndUpdate(
      req.params.id,
      { $set: { active: false } },
      { new: true },
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
    return res.status(500).json({
      success: false,
      message: getErrorMessage(error),
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
