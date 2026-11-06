const mongoose = require("mongoose");

const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const ShopeeShop = require("../models/ShopeeShop");
const { Product } = require("../models/products");

// =====================================================
// HELPERS
// =====================================================

const toString = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

const normalizeCode = (value) => toString(value).toUpperCase();

const getUserId = (req) => {
  return req.user?._id || req.user?.id || null;
};

const getVariantName = (variant) => {
  return (
    toString(variant.name) ||
    toString(variant.variantName) ||
    toString(variant.title)
  );
};

const getVariantCode = (variant) => {
  return (
    toString(variant.variantCode) ||
    toString(variant.code) ||
    toString(variant.sku)
  );
};

const getVariants = (product) => {
  return Array.isArray(product?.variants) ? product.variants : [];
};

const sendError = (res, status, message) => {
  return res.status(status).json({
    success: false,
    message,
  });
};

const escapeRegex = (value) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// =====================================================
// KIỂM TRA SHOP
// =====================================================

async function findShopeeShop(shopId) {
  return ShopeeShop.findOne({
    shopId: toString(shopId),
  });
}

// =====================================================
// KIỂM TRA VÀ CHUẨN HÓA BIẾN THỂ
// Ưu tiên variantCode.
// Chỉ fallback variantName nếu tên khớp duy nhất.
// =====================================================

function resolveProductVariant(product, variantCode, variantName) {
  const variants = getVariants(product);

  if (!variants.length) {
    throw new Error("Sản phẩm chưa có biến thể.");
  }

  const inputCode = normalizeCode(variantCode);
  const inputName = toString(variantName);

  if (!inputCode) {
    throw new Error("Thiếu variantCode.");
  }

  // 1. Tìm chính xác bằng variantCode
  let matched = variants.find((variant) => {
    return (
      getVariantCode(variant) &&
      normalizeCode(getVariantCode(variant)) === inputCode
    );
  });

  if (matched) {
    return {
      variantCode: getVariantCode(matched),
      variantName: getVariantName(matched),
    };
  }

  // 2. Fallback theo tên nhưng phải duy nhất
  if (inputName) {
    const nameMatches = variants.filter((variant) => {
      return getVariantName(variant).toLowerCase() === inputName.toLowerCase();
    });

    if (nameMatches.length === 1) {
      const fallbackVariant = nameMatches[0];
      const fallbackCode = getVariantCode(fallbackVariant);

      if (!fallbackCode) {
        throw new Error(
          "Biến thể khớp tên nhưng chưa có variantCode trong sản phẩm.",
        );
      }

      return {
        variantCode: fallbackCode,
        variantName: getVariantName(fallbackVariant),
      };
    }

    if (nameMatches.length > 1) {
      throw new Error(
        "Có nhiều biến thể trùng tên. Không thể tự động ánh xạ an toàn.",
      );
    }
  }

  throw new Error(
    `Không tìm thấy biến thể có variantCode "${variantCode}" trong sản phẩm.`,
  );
}

// =====================================================
// CHUẨN HÓA DỮ LIỆU ÁNH XẠ
// =====================================================

async function validateMappingData(body, options = {}) {
  const { currentMapping = null, partial = false } = options;

  const data = {
    shopId: toString(body.shopId ?? currentMapping?.shopId),
    itemId: toString(body.itemId ?? currentMapping?.itemId),
    modelId: toString(body.modelId ?? currentMapping?.modelId ?? "0"),
    itemSku: toString(body.itemSku ?? currentMapping?.itemSku),
    variationSku: toString(body.variationSku ?? currentMapping?.variationSku),
    itemName: toString(body.itemName ?? currentMapping?.itemName),
    modelName: toString(body.modelName ?? currentMapping?.modelName),
    productId: toString(body.productId ?? currentMapping?.productId),
    variantCode: toString(body.variantCode ?? currentMapping?.variantCode),
    variantName: toString(body.variantName ?? currentMapping?.variantName),
    quantityMultiplier:
      body.quantityMultiplier ?? currentMapping?.quantityMultiplier ?? 1,
    note: toString(body.note ?? currentMapping?.note),
    isActive:
      body.isActive !== undefined
        ? Boolean(body.isActive)
        : (currentMapping?.isActive ?? true),
    allowStockDeduction:
      body.allowStockDeduction !== undefined
        ? Boolean(body.allowStockDeduction)
        : (currentMapping?.allowStockDeduction ?? false),
  };

  if (!data.shopId || !data.itemId || !data.productId || !data.variantCode) {
    throw new Error(
      "Thiếu thông tin bắt buộc: shopId, itemId, productId, variantCode.",
    );
  }

  if (!mongoose.isValidObjectId(data.productId)) {
    throw new Error("productId không hợp lệ.");
  }

  if (
    !Number.isInteger(Number(data.quantityMultiplier)) ||
    Number(data.quantityMultiplier) < 1
  ) {
    throw new Error(
      "quantityMultiplier phải là số nguyên lớn hơn hoặc bằng 1.",
    );
  }

  data.quantityMultiplier = Number(data.quantityMultiplier);

  // Kiểm tra shop Shopee
  const shop = await findShopeeShop(data.shopId);

  if (!shop) {
    throw new Error("Không tìm thấy shop Shopee.");
  }

  // Kiểm tra sản phẩm
  const product = await Product.findById(data.productId);

  if (!product) {
    throw new Error("Không tìm thấy sản phẩm trong hệ thống.");
  }

  // Kiểm tra biến thể
  const variant = resolveProductVariant(
    product,
    data.variantCode,
    data.variantName,
  );

  data.variantCode = variant.variantCode;
  data.variantName = variant.variantName;

  if (partial && currentMapping) {
    data.updatedBy = options.userId || undefined;
  }

  return data;
}

// =====================================================
// 1. DANH SÁCH ÁNH XẠ
// GET /shopee/management/sku-mappings?shopId=...
// =====================================================

exports.getSkuMappingsAsync = async (req, res) => {
  try {
    const shopId = toString(req.query.shopId);

    if (!shopId) {
      return sendError(res, 400, "Vui lòng chọn shop Shopee.");
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    const filter = { shopId };

    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === "true";
    }

    if (req.query.allowStockDeduction !== undefined) {
      filter.allowStockDeduction = req.query.allowStockDeduction === "true";
    }

    const search = toString(req.query.search);

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");

      filter.$or = [
        { itemName: regex },
        { modelName: regex },
        { itemSku: regex },
        { variationSku: regex },
        { itemId: regex },
        { modelId: regex },
        { variantCode: regex },
        { variantName: regex },
      ];
    }

    const [mappings, total] = await Promise.all([
      ShopeeSkuMapping.find(filter)
        .populate({
          path: "productId",
          select: "title name code variants type",
        })
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      ShopeeSkuMapping.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: mappings,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Shopee Mapping] getSkuMappings:", error);

    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 2. TẠO ÁNH XẠ
// POST /shopee/management/sku-mappings
// =====================================================

exports.createSkuMappingAsync = async (req, res) => {
  try {
    const data = await validateMappingData(req.body);

    const userId = getUserId(req);

    const mapping = await ShopeeSkuMapping.create({
      ...data,
      createdBy: userId,
      updatedBy: userId,
    });

    const result = await ShopeeSkuMapping.findById(mapping._id)
      .populate({
        path: "productId",
        select: "title name code variants type",
      })
      .lean();

    return res.status(201).json({
      success: true,
      message: "Tạo ánh xạ SKU Shopee thành công.",
      data: result,
    });
  } catch (error) {
    console.error("[Shopee Mapping] createSkuMapping:", error);

    if (error.code === 11000) {
      return sendError(
        res,
        409,
        "SKU Shopee này đã được ánh xạ cho shop và biến thể tương ứng.",
      );
    }

    return sendError(
      res,
      error.message?.includes("Không tìm thấy") ||
        error.message?.includes("Thiếu") ||
        error.message?.includes("không hợp lệ") ||
        error.message?.includes("phải là") ||
        error.message?.includes("trùng tên") ||
        error.message?.includes("chưa có")
        ? 400
        : 500,
      error.message || "Không thể tạo ánh xạ.",
    );
  }
};

// =====================================================
// 3. CẬP NHẬT ÁNH XẠ
// PATCH /shopee/management/sku-mappings/:id
// =====================================================

exports.updateSkuMappingAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, "ID ánh xạ không hợp lệ.");
    }

    const currentMapping = await ShopeeSkuMapping.findById(id);

    if (!currentMapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    const data = await validateMappingData(req.body, {
      currentMapping,
      partial: true,
      userId: getUserId(req),
    });

    data.updatedBy = getUserId(req);

    const updated = await ShopeeSkuMapping.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true, runValidators: true },
    )
      .populate({
        path: "productId",
        select: "title name code variants type",
      })
      .lean();

    return res.json({
      success: true,
      message: "Cập nhật ánh xạ SKU thành công.",
      data: updated,
    });
  } catch (error) {
    console.error("[Shopee Mapping] updateSkuMapping:", error);

    if (error.code === 11000) {
      return sendError(
        res,
        409,
        "Ánh xạ này bị trùng với một SKU Shopee đã tồn tại.",
      );
    }

    return sendError(res, 400, error.message);
  }
};

// =====================================================
// 4. TẮT ÁNH XẠ
// PATCH /shopee/management/sku-mappings/:id/disable
// =====================================================

exports.disableSkuMappingAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, "ID ánh xạ không hợp lệ.");
    }

    const mapping = await ShopeeSkuMapping.findByIdAndUpdate(
      id,
      {
        $set: {
          isActive: false,
          updatedBy: getUserId(req),
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    return res.json({
      success: true,
      message: "Đã tắt ánh xạ SKU Shopee.",
      data: mapping,
    });
  } catch (error) {
    console.error("[Shopee Mapping] disableSkuMapping:", error);

    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 5. BẬT LẠI ÁNH XẠ
// PATCH /shopee/management/sku-mappings/:id/enable
// =====================================================

exports.enableSkuMappingAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, "ID ánh xạ không hợp lệ.");
    }

    const mapping = await ShopeeSkuMapping.findByIdAndUpdate(
      id,
      {
        $set: {
          isActive: true,
          updatedBy: getUserId(req),
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    return res.json({
      success: true,
      message: "Đã bật lại ánh xạ SKU Shopee.",
      data: mapping,
    });
  } catch (error) {
    console.error("[Shopee Mapping] enableSkuMapping:", error);

    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 6. CHO PHÉP / KHÔNG CHO PHÉP ÁNH XẠ TRỪ KHO
// PATCH /shopee/management/sku-mappings/:id/stock-permission
// =====================================================

exports.updateStockPermissionAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, "ID ánh xạ không hợp lệ.");
    }

    if (typeof req.body.allowStockDeduction !== "boolean") {
      return sendError(
        res,
        400,
        "allowStockDeduction phải là true hoặc false.",
      );
    }

    const mapping = await ShopeeSkuMapping.findByIdAndUpdate(
      id,
      {
        $set: {
          allowStockDeduction: req.body.allowStockDeduction,
          updatedBy: getUserId(req),
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    return res.json({
      success: true,
      message: req.body.allowStockDeduction
        ? "Đã cho phép ánh xạ này tham gia xử lý tồn kho."
        : "Đã tắt quyền xử lý tồn kho của ánh xạ.",
      data: mapping,
    });
  } catch (error) {
    console.error("[Shopee Mapping] updateStockPermission:", error);

    return sendError(res, 500, error.message);
  }
};
