const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");

function normalizeId(value, fallback = "0") {
  return String(value ?? fallback);
}

function makeItemKey(itemId, modelId) {
  return `${normalizeId(itemId)}_${normalizeId(modelId)}`;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toDate(value) {
  const timestamp = Number(value);

  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000)
    : null;
}

function normalizeReturnItems(rawItems, oldItems, mappingMap) {
  const oldMap = new Map();

  for (const item of oldItems || []) {
    oldMap.set(makeItemKey(item.itemId, item.modelId), item);
  }

  return (rawItems || []).map((raw) => {
    const itemId = normalizeId(raw.item_id);
    const modelId = normalizeId(raw.model_id);
    const key = makeItemKey(itemId, modelId);

    const oldItem = oldMap.get(key);
    const mapping = mappingMap.get(key);

    const mapped = Boolean(
      mapping?.active &&
      mapping.productId &&
      mapping.variantCode &&
      mapping.variantName,
    );

    return {
      itemId,
      modelId,

      itemName: raw.item_name || oldItem?.itemName || "",
      modelName: raw.model_name || oldItem?.modelName || "",

      itemSku: raw.item_sku || oldItem?.itemSku || "",
      variationSku: raw.model_sku || oldItem?.variationSku || "",

      requestedQty: toNumber(
        raw.amount ||
          raw.quantity ||
          raw.quantity_purchased ||
          oldItem?.requestedQty,
        0,
      ),

      productId: mapped ? mapping.productId : oldItem?.productId || null,

      variantCode: mapped ? mapping.variantCode : oldItem?.variantCode || "",

      variantName: mapped ? mapping.variantName : oldItem?.variantName || "",

      mappingStatus: mapped
        ? "mapped"
        : oldItem?.mappingStatus === "mapped"
          ? "mapped"
          : "unmapped",

      // Giữ nguyên tiến trình xử lý kho.
      receivedQty: toNumber(oldItem?.receivedQty, 0),
      goodQty: toNumber(oldItem?.goodQty, 0),
      damagedQty: toNumber(oldItem?.damagedQty, 0),
      restockedQty: toNumber(oldItem?.restockedQty, 0),
    };
  });
}

function calculateWarehouseStatus(items, previousStatus) {
  if (!items.length) return previousStatus || "waiting";

  const totalRequested = items.reduce(
    (sum, item) => sum + Number(item.requestedQty || 0),
    0,
  );

  const totalReceived = items.reduce(
    (sum, item) => sum + Number(item.receivedQty || 0),
    0,
  );

  const totalRestocked = items.reduce(
    (sum, item) => sum + Number(item.restockedQty || 0),
    0,
  );

  if (totalRequested > 0 && totalRestocked >= totalRequested) {
    return "restocked";
  }

  if (totalRestocked > 0) {
    return "partially_restocked";
  }

  if (totalReceived > 0) {
    return "received";
  }

  return previousStatus || "waiting";
}

// =====================================================
// LƯU MỘT YÊU CẦU TRẢ HÀNG
// =====================================================

async function saveOneShopeeReturn({ shopId, rawReturn, detail, mappingMap }) {
  const returnSn = String(detail?.return_sn || rawReturn?.return_sn || "");

  if (!returnSn) {
    throw new Error("Yêu cầu trả hàng thiếu return_sn");
  }

  const oldReturn = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn,
  });

  const rawItems = detail?.item_list || rawReturn?.item_list || [];

  const items = normalizeReturnItems(rawItems, oldReturn?.items, mappingMap);

  const warehouseStatus = calculateWarehouseStatus(
    items,
    oldReturn?.warehouseStatus,
  );

  const update = {
    shopId: String(shopId),
    returnSn,

    orderSn: String(
      detail?.order_sn || rawReturn?.order_sn || oldReturn?.orderSn || "",
    ),

    status:
      detail?.status || rawReturn?.status || oldReturn?.status || "UNKNOWN",

    reason: detail?.reason || rawReturn?.reason || oldReturn?.reason || "",

    refundAmount: toNumber(
      detail?.refund_amount ??
        rawReturn?.refund_amount ??
        oldReturn?.refundAmount,
      0,
    ),

    currency:
      detail?.currency || rawReturn?.currency || oldReturn?.currency || "VND",

    logisticsStatus:
      detail?.logistics_status ||
      rawReturn?.logistics_status ||
      oldReturn?.logisticsStatus ||
      "",

    trackingNumber:
      detail?.tracking_number ||
      rawReturn?.tracking_number ||
      oldReturn?.trackingNumber ||
      "",

    requestType:
      detail?.request_type ||
      rawReturn?.request_type ||
      oldReturn?.requestType ||
      "",

    createTime:
      toDate(detail?.create_time || rawReturn?.create_time) ||
      oldReturn?.createTime ||
      null,

    updateTime:
      toDate(detail?.update_time || rawReturn?.update_time) ||
      oldReturn?.updateTime ||
      null,

    items,
    warehouseStatus,
    lastSyncedAt: new Date(),

    rawData: detail || rawReturn,
  };

  return ShopeeReturn.findOneAndUpdate(
    {
      shopId: String(shopId),
      returnSn,
    },
    {
      $set: update,
      $setOnInsert: {
        receivedAt: null,
        receivedBy: null,
        inspectedAt: null,
        inspectedBy: null,
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
}

// =====================================================
// ĐỒNG BỘ DANH SÁCH YÊU CẦU TRẢ HÀNG
// =====================================================

async function saveShopeeReturns({ shopId, returnDetails }) {
  if (!shopId) {
    throw new Error("Thiếu shopId");
  }

  if (!Array.isArray(returnDetails)) {
    throw new Error("returnDetails phải là một mảng");
  }

  const mappings = await ShopeeSkuMapping.find({
    shopId: String(shopId),
    active: true,
  }).lean();

  const mappingMap = new Map();

  for (const mapping of mappings) {
    mappingMap.set(makeItemKey(mapping.itemId, mapping.modelId), mapping);
  }

  let saved = 0;
  let failed = 0;

  const results = [];

  for (const item of returnDetails) {
    try {
      const returnDoc = await saveOneShopeeReturn({
        shopId,
        rawReturn: item,
        detail: item,
        mappingMap,
      });

      saved += 1;

      results.push({
        returnSn: returnDoc.returnSn,
        success: true,
        warehouseStatus: returnDoc.warehouseStatus,
      });
    } catch (error) {
      failed += 1;

      results.push({
        returnSn: item?.return_sn || "",
        success: false,
        message: error.message,
      });
    }
  }

  return {
    total: returnDetails.length,
    saved,
    failed,
    results,
  };
}

module.exports = {
  saveShopeeReturns,
};
