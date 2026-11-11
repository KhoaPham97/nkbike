const mongoose = require("mongoose");

const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeReturnStockLog = require("../models/ShopeeReturnStockLog");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const { Product } = require("../models/products");

const { callShopeeShopApi } = require("./shopeeService");

const RETURN_LIST_PATH = "/api/v2/returns/get_return_list";
const RETURN_DETAIL_PATH = "/api/v2/returns/get_return_detail";

const MAX_PAGE_SIZE = 100;
const MAX_DATE_RANGE_SECONDS = 15 * 24 * 60 * 60;

// =====================================================
// HELPERS
// =====================================================

function toDate(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000);
}

function toStringId(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function getResponse(data) {
  return data?.response || data || {};
}

function getShopeeItems(returnData) {
  return Array.isArray(returnData?.item) ? returnData.item : [];
}

function normalizeReturnItem(item, mapping) {
  const itemId = toStringId(item.item_id);
  const modelId = toStringId(item.model_id, "0");

  return {
    itemId,
    modelId,

    itemName: item.name || item.item_name || "",
    modelName: item.model_name || "",

    itemSku: item.item_sku || "",
    variationSku: item.variation_sku || "",

    requestedQty: Math.max(0, Number(item.amount || 0)),

    productId: mapping?.productId || null,
    variantCode: mapping?.variantCode || "",
    variantName: mapping?.variantName || "",

    mappingStatus: mapping ? "mapped" : "unmapped",

    receivedQty: 0,
    goodQty: 0,
    damagedQty: 0,
    restockedQty: 0,
  };
}

function validateDateRange(from, to) {
  const start = Number(from);
  const end = Number(to);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start <= 0 ||
    end <= 0 ||
    start >= end
  ) {
    throw new Error("Khoảng thời gian đồng bộ hàng hoàn không hợp lệ.");
  }

  if (end - start > MAX_DATE_RANGE_SECONDS) {
    throw new Error("Shopee chỉ cho phép lọc tối đa 15 ngày mỗi lần.");
  }

  return {
    from: start,
    to: end,
  };
}

// =====================================================
// SKU MAPPING
// =====================================================

async function getReturnItemMappings(shopId, items) {
  const normalizedItems = (items || []).map((item) => ({
    itemId: toStringId(item.item_id),
    modelId: toStringId(item.model_id, "0"),
  }));

  const uniqueKeys = [
    ...new Set(
      normalizedItems
        .filter((item) => item.itemId)
        .map((item) => `${item.itemId}:${item.modelId}`),
    ),
  ];

  if (!uniqueKeys.length) {
    return new Map();
  }

  const itemIds = [
    ...new Set(normalizedItems.map((item) => item.itemId).filter(Boolean)),
  ];

  const mappings = await ShopeeSkuMapping.find({
    shopId: String(shopId),
    itemId: { $in: itemIds },
    isActive: true,
  }).lean();

  const mappingMap = new Map();

  for (const mapping of mappings) {
    const key = `${String(mapping.itemId)}:${String(mapping.modelId || "0")}`;

    mappingMap.set(key, mapping);
  }

  return mappingMap;
}

// =====================================================
// SHOPEE API
// =====================================================

async function getShopeeReturnDetail(shopId, returnSn) {
  if (!shopId || !returnSn) {
    throw new Error("Thiếu shopId hoặc returnSn.");
  }

  const data = await callShopeeShopApi({
    shopId: String(shopId),
    path: RETURN_DETAIL_PATH,
    method: "GET",
    params: {
      return_sn: String(returnSn),
    },
  });

  const result = getResponse(data);

  if (!result.return_sn) {
    throw new Error(`Shopee không trả về chi tiết yêu cầu hoàn ${returnSn}.`);
  }

  return result;
}

async function getShopeeReturnListPage({
  shopId,
  pageNo = 0,
  pageSize = 100,
  updateTimeFrom,
  updateTimeTo,
  createTimeFrom,
  createTimeTo,
  status,
}) {
  const params = {
    page_no: Number(pageNo),
    page_size: Math.min(Math.max(Number(pageSize) || 100, 1), MAX_PAGE_SIZE),
  };

  if (updateTimeFrom !== undefined && updateTimeFrom !== null) {
    params.update_time_from = Number(updateTimeFrom);
  }

  if (updateTimeTo !== undefined && updateTimeTo !== null) {
    params.update_time_to = Number(updateTimeTo);
  }

  if (createTimeFrom !== undefined && createTimeFrom !== null) {
    params.create_time_from = Number(createTimeFrom);
  }

  if (createTimeTo !== undefined && createTimeTo !== null) {
    params.create_time_to = Number(createTimeTo);
  }

  if (status) {
    params.status = String(status);
  }

  const data = await callShopeeShopApi({
    shopId: String(shopId),
    path: RETURN_LIST_PATH,
    method: "GET",
    params,
  });

  return {
    raw: data,
    response: getResponse(data),
  };
}

// =====================================================
// UPSERT RETURN
// =====================================================

async function saveShopeeReturn(shopId, returnData) {
  const returnSn = toStringId(returnData.return_sn);

  if (!returnSn) {
    throw new Error("Yêu cầu trả hàng không có return_sn.");
  }

  const items = getShopeeItems(returnData);

  const mappingMap = await getReturnItemMappings(shopId, items);

  const normalizedItems = items.map((item) => {
    const itemId = toStringId(item.item_id);
    const modelId = toStringId(item.model_id, "0");

    const mapping = mappingMap.get(`${itemId}:${modelId}`);

    return normalizeReturnItem(item, mapping);
  });

  const existing = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn,
  });

  // Giữ nguyên thông tin kiểm hàng và xử lý kho đã nhập.
  const mergedItems = normalizedItems.map((newItem) => {
    const oldItem = existing?.items?.find(
      (item) =>
        String(item.itemId) === String(newItem.itemId) &&
        String(item.modelId || "0") === String(newItem.modelId || "0"),
    );

    if (!oldItem) {
      return newItem;
    }

    return {
      ...newItem,

      receivedQty: oldItem.receivedQty || 0,
      goodQty: oldItem.goodQty || 0,
      damagedQty: oldItem.damagedQty || 0,
      restockedQty: oldItem.restockedQty || 0,

      // Nếu đã mapping thủ công thì không tự ghi đè.
      productId: oldItem.productId || newItem.productId,
      variantCode: oldItem.variantCode || newItem.variantCode,
      variantName: oldItem.variantName || newItem.variantName,

      mappingStatus:
        oldItem.mappingStatus === "mapped" ? "mapped" : newItem.mappingStatus,
    };
  });

  const totalRequestedQty = normalizedItems.reduce(
    (sum, item) => sum + Number(item.requestedQty || 0),
    0,
  );

  const update = {
    shopId: String(shopId),
    returnSn,
    orderSn: toStringId(returnData.order_sn),

    shopeeStatus: returnData.status || "",

    reason: returnData.reason || "",
    textReason: returnData.text_reason || "",

    refundAmount: Number(returnData.refund_amount || 0),
    currency: returnData.currency || "VND",

    needsLogistics: Boolean(returnData.needs_logistics),
    trackingNumber: returnData.tracking_number || "",

    validationType: returnData.validation_type || "",

    requestType:
      returnData.return_refund_request_type === undefined
        ? null
        : Number(returnData.return_refund_request_type),

    createTime: toDate(returnData.create_time),
    updateTime: toDate(returnData.update_time),

    returnShipDueDate: toDate(returnData.return_ship_due_date),
    returnSellerDueDate: toDate(returnData.return_seller_due_date),

    requestedShopeeQty: totalRequestedQty,

    items: mergedItems,

    rawData: returnData,
    lastSyncedAt: new Date(),
  };

  // Không cho Shopee sync ghi đè trạng thái kho nội bộ.
  const saved = await ShopeeReturn.findOneAndUpdate(
    {
      shopId: String(shopId),
      returnSn,
    },
    {
      $set: update,
      $setOnInsert: {
        warehouseStatus: "waiting",
        restockedStockQty: 0,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  );

  return saved;
}

// =====================================================
// SYNC RETURNS
// =====================================================

/**
 * Đồng bộ danh sách yêu cầu trả hàng.
 *
 * Mặc định lấy 15 ngày gần nhất theo update_time.
 * Có thể truyền updateTimeFrom/updateTimeTo để đồng bộ
 * theo khoảng thời gian cụ thể.
 *
 * Không cộng kho.
 * Không trừ kho.
 */

async function syncShopeeReturns({
  shopId,
  updateTimeFrom,
  updateTimeTo,
  pageSize = 100,
  maxPages = 100,
  fetchDetails = true,
} = {}) {
  if (!shopId) {
    throw new Error("Vui lòng chọn shop Shopee.");
  }

  const now = Math.floor(Date.now() / 1000);

  const end = Number(updateTimeTo || now);

  const start = Number(updateTimeFrom || end - 14 * 24 * 60 * 60);

  const range = validateDateRange(start, end);

  const limit = Math.min(Math.max(Number(pageSize) || 100, 1), MAX_PAGE_SIZE);

  const pageLimit = Math.min(Math.max(Number(maxPages) || 100, 1), 1000);

  let pageNo = 0;

  let totalFetched = 0;
  let totalSaved = 0;
  let totalFailed = 0;

  const errors = [];
  const syncedReturns = [];

  while (pageNo < pageLimit) {
    const page = await getShopeeReturnListPage({
      shopId,
      pageNo,
      pageSize: limit,
      updateTimeFrom: range.from,
      updateTimeTo: range.to,
    });

    const returnList = Array.isArray(page.response.return)
      ? page.response.return
      : [];

    totalFetched += returnList.length;

    if (!returnList.length) {
      break;
    }

    for (const returnSummary of returnList) {
      const returnSn = toStringId(returnSummary.return_sn);

      if (!returnSn) {
        totalFailed += 1;
        errors.push({
          returnSn: "",
          message: "Shopee trả về yêu cầu không có return_sn.",
        });
        continue;
      }

      try {
        let returnDetail = returnSummary;

        if (fetchDetails) {
          returnDetail = await getShopeeReturnDetail(shopId, returnSn);
        }

        const saved = await saveShopeeReturn(shopId, returnDetail);

        totalSaved += 1;

        syncedReturns.push({
          returnSn,
          orderSn: saved.orderSn,
          shopeeStatus: saved.shopeeStatus,
          warehouseStatus: saved.warehouseStatus,
        });
      } catch (error) {
        totalFailed += 1;

        errors.push({
          returnSn,
          message: error.message || String(error),
        });

        console.error(`[Shopee Return Sync] ${returnSn}:`, error.message);
      }
    }

    if (!page.response.more) {
      break;
    }

    // Shopee page_no hoạt động theo offset.
    pageNo += limit;
  }

  return {
    success: totalFailed === 0,
    shopId: String(shopId),

    totalFetched,
    totalSaved,
    totalFailed,

    hasMore: pageNo >= pageLimit,

    returns: syncedReturns,
    errors,

    syncedAt: new Date(),
  };
}

// =====================================================
// GET RETURNS
// =====================================================

async function getShopeeReturns({
  shopId,
  page = 1,
  limit = 20,
  warehouseStatus,
  shopeeStatus,
  keyword,
  mappingStatus,
} = {}) {
  const filter = {};

  if (shopId) {
    filter.shopId = String(shopId);
  }

  if (warehouseStatus) {
    filter.warehouseStatus = warehouseStatus;
  }

  if (shopeeStatus) {
    filter.shopeeStatus = shopeeStatus;
  }

  if (mappingStatus) {
    filter["items.mappingStatus"] = mappingStatus;
  }

  if (keyword) {
    const search = String(keyword).trim();

    if (search) {
      filter.$or = [
        { returnSn: { $regex: search, $options: "i" } },
        { orderSn: { $regex: search, $options: "i" } },
        { trackingNumber: { $regex: search, $options: "i" } },
      ];
    }
  }

  const currentPage = Math.max(Number(page) || 1, 1);

  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const skip = (currentPage - 1) * pageSize;

  const [returns, total] = await Promise.all([
    ShopeeReturn.find(filter)
      .sort({ updateTime: -1, createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),

    ShopeeReturn.countDocuments(filter),
  ]);

  return {
    returns,
    pagination: {
      page: currentPage,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

async function getShopeeReturnBySn(shopId, returnSn) {
  const result = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn: String(returnSn),
  }).lean();

  if (!result) {
    throw new Error("Không tìm thấy yêu cầu trả hàng.");
  }

  return result;
}

// =====================================================
// RECEIVE RETURN
// =====================================================

/**
 * Xác nhận hàng hoàn đã thực sự về kho.
 * Không cộng tồn kho tại bước này.
 */

async function receiveShopeeReturn({
  shopId,
  returnSn,
  userId,
  note = "",
} = {}) {
  const returnDoc = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn: String(returnSn),
  });

  if (!returnDoc) {
    throw new Error("Không tìm thấy yêu cầu trả hàng.");
  }

  if (returnDoc.warehouseStatus === "restocked") {
    throw new Error("Yêu cầu này đã được nhập lại kho.");
  }

  if (returnDoc.warehouseStatus === "closed") {
    throw new Error("Yêu cầu này đã đóng.");
  }

  returnDoc.warehouseStatus = "received";
  returnDoc.receivedAt = new Date();
  returnDoc.receivedBy = userId || null;

  if (note) {
    returnDoc.rawData = {
      ...(returnDoc.rawData || {}),
      warehouseReceiveNote: String(note),
    };
  }

  await returnDoc.save();

  return returnDoc;
}

// =====================================================
// INSPECT RETURN
// =====================================================

/**
 * Xác nhận kết quả kiểm hàng.
 *
 * items:
 * [
 *   {
 *     itemId: "123",
 *     modelId: "456",
 *     receivedQty: 2,
 *     goodQty: 1,
 *     damagedQty: 1
 *   }
 * ]
 *
 * Các số lượng ở đây là số lượng thực tế theo đơn vị
 * sản phẩm kho Nhật Khang Bike.
 *
 * Chưa cộng kho tại bước kiểm hàng.
 */

async function inspectShopeeReturn({
  shopId,
  returnSn,
  userId,
  items,
  note = "",
} = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Vui lòng nhập kết quả kiểm hàng.");
  }

  const returnDoc = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn: String(returnSn),
  });

  if (!returnDoc) {
    throw new Error("Không tìm thấy yêu cầu trả hàng.");
  }

  if (!["received", "inspected"].includes(returnDoc.warehouseStatus)) {
    throw new Error("Bạn cần xác nhận đã nhận hàng trước khi kiểm hàng.");
  }

  for (const input of items) {
    const itemId = toStringId(input.itemId);
    const modelId = toStringId(input.modelId, "0");

    const target = returnDoc.items.find(
      (item) =>
        String(item.itemId) === itemId &&
        String(item.modelId || "0") === modelId,
    );

    if (!target) {
      throw new Error(
        `Không tìm thấy sản phẩm hoàn itemId=${itemId}, modelId=${modelId}.`,
      );
    }

    const receivedQty = Number(input.receivedQty || 0);
    const goodQty = Number(input.goodQty || 0);
    const damagedQty = Number(input.damagedQty || 0);

    if (
      !Number.isInteger(receivedQty) ||
      !Number.isInteger(goodQty) ||
      !Number.isInteger(damagedQty) ||
      receivedQty < 0 ||
      goodQty < 0 ||
      damagedQty < 0
    ) {
      throw new Error("Số lượng kiểm hàng phải là số nguyên không âm.");
    }

    if (goodQty + damagedQty > receivedQty) {
      throw new Error(
        `Sản phẩm ${target.itemName}: hàng tốt + hàng hỏng không được vượt số lượng nhận.`,
      );
    }

    target.receivedQty = receivedQty;
    target.goodQty = goodQty;
    target.damagedQty = damagedQty;
  }

  returnDoc.warehouseStatus = "inspected";
  returnDoc.inspectedAt = new Date();
  returnDoc.inspectedBy = userId || null;

  if (note) {
    returnDoc.rawData = {
      ...(returnDoc.rawData || {}),
      warehouseInspectionNote: String(note),
    };
  }

  await returnDoc.save();

  return returnDoc;
}

// =====================================================
// RESOLVE RETURN STOCK
// =====================================================

/**
 * RESTOCK:
 * - Chỉ cộng hàng tốt đã kiểm tra.
 * - Không cộng hàng hỏng.
 *
 * NO_RESTOCK:
 * - Không cộng tồn kho.
 * - Đóng phiếu xử lý.
 *
 * Tồn kho và lịch sử được ghi trong cùng transaction.
 */

async function resolveShopeeReturnStock({
  shopId,
  returnSn,
  resolution,
  userId,
  note = "",
} = {}) {
  if (!["RESTOCK", "NO_RESTOCK"].includes(resolution)) {
    throw new Error("resolution phải là RESTOCK hoặc NO_RESTOCK.");
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const returnDoc = await ShopeeReturn.findOne({
        shopId: String(shopId),
        returnSn: String(returnSn),
      }).session(session);

      if (!returnDoc) {
        throw new Error("Không tìm thấy yêu cầu trả hàng.");
      }

      if (returnDoc.warehouseStatus !== "inspected") {
        throw new Error("Bạn cần nhận và kiểm hàng trước khi xử lý kho.");
      }

      const existingLog = await ShopeeReturnStockLog.findOne({
        shopId: String(shopId),
        returnSn: String(returnSn),
      }).session(session);

      if (existingLog) {
        throw new Error("Yêu cầu hoàn này đã được xử lý kho trước đó.");
      }

      const logItems = [];
      let totalRestockedQty = 0;
      let totalDamagedQty = 0;

      for (const item of returnDoc.items) {
        const goodQty = Number(item.goodQty || 0);
        const damagedQty = Number(item.damagedQty || 0);

        totalDamagedQty += damagedQty;

        let beforeQty = 0;
        let afterQty = 0;
        let restockedQty = 0;

        if (resolution === "RESTOCK" && goodQty > 0) {
          if (!item.productId || !item.variantCode) {
            throw new Error(
              `Sản phẩm "${item.itemName}" chưa được mapping SKU. Không thể nhập kho.`,
            );
          }

          const product = await Product.findById(item.productId).session(
            session,
          );

          if (!product) {
            throw new Error(
              `Không tìm thấy sản phẩm nội bộ cho "${item.itemName}".`,
            );
          }

          const variant = product.variants.find(
            (value) => String(value.variantCode) === String(item.variantCode),
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại ${item.variantCode} của sản phẩm ${product.title}.`,
            );
          }

          beforeQty = Number(variant.qty || 0);
          afterQty = beforeQty + goodQty;
          restockedQty = goodQty;

          variant.qty = afterQty;

          // Đồng bộ tổng tồn kho sản phẩm từ các phân loại.
          product.qty = product.variants.reduce(
            (sum, value) => sum + Number(value.qty || 0),
            0,
          );

          await product.save({ session });

          item.restockedQty = restockedQty;
          totalRestockedQty += restockedQty;
        }

        logItems.push({
          productId: item.productId || null,
          variantCode: item.variantCode || "",
          variantName: item.variantName || "",

          itemId: item.itemId || "",
          modelId: item.modelId || "0",

          itemSku: item.itemSku || "",
          variationSku: item.variationSku || "",

          goodQty,
          damagedQty,

          beforeQty,
          afterQty,
          restockedQty,

          message:
            resolution === "RESTOCK"
              ? "Đã xử lý theo kết quả kiểm hàng."
              : "Không nhập lại tồn kho.",
        });
      }

      const log = new ShopeeReturnStockLog({
        shopId: String(shopId),
        returnSn: String(returnSn),
        orderSn: returnDoc.orderSn || "",
        returnId: returnDoc._id,

        resolution,

        items: logItems,

        totalRestockedQty,
        totalDamagedQty,

        processedBy: userId || null,
        processedAt: new Date(),

        note,

        status: "SUCCESS",
      });

      await log.save({ session });

      returnDoc.restockedStockQty = totalRestockedQty;

      returnDoc.warehouseStatus =
        resolution === "RESTOCK"
          ? totalRestockedQty > 0
            ? "restocked"
            : "closed"
          : "closed";

      returnDoc.rawData = {
        ...(returnDoc.rawData || {}),
        warehouseResolution: resolution,
        warehouseResolutionNote: String(note || ""),
      };

      await returnDoc.save({ session });

      result = {
        success: true,
        returnSn: String(returnSn),
        resolution,
        totalRestockedQty,
        totalDamagedQty,
        warehouseStatus: returnDoc.warehouseStatus,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getShopeeReturnDetail,
  getShopeeReturnListPage,

  syncShopeeReturns,
  saveShopeeReturn,

  getShopeeReturns,
  getShopeeReturnBySn,

  receiveShopeeReturn,
  inspectShopeeReturn,
  resolveShopeeReturnStock,
};
