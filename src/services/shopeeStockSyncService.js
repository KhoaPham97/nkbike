const mongoose = require("mongoose");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const ShopeeStockSyncSetting = require("../models/ShopeeStockSyncSetting");
const ShopeeStockSyncLog = require("../models/ShopeeStockSyncLog");

const { Product } = require("../models/products");
const { callShopeeShopApi } = require("./shopeeService");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let isRunning = false;

// =====================================================
// SETTINGS
// =====================================================

async function getStockSyncSettings() {
  let settings = await ShopeeStockSyncSetting.findById("global");

  if (!settings) {
    settings = await ShopeeStockSyncSetting.create({
      _id: "global",
    });
  }

  return settings;
}

async function updateShopeeStock({
  shopId,
  itemId,
  modelId,
  targetQty,
  hasModel,
}) {
  const normalizedStock = normalizeStock(targetQty);

  const stockItem = {
    model_id: hasModel ? Number(modelId) : 0,
    seller_stock: [
      {
        stock: normalizedStock,
      },
    ],
  };

  const body = {
    item_id: Number(itemId),
    stock_list: [stockItem],
  };

  const data = await callShopeeShopApi({
    shopId: String(shopId),
    path: "/api/v2/product/update_stock",
    method: "POST",
    body,
  });

  const result = data.response || data;

  const failureList = result.failure_list || [];

  if (failureList.length > 0) {
    const failure = failureList[0];

    throw new Error(
      failure.failed_reason ||
        failure.message ||
        failure.error ||
        `Shopee từ chối cập nhật tồn kho itemId=${itemId}`,
    );
  }

  return {
    requestId: data.request_id || null,
    response: result,
  };
}

// =====================================================
// NORMALIZE STOCK
// =====================================================

function normalizeStock(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 0;

  return Math.max(0, Math.floor(number));
}

function getAvailableStock(variant, safetyBuffer = 0) {
  const physicalQty = normalizeStock(variant?.qty);
  const reservedQty = normalizeStock(variant?.reservedQty);

  return Math.max(0, physicalQty - reservedQty - safetyBuffer);
}

function getTargetShopeeStock(variant, mapping, safetyBuffer = 0) {
  const availableQty = getAvailableStock(variant, safetyBuffer);
  const multiplier = Math.max(
    1,
    Math.floor(Number(mapping.quantityMultiplier) || 1),
  );

  // Ví dụ:
  // Kho nội bộ còn 10, multiplier = 2.
  // Shopee có thể bán tối đa 5 đơn vị.
  return Math.floor(availableQty / multiplier);
}

// =====================================================
// SHOPEE STOCK HELPERS
// =====================================================

function getShopeeAvailableStock(stockInfo) {
  if (!stockInfo) return null;

  const summary = stockInfo.summary_info || {};

  const candidates = [
    summary.total_available_stock,
    summary.total_reserved_stock !== undefined &&
    summary.total_reserved_stock !== null
      ? Number(summary.total_available_stock || 0)
      : undefined,
    stockInfo.normal_stock,
  ];

  for (const value of candidates) {
    if (
      value !== undefined &&
      value !== null &&
      Number.isFinite(Number(value))
    ) {
      return normalizeStock(value);
    }
  }

  return null;
}

async function getShopeeItemStock(shopId, itemId) {
  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/product/get_item_base_info",
    method: "GET",
    params: {
      item_id_list: String(itemId),
      response_optional_fields: "item_sku,model,has_model,stock_info_v2",
    },
  });

  const result = data.response || data;
  const item = result.item_list?.[0];

  if (!item) {
    throw new Error(`Không tìm thấy sản phẩm Shopee itemId=${itemId}`);
  }

  if (item.has_model) {
    const modelData = await callShopeeShopApi({
      shopId,
      path: "/api/v2/product/get_model_list",
      method: "GET",
      params: {
        item_id: Number(itemId),
      },
    });

    const modelResult = modelData.response || modelData;

    return {
      hasModel: true,
      item,
      models: modelResult.model || [],
    };
  }

  return {
    hasModel: false,
    item,
    models: [],
  };
}

function findShopeeStock(snapshot, mapping) {
  const modelId = String(mapping.modelId || "0");

  if (snapshot.hasModel) {
    const model = snapshot.models.find(
      (item) => String(item.model_id) === modelId,
    );

    if (!model) {
      throw new Error(
        `Không tìm thấy modelId=${modelId} của itemId=${mapping.itemId}`,
      );
    }

    const stockInfo = model.stock_info_v2 || null;

    const stock = getShopeeAvailableStock(stockInfo);

    if (stock === null) {
      throw new Error(
        `Shopee không trả về stock_info_v2 cho modelId=${modelId}`,
      );
    }

    return stock;
  }

  const stock = getShopeeAvailableStock(snapshot.item.stock_info_v2);

  if (stock === null) {
    throw new Error(
      `Shopee không trả về stock_info_v2 cho itemId=${mapping.itemId}`,
    );
  }

  return stock;
}

// =====================================================
// UPDATE SHOPEE STOCK
// =====================================================

async function updateShopeeStock({
  shopId,
  itemId,
  modelId,
  targetQty,
  hasModel,
}) {
  const stockItem = {
    normal_stock: normalizeStock(targetQty),
  };

  if (hasModel) {
    stockItem.model_id = Number(modelId);
  }

  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/product/update_stock",
    method: "POST",
    params: {
      item_id: Number(itemId),
    },
    body: {
      stock_list: [stockItem],
    },
  });

  const result = data.response || data;

  const failureList = result.failure_list || [];

  if (failureList.length > 0) {
    const failure = failureList[0];

    throw new Error(
      failure.message ||
        failure.error ||
        `Shopee từ chối cập nhật tồn kho itemId=${itemId}`,
    );
  }

  return {
    requestId: data.request_id || null,
    response: result,
  };
}

// =====================================================
// SKU VALIDATION
// =====================================================

function normalizeSku(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function validateExactSku(mapping, variant) {
  const shopeeSku = normalizeSku(mapping.variationSku || mapping.itemSku);

  const internalSku = normalizeSku(variant?.sku);

  if (!shopeeSku) {
    throw new Error(
      "Mapping Shopee chưa có SKU. Không thể đồng bộ tồn kho an toàn.",
    );
  }

  if (!internalSku) {
    throw new Error(`Biến thể ${mapping.variantCode} chưa có SKU nội bộ.`);
  }

  if (shopeeSku !== internalSku) {
    throw new Error(
      `SKU không khớp: Shopee=${shopeeSku}, nội bộ=${internalSku}`,
    );
  }
}

// =====================================================
// SYNC ONE MAPPING
// =====================================================

async function syncOneMapping({ mapping, settings, snapshot, logResult }) {
  const product = await Product.findById(mapping.productId).lean();

  if (!product) {
    throw new Error(`Không tìm thấy sản phẩm nội bộ ${mapping.productId}`);
  }

  const variant = (product.variants || []).find(
    (item) =>
      String(item.variantCode || "").trim() ===
      String(mapping.variantCode || "").trim(),
  );

  if (!variant) {
    throw new Error(
      `Không tìm thấy biến thể variantCode=${mapping.variantCode}`,
    );
  }

  validateExactSku(mapping, variant);

  const physicalQty = normalizeStock(variant.qty);
  const reservedQty = normalizeStock(variant.reservedQty);
  const bufferQty = normalizeStock(settings.safetyBuffer);

  const targetQty = getTargetShopeeStock(variant, mapping, bufferQty);

  const previousShopeeQty = findShopeeStock(snapshot, mapping);

  Object.assign(logResult, {
    shopId: String(mapping.shopId),
    itemId: String(mapping.itemId),
    modelId: String(mapping.modelId || "0"),
    itemName: mapping.itemName || product.title || "",
    modelName: mapping.modelName || mapping.variantName || "",
    shopeeSku: mapping.variationSku || mapping.itemSku || "",
    variantCode: mapping.variantCode,
    productId: mapping.productId,
    physicalQty,
    reservedQty,
    bufferQty,
    targetQty,
    previousShopeeQty,
  });

  // Không gọi API cập nhật nếu tồn kho không thay đổi.
  if (previousShopeeQty === targetQty) {
    logResult.status = "unchanged";
    logResult.syncedShopeeQty = previousShopeeQty;
    logResult.message = "Tồn kho Shopee đã khớp.";
    return;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
    try {
      const updateResult = await updateShopeeStock({
        shopId: mapping.shopId,
        itemId: mapping.itemId,
        modelId: mapping.modelId || "0",
        targetQty,
        hasModel: snapshot.hasModel,
      });

      logResult.status = "success";
      logResult.syncedShopeeQty = targetQty;
      logResult.requestId = updateResult.requestId;
      logResult.message = "Đã cập nhật tồn kho Shopee.";
      logResult.processedAt = new Date();

      return;
    } catch (error) {
      lastError = error;

      if (attempt < settings.maxRetries) {
        await sleep(settings.retryDelayMs);
      }
    }
  }

  throw lastError || new Error("Không thể đồng bộ tồn kho Shopee.");
}

// =====================================================
// MAIN SYNC
// =====================================================

async function runShopeeStockSync({ trigger = "cron" } = {}) {
  if (isRunning) {
    return {
      success: false,
      skipped: true,
      message: "Đang có tiến trình đồng bộ tồn kho khác chạy.",
    };
  }

  isRunning = true;

  const startedAt = Date.now();
  const started = new Date();

  let log = null;

  try {
    const settings = await getStockSyncSettings();

    if (!settings.enabled && trigger === "cron") {
      return {
        success: true,
        skipped: true,
        message: "Đồng bộ tồn kho Shopee đang tắt.",
      };
    }

    log = await ShopeeStockSyncLog.create({
      trigger,
      status: "running",
      startedAt: started,
    });

    await ShopeeStockSyncSetting.updateOne(
      { _id: "global" },
      {
        $set: {
          lastRunAt: started,
          lastRunStatus: "running",
          lastError: "",
        },
      },
    );

    const shops = await ShopeeShop.find({
      status: "connected",
    }).select("shopId");

    const shopIds = shops.map((shop) => String(shop.shopId));

    const mappings = await ShopeeSkuMapping.find({
      shopId: { $in: shopIds },
      isActive: true,
    }).lean();

    const snapshots = new Map();

    const results = [];

    let successCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Lấy snapshot tồn kho Shopee một lần cho mỗi item.
    for (const mapping of mappings) {
      const itemKey = `${mapping.shopId}:${mapping.itemId}`;

      if (!snapshots.has(itemKey)) {
        try {
          const snapshot = await getShopeeItemStock(
            mapping.shopId,
            mapping.itemId,
          );

          snapshots.set(itemKey, snapshot);
        } catch (error) {
          snapshots.set(itemKey, { error });
        }
      }
    }

    for (const mapping of mappings) {
      const result = {
        shopId: String(mapping.shopId),
        itemId: String(mapping.itemId),
        modelId: String(mapping.modelId || "0"),
        status: "pending",
        processedAt: new Date(),
      };

      const snapshot = snapshots.get(`${mapping.shopId}:${mapping.itemId}`);

      try {
        if (snapshot?.error) {
          throw snapshot.error;
        }

        if (!snapshot) {
          throw new Error("Không lấy được dữ liệu tồn kho Shopee.");
        }

        await syncOneMapping({
          mapping,
          settings,
          snapshot,
          logResult: result,
        });

        if (result.status === "success") successCount += 1;
        else if (result.status === "unchanged") unchangedCount += 1;
        else skippedCount += 1;
      } catch (error) {
        result.status = "failed";
        result.message = error.message || String(error);
        result.errorCode =
          error.shopeeError || error.code || error.response?.data?.error || "";
        result.requestId =
          error.shopeeRequestId || error.response?.data?.request_id || "";

        failedCount += 1;
      }

      results.push(result);
    }

    const finished = new Date();
    const durationMs = Date.now() - startedAt;

    const totalCount = mappings.length;

    const status =
      failedCount === 0
        ? "success"
        : successCount + unchangedCount > 0
          ? "partial"
          : "failed";

    await ShopeeStockSyncLog.findByIdAndUpdate(log._id, {
      $set: {
        status,
        finishedAt: finished,
        durationMs,
        totalCount,
        successCount,
        unchangedCount,
        failedCount,
        skippedCount,
        results,
      },
    });

    await ShopeeStockSyncSetting.updateOne(
      { _id: "global" },
      {
        $set: {
          lastRunAt: started,
          lastRunStatus: status,
          ...(status === "success"
            ? {
                lastSuccessAt: finished,
                lastError: "",
              }
            : {
                lastErrorAt: finished,
                lastError:
                  failedCount > 0
                    ? `${failedCount}/${totalCount} mapping đồng bộ thất bại.`
                    : "",
              }),
        },
      },
    );

    return {
      success: status !== "failed",
      status,
      logId: log._id,
      totalCount,
      successCount,
      unchangedCount,
      failedCount,
      skippedCount,
      durationMs,
      results,
    };
  } catch (error) {
    if (log?._id) {
      await ShopeeStockSyncLog.findByIdAndUpdate(log._id, {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          error: error.message || String(error),
        },
      }).catch(() => {});
    }

    await ShopeeStockSyncSetting.updateOne(
      { _id: "global" },
      {
        $set: {
          lastRunAt: started,
          lastRunStatus: "failed",
          lastErrorAt: new Date(),
          lastError: error.message || String(error),
        },
      },
    ).catch(() => {});

    throw error;
  } finally {
    isRunning = false;
  }
}

// =====================================================
// STATUS & HISTORY
// =====================================================

async function getShopeeStockSyncStatus() {
  const [settings, latestLog] = await Promise.all([
    getStockSyncSettings(),
    ShopeeStockSyncLog.findOne().sort({ createdAt: -1 }).lean(),
  ]);

  return {
    settings,
    isRunning,
    latestLog,
  };
}

async function getShopeeStockSyncHistory({
  page = 1,
  limit = 20,
  status,
} = {}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));

  const filter = {};

  if (status) {
    filter.status = status;
  }

  const [items, total] = await Promise.all([
    ShopeeStockSyncLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * pageLimit)
      .limit(pageLimit)
      .lean(),

    ShopeeStockSyncLog.countDocuments(filter),
  ]);

  return {
    items,
    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      totalPages: Math.ceil(total / pageLimit),
    },
  };
}

module.exports = {
  getStockSyncSettings,
  updateStockSyncSettings,
  runShopeeStockSync,
  getShopeeStockSyncStatus,
  getShopeeStockSyncHistory,
};
