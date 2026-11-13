const mongoose = require("mongoose");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const { Product } = require("../models/products");
const { backfillShopeeReviewMappings } = require("../services/shopeeReviewSyncService");

const {
  getShopeeAuthUrl,
  handleShopeeCallback,
  refreshShopeeAccessToken,
  getShopeeOrders,
  getShopeeProducts,
} = require("../services/shopeeService");

// =====================================================
// HELPERS
// =====================================================

function getMessage(error) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    "Đã xảy ra lỗi khi xử lý Shopee"
  );
}

function getAdminId(req) {
  return req.user?._id || req.user?.id || null;
}

function toString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeCode(value) {
  return toString(value).toUpperCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function getVariantCode(variant) {
  return (
    toString(variant.variantCode) ||
    toString(variant.code) ||
    toString(variant.sku)
  );
}

function getVariantName(variant) {
  return (
    toString(variant.variantName) ||
    toString(variant.name) ||
    toString(variant.title)
  );
}

async function syncProductShopeeIdsFromMappings(productIds) {
  const ids = [...new Set((productIds || []).map(toString).filter(Boolean))];
  if (!ids.length) {
    return { updated: 0, skipped: 0, conflicts: [] };
  }

  const mappings = await ShopeeSkuMapping.find({
    productId: { $in: ids },
    isActive: true,
  })
    .select("productId shopId itemId")
    .lean();

  const byProduct = new Map(ids.map((id) => [id, new Map()]));
  for (const mapping of mappings) {
    const productId = toString(mapping.productId);
    const shopId = toString(mapping.shopId);
    const itemId = toString(mapping.itemId);
    if (!productId || !shopId || !itemId) continue;
    const pairKey = `${shopId}:${itemId}`;
    byProduct.get(productId)?.set(pairKey, { shopId, itemId });
  }

  const operations = [];
  const conflicts = [];
  for (const [productId, pairs] of byProduct.entries()) {
    if (pairs.size > 1) {
      conflicts.push({ productId, mappings: [...pairs.values()] });
      continue;
    }

    const pair = [...pairs.values()][0] || { shopId: "", itemId: "" };
    operations.push({
      updateOne: {
        filter: { _id: productId },
        update: {
          $set: {
            shopeeShopId: pair.shopId,
            shopeeItemId: pair.itemId,
            updated_at: new Date(),
          },
        },
      },
    });
  }

  const result = operations.length
    ? await Product.bulkWrite(operations, { ordered: false })
    : { modifiedCount: 0 };

  return {
    updated: Number(result.modifiedCount || 0),
    skipped: conflicts.length,
    conflicts,
  };
}

function getVariants(product) {
  return Array.isArray(product?.variants) ? product.variants : [];
}

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

  // 1. Ưu tiên tìm chính xác bằng variantCode
  const matched = variants.find((variant) => {
    const code = getVariantCode(variant);

    return code && normalizeCode(code) === inputCode;
  });

  if (matched) {
    return {
      variantCode: getVariantCode(matched),
      variantName: getVariantName(matched),
    };
  }

  // 2. Chỉ fallback theo tên nếu khớp duy nhất
  if (inputName) {
    const nameMatches = variants.filter((variant) => {
      return getVariantName(variant).toLowerCase() === inputName.toLowerCase();
    });

    if (nameMatches.length > 1) {
      throw new Error(
        "Có nhiều biến thể trùng tên. Không thể tự động ánh xạ an toàn.",
      );
    }

    if (nameMatches.length === 1) {
      const variant = nameMatches[0];
      const code = getVariantCode(variant);

      if (!code) {
        throw new Error("Biến thể khớp tên nhưng chưa có variantCode.");
      }

      return {
        variantCode: code,
        variantName: getVariantName(variant),
      };
    }
  }

  throw new Error(
    `Không tìm thấy biến thể có variantCode "${variantCode}" trong sản phẩm.`,
  );
}

// =====================================================
// 1. KẾT NỐI SHOPEE
// POST /api/shopee/auth
// =====================================================
async function findShopeeShop(shopId) {
  if (!shopId) {
    throw new Error("Vui lòng chọn shop Shopee.");
  }

  const shop = await ShopeeShop.findOne({
    shopId: String(shopId),
  });

  if (!shop) {
    throw new Error("Không tìm thấy gian hàng Shopee.");
  }

  return shop;
}
exports.connectShopee = async (req, res) => {
  try {
    const authUrl = await getShopeeAuthUrl({
      userId: getAdminId(req),
    });

    if (!authUrl) {
      return sendError(res, 400, "Không tạo được đường dẫn kết nối Shopee.");
    }

    return res.json({
      success: true,
      authUrl,
      url: authUrl,
    });
  } catch (error) {
    console.error("connectShopee:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// =====================================================
// 2. SHOPEE CALLBACK
// GET /api/shopee/callback
// Không yêu cầu JWT
// =====================================================

exports.shopeeCallback = async (req, res) => {
  const frontendUrl =
    process.env.SHOPEE_FRONTEND_URL || "http://localhost:5173/admin";

  try {
    const result = await handleShopeeCallback(req.query);

    const redirectUrl = new URL(frontendUrl);

    if (result?.success === false) {
      redirectUrl.searchParams.set("shopee", "error");
      redirectUrl.searchParams.set(
        "message",
        result.message || "Kết nối Shopee thất bại",
      );

      return res.redirect(redirectUrl.toString());
    }

    redirectUrl.searchParams.set("shopee", "success");

    if (result?.shopId) {
      redirectUrl.searchParams.set("shopId", String(result.shopId));
    }

    return res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error("shopeeCallback:", error);

    const redirectUrl = new URL(frontendUrl);

    redirectUrl.searchParams.set("shopee", "error");
    redirectUrl.searchParams.set("message", getMessage(error));

    return res.redirect(redirectUrl.toString());
  }
};

// =====================================================
// 3. DANH SÁCH SHOP
// GET /api/shopee/shops
// =====================================================

exports.getShopeeShops = async (req, res) => {
  try {
    const shops = await ShopeeShop.find({})
      .select("-accessToken -refreshToken -refreshTokenExpiresAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: shops,
      shops,
    });
  } catch (error) {
    console.error("getShopeeShops:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// Tương thích nếu route cũ đang gọi getShopsAsync
exports.getShopsAsync = exports.getShopeeShops;

// =====================================================
// 4. LÀM MỚI ACCESS TOKEN
// POST /api/shopee/refresh-token
// =====================================================

exports.refreshShopeeToken = async (req, res) => {
  try {
    const { shopId } = req.body;

    if (!shopId) {
      return sendError(res, 400, "Vui lòng cung cấp shopId.");
    }

    const result = await refreshShopeeAccessToken(String(shopId));

    return res.json({
      success: true,
      message: "Làm mới token thành công.",
      data: result,
    });
  } catch (error) {
    console.error("refreshShopeeToken:", error);
    return sendError(res, 400, getMessage(error));
  }
};

// =====================================================
// 5. NGẮT KẾT NỐI SHOP
// DELETE /api/shopee/shops/:shopId
// =====================================================

exports.disconnectShopeeShop = async (req, res) => {
  try {
    const shopId = toString(req.params.shopId);

    if (!shopId) {
      return sendError(res, 400, "Thiếu shopId.");
    }

    const shop = await ShopeeShop.findOneAndDelete({
      shopId,
    });

    if (!shop) {
      return sendError(res, 404, "Không tìm thấy shop Shopee.");
    }

    return res.json({
      success: true,
      message: "Đã ngắt kết nối shop Shopee.",
    });
  } catch (error) {
    console.error("disconnectShopeeShop:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// =====================================================
// 6. XEM ĐƠN TRỰC TIẾP TỪ SHOPEE
// POST /api/shopee/orders/sync
//
// Chỉ lấy dữ liệu, không tự động trừ kho.
// =====================================================

exports.viewShopeeOrders = async (req, res) => {
  try {
    const {
      shopId,
      timeFrom,
      timeTo,
      pageSize = 50,
      cursor = "",
      timeRangeField = "create_time",
      orderStatus,
    } = req.body;

    if (!shopId) {
      return sendError(res, 400, "Vui lòng chọn shop Shopee.");
    }

    if (!timeFrom || !timeTo) {
      return sendError(res, 400, "Vui lòng chọn khoảng thời gian.");
    }

    const from = Number(timeFrom);
    const to = Number(timeTo);

    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from <= 0 ||
      to <= 0 ||
      from > to
    ) {
      return sendError(res, 400, "Khoảng thời gian không hợp lệ.");
    }

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 100);

    const result = await getShopeeOrders({
      shopId: String(shopId),
      timeFrom: from,
      timeTo: to,
      pageSize: limit,
      cursor: String(cursor || ""),
      timeRangeField,
      orderStatus: orderStatus || undefined,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("viewShopeeOrders:", error);
    return sendError(res, 400, getMessage(error));
  }
};

// =====================================================
// 7. DANH SÁCH ÁNH XẠ SKU
// GET /api/shopee/management/sku-mappings
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
    console.error("getSkuMappingsAsync:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// =====================================================
// 8. VALIDATE DỮ LIỆU ÁNH XẠ
// =====================================================

async function validateMappingData(body, currentMapping = null) {
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
        ? body.isActive === true
        : (currentMapping?.isActive ?? true),

    allowStockDeduction:
      body.allowStockDeduction !== undefined
        ? body.allowStockDeduction === true
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

  const multiplier = Number(data.quantityMultiplier);

  if (!Number.isInteger(multiplier) || multiplier < 1) {
    throw new Error(
      "quantityMultiplier phải là số nguyên lớn hơn hoặc bằng 1.",
    );
  }

  data.quantityMultiplier = multiplier;

  const shop = await ShopeeShop.findOne({
    shopId: data.shopId,
  });

  if (!shop) {
    throw new Error("Không tìm thấy shop Shopee.");
  }

  const product = await Product.findById(data.productId);

  if (!product) {
    throw new Error("Không tìm thấy sản phẩm trong hệ thống.");
  }

  const variant = resolveProductVariant(
    product,
    data.variantCode,
    data.variantName,
  );

  data.variantCode = variant.variantCode;
  data.variantName = variant.variantName;

  return data;
}

// =====================================================
// 9. TẠO ÁNH XẠ SKU
// POST /api/shopee/management/sku-mappings
// =====================================================

exports.createSkuMappingAsync = async (req, res) => {
  try {
    const data = await validateMappingData(req.body);

    const userId = getAdminId(req);

    const mapping = await ShopeeSkuMapping.create({
      ...data,
      createdBy: userId,
      updatedBy: userId,
    });

    const productSync = await syncProductShopeeIdsFromMappings([data.productId]);
    const productSync = await syncProductShopeeIdsFromMappings([
      currentMapping.productId,
      data.productId,
    ]);
    try {
      await backfillShopeeReviewMappings({ shopId: data.shopId });
    } catch (syncError) {
      console.error("[Shopee Review] Backfill after mapping create failed:", syncError);
    }

    const result = await ShopeeSkuMapping.findById(mapping._id)
      .populate({
        path: "productId",
        select: "title name code variants type",
      })
      .lean();

    return res.status(201).json({
      success: true,
      message: "Tạo ánh xạ SKU Shopee thành công.",
      productSync,
      data: result,
    });
  } catch (error) {
    console.error("createSkuMappingAsync:", error);

    if (error.code === 11000) {
      return sendError(res, 409, "SKU Shopee này đã được ánh xạ.");
    }

    return sendError(res, 400, getMessage(error));
  }
};

// =====================================================
// 10. CẬP NHẬT ÁNH XẠ SKU
// PATCH /api/shopee/management/sku-mappings/:id
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

    const data = await validateMappingData(req.body, currentMapping);

    data.updatedBy = getAdminId(req);

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

    try {
      await backfillShopeeReviewMappings({ shopId: data.shopId });
    } catch (syncError) {
      console.error("[Shopee Review] Backfill after mapping update failed:", syncError);
    }

    return res.json({
      success: true,
      message: "Cập nhật ánh xạ SKU thành công.",
      productSync,
      data: updated,
    });
  } catch (error) {
    console.error("updateSkuMappingAsync:", error);

    if (error.code === 11000) {
      return sendError(
        res,
        409,
        "Ánh xạ này bị trùng với SKU Shopee đã tồn tại.",
      );
    }

    return sendError(res, 400, getMessage(error));
  }
};

// =====================================================
// 11. TẮT ÁNH XẠ SKU
// PATCH /api/shopee/management/sku-mappings/:id/disable
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
          updatedBy: getAdminId(req),
        },
      },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    const productSync = await syncProductShopeeIdsFromMappings([mapping.productId]);
    return res.json({
      success: true,
      message: "Đã tắt ánh xạ SKU Shopee.",
      productSync,
      data: mapping,
    });
  } catch (error) {
    console.error("disableSkuMappingAsync:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// =====================================================
// 12. BẬT LẠI ÁNH XẠ SKU
// PATCH /api/shopee/management/sku-mappings/:id/enable
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
          updatedBy: getAdminId(req),
        },
      },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    const productSync = await syncProductShopeeIdsFromMappings([mapping.productId]);
    return res.json({
      success: true,
      message: "Đã bật lại ánh xạ SKU Shopee.",
      productSync,
      data: mapping,
    });
  } catch (error) {
    console.error("enableSkuMappingAsync:", error);
    return sendError(res, 500, getMessage(error));
  }
};

// =====================================================
// 13. CẤP / THU HỒI QUYỀN TRỪ KHO CỦA ÁNH XẠ
// PATCH /api/shopee/management/sku-mappings/:id/stock-permission
// =====================================================

exports.updateStockPermissionAsync = async (req, res) => {
  try {
    const { id } = req.params;
    const { allowStockDeduction } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, "ID ánh xạ không hợp lệ.");
    }

    if (typeof allowStockDeduction !== "boolean") {
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
          allowStockDeduction,
          updatedBy: getAdminId(req),
        },
      },
      { new: true, runValidators: true },
    );

    if (!mapping) {
      return sendError(res, 404, "Không tìm thấy ánh xạ SKU.");
    }

    return res.json({
      success: true,
      message: allowStockDeduction
        ? "Đã cho phép ánh xạ tham gia xử lý tồn kho."
        : "Đã tắt quyền xử lý tồn kho của ánh xạ.",
      data: mapping,
    });
  } catch (error) {
    console.error("updateStockPermissionAsync:", error);
    return sendError(res, 500, getMessage(error));
  }
};
// =====================================================
// DELETE SKU MAPPING
// DELETE /management/sku-mappings/:id
// =====================================================

exports.deleteSkuMappingAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "ID ánh xạ không hợp lệ.",
      });
    }

    const mapping = await ShopeeSkuMapping.findByIdAndDelete(id);

    if (!mapping) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy ánh xạ SKU.",
      });
    }

    return res.json({
      success: true,
      message: "Đã xóa ánh xạ SKU Shopee.",
      data: mapping,
    });
  } catch (error) {
    console.error("[Shopee] deleteSkuMapping:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể xóa ánh xạ SKU.",
    });
  }
};
// =====================================================
// AUTO MATCH SKU MAPPINGS
// POST /management/sku-mappings/auto-match
// =====================================================

// =====================================================
// AUTO MATCH SKU MAPPINGS
// POST /management/sku-mappings/auto-match
//
// Backend tự lấy sản phẩm từ Shopee.
// So khớp SKU với variantCode / sku của Nhật Khang Bike.
// Chỉ tạo mapping khi tìm được kết quả duy nhất.
// Không tự cấp quyền trừ kho.
// =====================================================

exports.autoMatchSkuMappingsAsync = async (req, res) => {
  try {
    const shopId = toString(req.body.shopId);

    if (!shopId) {
      return sendError(res, 400, "Vui lòng chọn shop Shopee.");
    }

    // 1. Kiểm tra shop
    const shop = await findShopeeShop(shopId);

    if (!shop) {
      return sendError(res, 404, "Không tìm thấy shop Shopee.");
    }

    // 2. Lấy danh sách sản phẩm trực tiếp từ Shopee API
    const shopeeResult = await getShopeeProducts({
      shopId,
      itemStatuses: ["NORMAL"],
      pageSize: 100,
      includeModels: true,
    });

    const shopeeProducts = Array.isArray(shopeeResult?.products)
      ? shopeeResult.products
      : [];

    if (!shopeeProducts.length) {
      return res.json({
        success: true,
        message: "Shop Shopee chưa có sản phẩm đang hoạt động.",
        data: {
          totalShopeeProducts: 0,
          totalShopeeSkus: 0,
          created: [],
          skipped: [],
          errors: [],
        },
        summary: {
          created: 0,
          skipped: 0,
          errors: 0,
        },
      });
    }

    // 3. Lấy mapping đã tồn tại
    const existingMappings = await ShopeeSkuMapping.find({
      shopId,
    })
      .select("itemId modelId")
      .lean();

    const existingKeys = new Set(
      existingMappings.map(
        (mapping) =>
          `${toString(mapping.itemId)}_${toString(mapping.modelId || "0")}`,
      ),
    );

    // 4. Lấy sản phẩm trong hệ thống
    const products = await Product.find({
      variants: { $exists: true, $ne: [] },
    })
      .select("title name variants type")
      .lean();

    // 5. Tạo danh sách SKU nội bộ để tìm kiếm nhanh
    const internalVariants = [];

    for (const product of products) {
      for (const variant of getVariants(product)) {
        const variantCode = getVariantCode(variant);
        const variantName = getVariantName(variant);

        if (!variantCode) continue;

        // Lưu tất cả mã có thể dùng để đối chiếu.
        // Không chỉ dùng variantCode vì SKU có thể khác variantCode.
        const codes = [variant.variantCode, variant.code, variant.sku]
          .map(normalizeCode)
          .filter(Boolean);

        internalVariants.push({
          product,
          variant,
          variantCode,
          variantName,
          codes: [...new Set(codes)],
        });
      }
    }

    const results = {
      totalProducts: products.length,
      totalShopeeProducts: shopeeProducts.length,
      totalShopeeSkus: 0,
      created: [],
      skipped: [],
      errors: [],
    };

    // 6. Chuẩn hóa sản phẩm và biến thể Shopee thành từng SKU riêng
    const shopeeSkus = [];

    for (const item of shopeeProducts) {
      const itemId = toString(item.itemId);

      if (!itemId) continue;

      const models = Array.isArray(item.models) ? item.models : [];

      if (models.length > 0) {
        for (const model of models) {
          shopeeSkus.push({
            itemId,
            modelId: toString(model.modelId || "0"),
            itemSku: toString(item.itemSku),
            variationSku: toString(model.modelSku),
            itemName: toString(item.itemName),
            modelName: toString(model.modelName),
          });
        }
      } else {
        shopeeSkus.push({
          itemId,
          modelId: "0",
          itemSku: toString(item.itemSku),
          variationSku: "",
          itemName: toString(item.itemName),
          modelName: "",
        });
      }
    }

    results.totalShopeeSkus = shopeeSkus.length;

    // 7. Ghép từng SKU Shopee với biến thể nội bộ
    for (const item of shopeeSkus) {
      const itemId = item.itemId;
      const modelId = item.modelId || "0";
      const key = `${itemId}_${modelId}`;

      try {
        if (existingKeys.has(key)) {
          results.skipped.push({
            itemId,
            modelId,
            itemSku: item.itemSku,
            variationSku: item.variationSku,
            reason: "Sản phẩm/biến thể Shopee đã có mapping.",
          });

          continue;
        }

        const shopeeCodes = [
          normalizeCode(item.variationSku),
          normalizeCode(item.itemSku),
        ].filter(Boolean);

        let matched = null;
        let matchType = "";

        // Ưu tiên SKU biến thể Shopee.
        // Chỉ dùng itemSku nếu không có variationSku.
        const targetSku = shopeeCodes[0] || "";

        if (targetSku) {
          const skuMatches = internalVariants.filter((entry) =>
            entry.codes.includes(targetSku),
          );

          if (skuMatches.length === 1) {
            matched = skuMatches[0];
            matchType = "SKU";
          } else if (skuMatches.length > 1) {
            results.skipped.push({
              itemId,
              modelId,
              itemSku: item.itemSku,
              variationSku: item.variationSku,
              reason: `SKU "${targetSku}" trùng ở nhiều biến thể nội bộ.`,
            });

            continue;
          }
        }

        // 8. Fallback theo tên khi Shopee không có SKU.
        // Nếu có SKU nhưng không khớp thì không tự ghép theo tên,
        // tránh trường hợp ghép nhầm sản phẩm.
        if (!matched && !targetSku) {
          const targetName = toString(item.modelName).toLowerCase();

          if (targetName) {
            const nameMatches = internalVariants.filter(
              (entry) => entry.variantName.toLowerCase() === targetName,
            );

            if (nameMatches.length === 1) {
              matched = nameMatches[0];
              matchType = "NAME";
            } else if (nameMatches.length > 1) {
              results.skipped.push({
                itemId,
                modelId,
                modelName: item.modelName,
                reason: "Tên biến thể trùng ở nhiều sản phẩm.",
              });

              continue;
            }
          }
        }

        if (!matched) {
          results.skipped.push({
            itemId,
            modelId,
            itemName: item.itemName,
            modelName: item.modelName,
            itemSku: item.itemSku,
            variationSku: item.variationSku,
            reason: targetSku
              ? `Không tìm thấy SKU "${targetSku}" trong hệ thống.`
              : "Không tìm được biến thể khớp duy nhất.",
          });

          continue;
        }

        // 9. Kiểm tra và chuẩn hóa dữ liệu mapping
        const mappingData = await validateMappingData({
          shopId,
          itemId,
          modelId,
          itemSku: item.itemSku,
          variationSku: item.variationSku,
          itemName: item.itemName,
          modelName: item.modelName,
          productId: matched.product._id.toString(),
          variantCode: matched.variantCode,
          variantName: matched.variantName,
          quantityMultiplier: 1,
          isActive: true,

          // Quan trọng: không tự cho phép trừ kho
          allowStockDeduction: false,

          note: `Tự động ghép SKU theo ${matchType}.`,
        });

        // 10. Tạo mapping
        const created = await ShopeeSkuMapping.create({
          ...mappingData,
          createdBy: getAdminId(req),
          updatedBy: getAdminId(req),
        });

        existingKeys.add(key);

        results.created.push({
          mappingId: created._id,
          itemId,
          modelId,
          itemName: item.itemName,
          modelName: item.modelName,
          shopeeSku: item.variationSku || item.itemSku,
          productId: matched.product._id,
          productName: matched.product.title || matched.product.name,
          variantCode: matched.variantCode,
          variantName: matched.variantName,
          matchType,
          allowStockDeduction: false,
        });
      } catch (error) {
        // Trường hợp hai request đồng thời tạo cùng mapping
        if (error.code === 11000) {
          existingKeys.add(key);

          results.skipped.push({
            itemId,
            modelId,
            reason: "Mapping đã được tạo trước đó.",
          });

          continue;
        }

        results.errors.push({
          itemId,
          modelId,
          message: error.message,
        });
      }
    }

    const productSync = await syncProductShopeeIdsFromMappings(
      results.created.map((item) => item.productId),
    );
    try {
      await backfillShopeeReviewMappings({ shopId });
    } catch (syncError) {
      console.error("[Shopee Review] Backfill after auto-match failed:", syncError);
    }

    return res.json({
      success: true,
      message: "Đã hoàn tất tự động ghép SKU Shopee.",
      data: results,
      productSync,
      summary: {
        totalShopeeProducts: results.totalShopeeProducts,
        totalShopeeSkus: results.totalShopeeSkus,
        created: results.created.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
      },
    });
  } catch (error) {
    console.error("[Shopee Mapping] autoMatch:", error);

    return sendError(res, 500, getMessage(error));
  }
};
