const mongoose = require("mongoose");
const crypto = require("crypto");

const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");
const InventoryBatch = require("../models/InventoryBatch");
const InventoryHistory = require("../models/inventoryHistory");
const { Product } = require("../models/products");
const { getShopeeOrders, callShopeeShopApi } = require("./shopeeService");

// =====================================================
// CONFIG
// =====================================================

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const LOOKBACK_DAYS = 30;
const WINDOW_DAYS = 15;

const CUSTOMER_RETURN = "CUSTOMER_RETURN";
const DELIVERY_FAILED = "DELIVERY_FAILED";

const text = (value) =>
  value === null || value === undefined ? "" : String(value).trim();

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const validQty = (value) =>
  Number.isInteger(Number(value)) && Number(value) >= 0;

const toDate = (unix) => {
  const value = Number(unix);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
};

const getUserId = (user) => {
  const id = user?._id || user?.id || null;

  return id && mongoose.isValidObjectId(id) ? id : null;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getResponse = (data) => data?.response || data || {};

// =====================================================
// SHOPEE API HELPERS
// =====================================================

/**
 * Lấy danh sách mã phiếu trả hàng.
 *
 * Shopee:
 * GET /api/v2/returns/get_return_list
 *
 * page_no bắt đầu từ 0 và tăng từng trang.
 */
async function getShopeeReturnList({ shopId, timeFrom, timeTo, pageNo = 0 }) {
  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/returns/get_return_list",
    method: "GET",
    params: {
      page_no: pageNo,
      page_size: PAGE_SIZE,
      update_time_from: timeFrom,
      update_time_to: timeTo,
    },
  });

  const response = getResponse(data);

  return {
    rows: response.return || response.returns || response.return_list || [],
    more: Boolean(response.more),
  };
}

/**
 * Lấy chi tiết một phiếu trả hàng.
 */
async function getShopeeReturnDetailFromApi(shopId, returnSn) {
  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/returns/get_return_detail",
    method: "GET",
    params: {
      return_sn: returnSn,
    },
  });

  const response = getResponse(data);

  return response.return || response;
}

/**
 * Lấy chi tiết các package.
 * Shopee giới hạn 50 package mỗi lần gọi.
 */
async function getShopeePackageDetails(shopId, packageNumbers = []) {
  const uniqueNumbers = [...new Set(packageNumbers.map(text).filter(Boolean))];

  const result = [];

  for (let i = 0; i < uniqueNumbers.length; i += 50) {
    const chunk = uniqueNumbers.slice(i, i + 50);

    const data = await callShopeeShopApi({
      shopId,
      path: "/api/v2/order/get_package_detail",
      method: "GET",
      params: {
        package_number_list: chunk.join(","),
      },
    });

    const response = getResponse(data);

    result.push(...(response.package_list || []));
  }

  return result;
}

// =====================================================
// SKU MAPPING
// =====================================================

/**
 * Chuyển item Shopee thành item kho nội bộ.
 *
 * Shopee item/model:
 * item_id + model_id
 *
 * Internal:
 * productId + variantCode
 */
async function mapShopeeItems(shopId, rawItems = []) {
  const result = [];

  for (const raw of rawItems) {
    const itemId = text(raw.item_id ?? raw.itemId);

    const modelId = text(raw.model_id ?? raw.modelId ?? "0") || "0";

    const mapping = itemId
      ? await ShopeeSkuMapping.findOne({
          shopId: String(shopId),
          itemId,
          modelId,
          isActive: true,
        }).lean()
      : null;

    const multiplier = Math.max(1, number(mapping?.quantityMultiplier, 1));

    const shopeeQty = Math.max(
      0,
      number(raw.amount ?? raw.model_quantity ?? raw.quantity ?? raw.qty),
    );

    const mapped = Boolean(mapping?.productId && mapping?.variantCode);

    result.push({
      itemId,
      modelId,

      itemName: text(raw.name ?? raw.item_name ?? raw.itemName),

      modelName: text(raw.model_name ?? raw.modelName),

      itemSku: text(raw.item_sku ?? raw.itemSku),

      variationSku: text(
        raw.variation_sku ?? raw.model_sku ?? raw.variationSku,
      ),

      image: text(raw.image ?? raw.image_url),

      requestedQty: Math.ceil(shopeeQty * multiplier),

      quantityMultiplier: multiplier,

      productId: mapping?.productId || null,

      variantCode: text(mapping?.variantCode),

      variantName: text(mapping?.variantName),

      mappingStatus: mapped ? "mapped" : "unmapped",

      isMapped: mapped,

      receivedQty: 0,
      goodQty: 0,
      damagedQty: 0,
      restockedQty: 0,
    });
  }

  return result;
}

/**
 * Giữ lại kết quả kiểm kho cũ khi đồng bộ lại Shopee.
 *
 * Không được để cron sync ghi đè số lượng đã kiểm tra.
 */
function preserveInspectedItems(oldItems = [], newItems = []) {
  return newItems.map((item) => {
    const old = oldItems.find(
      (row) =>
        text(row.itemId) === text(item.itemId) &&
        text(row.modelId || "0") === text(item.modelId || "0"),
    );

    if (!old) return item;

    return {
      ...item,

      receivedQty: number(old.receivedQty),
      goodQty: number(old.goodQty),
      damagedQty: number(old.damagedQty),
      restockedQty: number(old.restockedQty),

      inspectionNote: text(old.inspectionNote),

      stockProcessed: Boolean(old.stockProcessed),
      stockProcessedAt: old.stockProcessedAt || null,
    };
  });
}

// =====================================================
// PRESERVE INTERNAL WORKFLOW
// =====================================================

function preserveWorkflow(update, existing) {
  if (!existing) {
    update.warehouseStatus = "in_transit";
    update.status = "RETURN_SHIPPING";
    return;
  }

  const fields = [
    "warehouseStatus",
    "status",

    "isReceived",
    "receivedAt",
    "receivedBy",

    "isInspected",
    "inspectedAt",
    "inspectedBy",

    "resolution",
    "resolutionNote",
    "resolutionAt",
    "resolutionBy",

    "resolvedAt",
    "resolvedBy",

    "stockProcessed",
    "stockProcessedAt",

    "restockedStockQty",

    "totalReceivedQty",
    "totalGoodQty",
    "totalDamagedQty",
  ];

  for (const field of fields) {
    if (existing[field] !== undefined) {
      update[field] = existing[field];
    }
  }
}

// =====================================================
// CUSTOMER RETURN
// =====================================================

async function saveCustomerReturn(shopId, raw) {
  const returnSn = text(raw.return_sn ?? raw.returnSn);

  const orderSn = text(raw.order_sn ?? raw.orderSn);

  if (!returnSn || !orderSn) {
    throw new Error("Phiếu trả hàng thiếu return_sn hoặc order_sn.");
  }

  const existing = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn,
  });

  const rawItems = Array.isArray(raw.item)
    ? raw.item
    : Array.isArray(raw.items)
      ? raw.items
      : [];

  const mappedItems = await mapShopeeItems(shopId, rawItems);

  const items = preserveInspectedItems(existing?.items || [], mappedItems);

  const requestedQty = items.reduce(
    (sum, item) => sum + number(item.requestedQty),
    0,
  );

  const update = {
    shopId: String(shopId),

    returnSn,
    orderSn,

    returnType: CUSTOMER_RETURN,
    sourceType: CUSTOMER_RETURN,

    buyerUsername: text(raw.buyer_username ?? raw.buyerUsername),

    reason: text(raw.reason),
    textReason: text(raw.text_reason ?? raw.textReason),

    returnReason: text(raw.reason),
    returnDescription: text(raw.text_reason ?? raw.textReason),

    refundAmount: number(raw.refund_amount ?? raw.refundAmount),

    currency: text(raw.currency) || "VND",

    shopeeReturnStatus: text(raw.status ?? raw.return_status),

    shopeeStatus: text(raw.status ?? raw.return_status),

    needsLogistics: Boolean(raw.needs_logistics ?? raw.needsLogistics),

    trackingNumber: text(raw.tracking_number ?? raw.trackingNumber),

    validationType: text(raw.validation_type),

    requestType: raw.return_refund_request_type ?? raw.request_type ?? null,

    createTime: toDate(raw.create_time) || raw.createTime || null,

    updateTime: toDate(raw.update_time) || raw.updateTime || new Date(),

    returnShipDueDate: toDate(raw.return_ship_due_date),

    returnSellerDueDate: toDate(raw.return_seller_due_date),

    requestedShopeeQty: requestedQty,
    totalRequestedQty: requestedQty,

    items,

    rawShopeeData: raw,
    rawData: raw,

    syncedAt: new Date(),
    lastSyncedAt: new Date(),

    lastSyncError: "",
  };

  preserveWorkflow(update, existing);

  return ShopeeReturn.findOneAndUpdate(
    {
      shopId: String(shopId),
      returnSn,
    },
    {
      $set: update,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  );
}

/**
 * Đồng bộ khách trả hàng.
 *
 * Chia thời gian thành từng cửa sổ tối đa 15 ngày.
 */
async function syncCustomerReturns(shopId, now) {
  const from = now - LOOKBACK_DAYS * 86400;

  let fetched = 0;
  let saved = 0;
  let failed = 0;

  const errors = [];

  for (
    let windowStart = from;
    windowStart < now;
    windowStart += WINDOW_DAYS * 86400
  ) {
    const windowEnd = Math.min(windowStart + WINDOW_DAYS * 86400, now);

    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo += 1) {
      const page = await getShopeeReturnList({
        shopId,
        timeFrom: windowStart,
        timeTo: windowEnd,
        pageNo,
      });

      const rows = Array.isArray(page.rows) ? page.rows : [];

      fetched += rows.length;

      for (const row of rows) {
        const returnSn = text(row.return_sn);

        try {
          // Chi tiết riêng để lấy đầy đủ item/model.
          const detail = await getShopeeReturnDetailFromApi(shopId, returnSn);

          await saveCustomerReturn(shopId, detail);

          saved += 1;
        } catch (error) {
          failed += 1;

          errors.push({
            type: CUSTOMER_RETURN,
            returnSn,
            message: error.message,
          });

          // Lưu thông tin danh sách nếu API detail lỗi.
          try {
            const fallback = await saveCustomerReturn(shopId, row);

            if (fallback) {
              fallback.lastSyncError = error.message;
              await fallback.save();
            }
          } catch (saveError) {
            errors.push({
              type: CUSTOMER_RETURN,
              returnSn,
              message: "Lỗi lưu dữ liệu dự phòng: " + saveError.message,
            });
          }
        }
      }

      if (!page.more || rows.length === 0) {
        break;
      }
    }
  }

  return {
    fetched,
    saved,
    failed,
    errors,
  };
}

// =====================================================
// DELIVERY FAILED
// =====================================================

/**
 * Lấy package_number từ đơn hàng.
 */
function getPackageNumbers(order) {
  const packages = Array.isArray(order.package_list) ? order.package_list : [];

  return packages
    .map((item) => text(item.package_number ?? item.packageNumber))
    .filter(Boolean);
}

/**
 * Tạo phiếu giao thất bại.
 *
 * Một order có thể có nhiều package.
 * Mỗi package có một phiếu riêng.
 */
async function saveFailedPackage(shopId, pkg) {
  const packageNumber = text(pkg.package_number ?? pkg.packageNumber);

  const orderSn = text(pkg.order_sn ?? pkg.orderSn);

  if (!packageNumber || !orderSn) {
    throw new Error("Package thiếu package_number hoặc order_sn.");
  }

  const returnSn = "DELIVERY-" + packageNumber;

  const existing = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn,
  });

  const rawItems = Array.isArray(pkg.item_list)
    ? pkg.item_list
    : Array.isArray(pkg.items)
      ? pkg.items
      : [];

  const mappedItems = await mapShopeeItems(
    shopId,
    rawItems.map((item) => ({
      ...item,
      amount: item.model_quantity ?? item.quantity ?? 0,
      name: item.item_name ?? item.name ?? "",
    })),
  );

  const items = preserveInspectedItems(existing?.items || [], mappedItems);

  const requestedQty = items.reduce(
    (sum, item) => sum + number(item.requestedQty),
    0,
  );

  const update = {
    shopId: String(shopId),

    returnSn,
    orderSn,

    returnType: DELIVERY_FAILED,
    sourceType: DELIVERY_FAILED,

    packageNumber,

    shopeeReturnStatus: text(pkg.fulfillment_status),

    shopeeStatus: text(pkg.fulfillment_status),

    trackingNumber: text(pkg.tracking_number),

    requestedShopeeQty: requestedQty,
    totalRequestedQty: requestedQty,

    updateTime: toDate(pkg.update_time) || new Date(),

    items,

    reason: "DELIVERY_FAILED",

    returnReason: "DELIVERY_FAILED",

    textReason: "Giao hàng không thành công. Kiện hàng đang quay về shop.",

    returnDescription:
      "Giao hàng không thành công. Kiện hàng đang quay về shop.",

    rawShopeeData: pkg,
    rawData: pkg,

    syncedAt: new Date(),
    lastSyncedAt: new Date(),

    lastSyncError: "",
  };

  preserveWorkflow(update, existing);

  return ShopeeReturn.findOneAndUpdate(
    {
      shopId: String(shopId),
      returnSn,
    },
    {
      $set: update,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  );
}

/**
 * Đồng bộ các kiện giao thất bại.
 *
 * Không lấy order_status = CANCELLED để suy ra giao thất bại.
 * Chỉ dùng fulfillment_status của package.
 */
async function syncDeliveryFailedPackages(shopId, now) {
  const from = now - LOOKBACK_DAYS * 86400;

  let fetchedOrders = 0;
  let fetchedPackages = 0;
  let saved = 0;
  let failed = 0;

  const errors = [];

  for (
    let windowStart = from;
    windowStart < now;
    windowStart += WINDOW_DAYS * 86400
  ) {
    const windowEnd = Math.min(windowStart + WINDOW_DAYS * 86400, now);

    let cursor = "";

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await getShopeeOrders({
        shopId,
        timeFrom: windowStart,
        timeTo: windowEnd,
        pageSize: PAGE_SIZE,
        cursor,
        timeRangeField: "update_time",
      });

      const orders = Array.isArray(result.orderList) ? result.orderList : [];

      fetchedOrders += orders.length;

      const packageNumbers = [...new Set(orders.flatMap(getPackageNumbers))];

      if (packageNumbers.length > 0) {
        const packages = await getShopeePackageDetails(shopId, packageNumbers);

        fetchedPackages += packages.length;

        for (const pkg of packages) {
          const fulfillmentStatus = text(pkg.fulfillment_status).toUpperCase();

          if (fulfillmentStatus !== "LOGISTICS_DELIVERY_FAILED") {
            continue;
          }

          try {
            await saveFailedPackage(shopId, pkg);
            saved += 1;
          } catch (error) {
            failed += 1;

            errors.push({
              type: DELIVERY_FAILED,
              packageNumber: text(pkg.package_number),
              orderSn: text(pkg.order_sn),
              message: error.message,
            });
          }
        }
      }

      if (!result.more || !result.nextCursor) {
        break;
      }

      cursor = result.nextCursor;
    }
  }

  return {
    fetchedOrders,
    fetchedPackages,
    saved,
    failed,
    errors,
  };
}

// =====================================================
// SYNC ALL
// =====================================================

async function syncShopeeReturns(shopId) {
  const id = text(shopId);

  if (!id) {
    throw new Error("Thiếu shopId.");
  }

  const now = Math.floor(Date.now() / 1000);

  const customerReturns = await syncCustomerReturns(id, now);

  const deliveryFailed = await syncDeliveryFailedPackages(id, now);

  return {
    shopId: id,

    customerReturns,
    deliveryFailed,

    totalFetched: customerReturns.fetched + deliveryFailed.fetchedPackages,

    totalSaved: customerReturns.saved + deliveryFailed.saved,

    totalFailed: customerReturns.failed + deliveryFailed.failed,

    errors: [...customerReturns.errors, ...deliveryFailed.errors],

    syncedAt: new Date(),
  };
}

// =====================================================
// LIST
// =====================================================

async function getShopeeReturns({
  shopId,
  page = 1,
  limit = 20,
  keyword = "",
  warehouseStatus = "",
  returnType = "all",
}) {
  const filter = {
    shopId: String(shopId),
  };

  if (warehouseStatus && warehouseStatus !== "all") {
    filter.warehouseStatus = warehouseStatus;
  }

  if (returnType && returnType !== "all") {
    filter.returnType = returnType;
  }

  const search = text(keyword);

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");

    filter.$or = [
      { returnSn: regex },
      { orderSn: regex },
      { trackingNumber: regex },
      { packageNumber: regex },
      { buyerUsername: regex },
      { textReason: regex },
    ];
  }

  const currentPage = Math.max(1, Number(page) || 1);

  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));

  const [returns, total] = await Promise.all([
    ShopeeReturn.find(filter)
      .sort({
        updateTime: -1,
        updatedAt: -1,
        _id: -1,
      })
      .skip((currentPage - 1) * pageLimit)
      .limit(pageLimit)
      .lean(),

    ShopeeReturn.countDocuments(filter),
  ]);

  return {
    returns,
    total,

    pagination: {
      page: currentPage,
      limit: pageLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageLimit)),
    },
  };
}

// =====================================================
// DETAIL
// =====================================================

async function getShopeeReturnDetail({ shopId, returnSn }) {
  const doc = await ShopeeReturn.findOne({
    shopId: String(shopId),
    returnSn: text(returnSn),
  });

  if (!doc) {
    throw new Error("Không tìm thấy phiếu hàng hoàn.");
  }

  // Chỉ lấy live detail cho yêu cầu khách trả hàng.
  if (doc.returnType === CUSTOMER_RETURN) {
    try {
      const detail = await getShopeeReturnDetailFromApi(shopId, doc.returnSn);

      if (detail?.return_sn || detail?.returnSn) {
        await saveCustomerReturn(shopId, detail);

        const refreshed = await ShopeeReturn.findOne({
          shopId: String(shopId),
          returnSn: doc.returnSn,
        });

        if (
          refreshed &&
          (refreshed.isReceived ||
            ["received", "inspected", "restocked", "closed", "partially_restocked"].includes(refreshed.warehouseStatus))
        ) {
          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              await ensureShopeeReturnReceiptHistory({
                doc: refreshed,
                user: { _id: refreshed.receivedBy },
                session,
              });
            });
          } finally {
            await session.endSession();
          }
        }

        return refreshed;
      }
    } catch (error) {
      console.warn(
        "[Shopee Return] Không lấy được live detail:",
        error.message,
      );
    }
  }

  // Tự bổ sung nhật ký cho các phiếu đã nhận từ phiên bản cũ
  // khi người dùng mở chi tiết; thao tác này không thay đổi tồn kho.
  if (doc.isReceived || ["received", "inspected", "restocked", "closed", "partially_restocked"].includes(doc.warehouseStatus)) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await ensureShopeeReturnReceiptHistory({
          doc,
          user: { _id: doc.receivedBy },
          session,
        });
      });
    } finally {
      await session.endSession();
    }
  }

  return doc;
}

// =====================================================
// RECEIVE HISTORY
// =====================================================

// Ghi nhật ký tiếp nhận vào InventoryHistory nhưng không làm biến động tồn.
async function ensureShopeeReturnReceiptHistory({ doc, user, session }) {
  for (const item of doc.items || []) {
    if (!item.productId || !text(item.variantCode)) continue;

    const exists = await InventoryHistory.findOne({
      type: "adjustment",
      referenceType: "shopee_return_received",
      referenceCode: doc.returnSn,
      productId: item.productId,
      variantCode: text(item.variantCode),
    }).session(session);

    if (exists) continue;

    const product = await Product.findById(item.productId).session(session);
    if (!product) continue;

    const variant = (product.variants || []).find(
      (row) => text(row.variantCode) === text(item.variantCode),
    );
    if (!variant) continue;

    const currentQty = number(variant.qty);

    await new InventoryHistory({
      type: "adjustment",
      referenceType: "shopee_return_received",
      referenceId: doc._id,
      referenceCode: doc.returnSn,
      productId: product._id,
      productTitle: product.title || "",
      productCode: product.code || "",
      variantName: variant.name || item.variantName || "",
      variantCode: text(item.variantCode),
      qty: 0,
      beforeQty: currentQty,
      afterQty: currentQty,
      note:
        `Tiếp nhận hàng hoàn Shopee - đơn ${doc.orderSn}, kiện ${doc.packageNumber || doc.returnSn}. Đã nhận ${number(item.requestedQty)}; chưa kiểm hàng và chưa nhập kho.`,
      createdBy: getUserId(user) || doc.receivedBy || null,
      created_at: doc.receivedAt || new Date(),
    }).save({ session });
  }
}

// =====================================================
// RECEIVE
// =====================================================

async function receiveShopeeReturn({ shopId, returnSn, note = "", user }) {
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const doc = await ShopeeReturn.findOne({
        shopId: String(shopId),
        returnSn: text(returnSn),
      }).session(session);

      if (!doc) {
        throw new Error("Không tìm thấy phiếu hàng hoàn.");
      }

      if (doc.resolution) {
        throw new Error("Phiếu này đã được xử lý kho.");
      }

      if (doc.warehouseStatus === "inspected") {
        throw new Error("Phiếu đã được kiểm tra.");
      }

      if (!["waiting", "in_transit", "received"].includes(doc.warehouseStatus)) {
        throw new Error("Trạng thái hiện tại không thể xác nhận nhận hàng.");
      }

      if (doc.warehouseStatus !== "received") {
        doc.warehouseStatus = "received";
        doc.status = "RECEIVED";
        doc.isReceived = true;
        doc.receivedAt = new Date();
        doc.receivedBy = getUserId(user);
      }

      if (text(note)) doc.note = text(note);

      await ensureShopeeReturnReceiptHistory({ doc, user, session });

      // Chỉ xác nhận nhận hàng và ghi nhật ký.
      // Tuyệt đối không thay đổi Product.qty tại đây.
      await doc.save({ session });
      result = doc;
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// =====================================================
// INSPECT
// =====================================================

async function inspectShopeeReturn({
  shopId,
  returnSn,
  items = [],
  note = "",
  user,
}) {
  const session = await mongoose.startSession();

  let result;

  try {
    await session.withTransaction(async () => {
      const doc = await ShopeeReturn.findOne({
        shopId: String(shopId),
        returnSn: text(returnSn),
      }).session(session);

      if (!doc) {
        throw new Error("Không tìm thấy phiếu hàng hoàn.");
      }

      if (doc.warehouseStatus !== "received") {
        throw new Error("Chỉ được kiểm tra sau khi xác nhận đã nhận hàng.");
      }

      if (!Array.isArray(items) || items.length !== doc.items.length) {
        throw new Error("Danh sách kiểm tra không khớp danh sách sản phẩm.");
      }

      for (const input of items) {
        const item = doc.items.find(
          (row) =>
            text(row.itemId) === text(input.itemId) &&
            text(row.modelId || "0") === text(input.modelId || "0"),
        );

        if (!item) {
          throw new Error("Không tìm thấy dòng sản phẩm cần kiểm tra.");
        }

        const receivedQty = number(input.receivedQty, -1);

        const goodQty = number(input.goodQty, -1);

        const damagedQty = number(input.damagedQty, -1);

        if (
          !validQty(receivedQty) ||
          !validQty(goodQty) ||
          !validQty(damagedQty)
        ) {
          throw new Error("Số lượng kiểm tra phải là số nguyên không âm.");
        }

        if (goodQty + damagedQty !== receivedQty) {
          throw new Error(
            "Phải phân loại đủ toàn bộ số lượng thực nhận thành hàng tốt hoặc hàng hỏng.",
          );
        }

        if (receivedQty > number(item.requestedQty)) {
          throw new Error(
            "Số lượng thực nhận không được vượt số lượng dự kiến.",
          );
        }

        item.receivedQty = receivedQty;
        item.goodQty = goodQty;
        item.damagedQty = damagedQty;

        item.inspectionNote = text(input.inspectionNote);
      }

      const totalReceived = doc.items.reduce(
        (sum, item) => sum + number(item.receivedQty),
        0,
      );

      const totalGood = doc.items.reduce(
        (sum, item) => sum + number(item.goodQty),
        0,
      );

      const totalDamaged = doc.items.reduce(
        (sum, item) => sum + number(item.damagedQty),
        0,
      );

      doc.totalReceivedQty = totalReceived;
      doc.totalGoodQty = totalGood;
      doc.totalDamagedQty = totalDamaged;

      doc.warehouseStatus = "inspected";

      doc.status = "INSPECTED";

      doc.isReceived = true;
      doc.isInspected = true;

      doc.inspectedAt = new Date();
      doc.inspectedBy = getUserId(user);

      doc.resolutionNote = text(note);

      await doc.save({ session });

      result = doc;
    });

    return result;
  } finally {
    await session.endSession();
  }
}

// =====================================================
// BATCH CODE
// =====================================================

function createReturnBatchCode(returnSn, index) {
  const hash = crypto
    .createHash("sha1")
    .update(String(returnSn))
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();

  const suffix = String(index + 1).padStart(2, "0");

  return `RET-${hash}-${suffix}`;
}

// =====================================================
// RESOLVE / RESTOCK
// =====================================================

async function resolveShopeeReturn({
  shopId,
  returnSn,
  resolution,
  note = "",
  user,
}) {
  const choice = text(resolution).toUpperCase();

  if (!["RESTOCK", "NO_RESTOCK"].includes(choice)) {
    throw new Error("Phương án xử lý phải là RESTOCK hoặc NO_RESTOCK.");
  }

  const session = await mongoose.startSession();

  let result;

  try {
    await session.withTransaction(async () => {
      const doc = await ShopeeReturn.findOne({
        shopId: String(shopId),
        returnSn: text(returnSn),
      }).session(session);

      if (!doc) {
        throw new Error("Không tìm thấy phiếu hàng hoàn.");
      }

      const canRetryZeroRestock =
        doc.resolution === "RESTOCK" &&
        number(doc.restockedStockQty) <= 0 &&
        doc.warehouseStatus === "closed" &&
        (doc.items || []).some((item) => number(item.goodQty) > 0);

      if (doc.warehouseStatus !== "inspected" && !canRetryZeroRestock) {
        throw new Error(
          "Phiếu phải được tiếp nhận và kiểm tra trước khi xử lý.",
        );
      }

      if ((doc.resolution || doc.stockProcessed) && !canRetryZeroRestock) {
        throw new Error("Phiếu hàng hoàn đã được xử lý trước đó.");
      }

      // Chỉ mở lại phiếu cũ khi lần xử lý trước ghi nhận 0 hàng nhập,
      // không có lô RETURN hoặc lịch sử nhập thực tế. Tránh nhập trùng.
      if (canRetryZeroRestock) {
        const existingReturnHistory = await InventoryHistory.findOne({
          referenceType: "shopee_return",
          referenceCode: doc.returnSn,
          type: "import",
          qty: { $gt: 0 },
        }).session(session);

        const existingReturnBatch = await InventoryBatch.findOne({
          source: "RETURN",
          note: { $regex: escapeRegex(doc.returnSn) },
          importQty: { $gt: 0 },
        }).session(session);

        if (existingReturnHistory || existingReturnBatch) {
          throw new Error(
            "Phiếu đã có lô hoặc lịch sử nhập kho. Hệ thống chặn xử lý lại để tránh cộng tồn kho trùng.",
          );
        }
      }

      const idempotencyKey = [
        "SHOPEE",
        "RETURN",
        shopId,
        doc.returnSn,
        "RESOLVE",
      ].join(":");

      const duplicate = await ShopeeStockTransaction.findOne({
        idempotencyKey,
      }).session(session);

      if (duplicate) {
        if (
          canRetryZeroRestock &&
          number(duplicate.totalQty) <= 0 &&
          duplicate.kind === "return_import"
        ) {
          await ShopeeStockTransaction.deleteOne({
            _id: duplicate._id,
          }).session(session);
        } else {
          throw new Error("Giao dịch kho của phiếu này đã tồn tại.");
        }
      }

      const allocations = [];

      let totalRestockedQty = 0;

      // Limit returned quantities to units actually deducted from the order.
      // For failed delivery orders that were only reserved, release the
      // reservation instead of adding the still-existing stock a second time.
      const restockLimitByItem = new Map();
      const orderDoc = await ShopeeOrder.findOne({
        shopId: String(shopId),
        orderSn: doc.orderSn,
      }).session(session);

      // Đối chiếu giao dịch xuất FIFO làm nguồn dữ liệu dự phòng.
      // Một số đơn cũ đã xuất kho nhưng item.deductedQty chưa được lưu
      // hoặc bị thiếu do phiên bản đồng bộ trước đây.
      const exportTransaction = await ShopeeStockTransaction.findOne({
        shopId: String(shopId),
        orderSn: String(doc.orderSn),
        kind: "order_export",
        status: "completed",
      })
        .sort({ createdAt: -1 })
        .session(session);

      const legacyExportTransaction = exportTransaction
        ? null
        : await ShopeeStockTransaction.findOne({
            idempotencyKey: `SHOPEE:ORDER:${shopId}:${doc.orderSn}:SHIP`,
            status: "completed",
          }).session(session);

      const exportAllocations =
        exportTransaction?.allocations ||
        legacyExportTransaction?.allocations ||
        [];

      const exportedQtyByVariant = new Map();
      for (const allocation of exportAllocations) {
        const key = `${String(allocation.productId)}_${text(allocation.variantCode)}`;
        exportedQtyByVariant.set(
          key,
          number(exportedQtyByVariant.get(key)) + Math.max(0, number(allocation.qty)),
        );
      }

      // Trừ trước phần deductedQty đã lưu để không phân bổ trùng khi
      // một đơn có nhiều dòng cùng ánh xạ về một biến thể kho.
      if (orderDoc) {
        for (const orderItem of orderDoc.items || []) {
          const productId = orderItem.productId;
          const variantCode = text(orderItem.variantCode);
          const storedDeducted = Math.max(0, number(orderItem.deductedQty));
          if (!productId || !variantCode || storedDeducted <= 0) continue;
          const key = `${String(productId)}_${variantCode}`;
          exportedQtyByVariant.set(
            key,
            Math.max(0, number(exportedQtyByVariant.get(key)) - storedDeducted),
          );
        }
      }

      // Failed-delivery packages must reconcile the original order so that
      // held quantities can be released even when the user chooses NO_RESTOCK.
      if (
        !orderDoc &&
        (choice === "RESTOCK" || doc.returnType === DELIVERY_FAILED)
      ) {
        throw new Error(
          "Không tìm thấy đơn Shopee gốc để đối chiếu tồn kho. Vui lòng đồng bộ đơn hàng trước khi xử lý phiếu hoàn.",
        );
      }

      if (orderDoc) {
        for (const returnItem of doc.items) {
          const orderItem = (orderDoc.items || []).find(
            (row) =>
              text(row.itemId) === text(returnItem.itemId) &&
              text(row.modelId || "0") === text(returnItem.modelId || "0"),
          );

          if (!orderItem) {
            if (choice === "RESTOCK" || doc.returnType === DELIVERY_FAILED) {
              throw new Error(
                "Không đối chiếu được sản phẩm hoàn với dòng hàng trong đơn Shopee. Vui lòng kiểm tra SKU mapping trước khi xử lý.",
              );
            }
            restockLimitByItem.set(String(returnItem._id), 0);
            continue;
          }

          const receivedQty = Math.max(0, number(returnItem.receivedQty));
          let deductedQty = Math.max(0, number(orderItem.deductedQty));

          // Dữ liệu cũ có thể thiếu deductedQty dù đơn đã xuất kho.
          // Chỉ khôi phục từ giao dịch xuất FIFO có thật, không suy đoán
          // từ trạng thái COMPLETED hoặc số lượng đặt mua.
          if (deductedQty <= 0 && exportAllocations.length > 0) {
            let productId = orderItem.productId;
            let variantCode = text(orderItem.variantCode);

            if (!productId || !variantCode) {
              const mapping = await ShopeeSkuMapping.findOne({
                shopId: String(shopId),
                itemId: text(returnItem.itemId),
                modelId: text(returnItem.modelId || "0"),
                isActive: true,
              }).session(session);

              if (mapping?.productId && text(mapping.variantCode)) {
                productId = mapping.productId;
                variantCode = text(mapping.variantCode);
                orderItem.productId = productId;
                orderItem.variantCode = variantCode;
                orderItem.variantName =
                  text(mapping.variantName) || orderItem.variantName;
              }
            }

            if (productId && variantCode) {
              const exportKey = `${String(productId)}_${variantCode}`;
              const exportedQty = number(exportedQtyByVariant.get(exportKey));
              const multiplier = Math.max(
                0.000001,
                number(orderItem.quantityMultiplier, 1),
              );
              const orderedQty = Math.max(
                0,
                number(orderItem.quantity) * multiplier,
              );
              const previouslyReturned = Math.max(
                0,
                number(orderItem.returnedQty),
              );
              deductedQty = Math.min(
                exportedQty + previouslyReturned,
                orderedQty > 0
                  ? orderedQty
                  : exportedQty + previouslyReturned,
              );
              if (deductedQty > 0) {
                orderItem.deductedQty = deductedQty;
                const newlyAllocatedExport = Math.max(
                  0,
                  deductedQty - previouslyReturned,
                );
                exportedQtyByVariant.set(
                  exportKey,
                  Math.max(0, exportedQty - newlyAllocatedExport),
                );
              }
            }
          }

          const deductedRemaining = Math.max(
            0,
            deductedQty - number(orderItem.returnedQty),
          );
          const reservedRemaining = Math.max(0, number(orderItem.reservedQty));

          if (
            doc.returnType === CUSTOMER_RETURN &&
            receivedQty > deductedRemaining
          ) {
            throw new Error(
              "Số lượng khách trả vượt số lượng đơn đã thực sự xuất kho còn có thể hoàn: " + returnItem.itemName,
            );
          }

          if (
            doc.returnType === DELIVERY_FAILED &&
            receivedQty > reservedRemaining + deductedRemaining
          ) {
            throw new Error(
              "Số lượng kiện giao thất bại nhận về vượt tổng số lượng đang giữ và đã xuất còn có thể đối chiếu: " + returnItem.itemName,
            );
          }

          let restockableReceivedQty = receivedQty;

          // For failed delivery, reserved stock is already physically in
          // inventory. Release its reservation first; only the remaining
          // received units can be restored as returned stock.
          if (doc.returnType === DELIVERY_FAILED) {
            const releaseQty = Math.min(
              receivedQty,
              reservedRemaining,
            );

            if (releaseQty > 0) {
              if (!orderItem.productId || !text(orderItem.variantCode)) {
                throw new Error(
                  "Đơn giao thất bại chưa ánh xạ sản phẩm kho, không thể giải phóng hàng đang giữ.",
                );
              }

              const product = await Product.findById(orderItem.productId).session(session);
              if (!product) {
                throw new Error("Không tìm thấy sản phẩm để giải phóng hàng giữ: " + orderItem.itemName);
              }

              const variant = (product.variants || []).find(
                (row) => text(row.variantCode) === text(orderItem.variantCode),
              );
              if (!variant) {
                throw new Error("Không tìm thấy phân loại để giải phóng hàng giữ: " + orderItem.variantName);
              }

              const currentReserved = number(variant.reservedQty);
              if (currentReserved < releaseQty) {
                throw new Error("Số lượng đang giữ không đủ để giải phóng: " + orderItem.variantName);
              }

              variant.reservedQty = currentReserved - releaseQty;
              orderItem.reservedQty = Math.max(0, number(orderItem.reservedQty) - releaseQty);

              // A failed-delivery package was not deducted from physical
              // stock. Damaged units must therefore be written off rather
              // than silently becoming sellable when the reservation clears.
              const damagedReservedQty = Math.min(
                number(returnItem.damagedQty),
                releaseQty,
              );

              if (damagedReservedQty > 0) {
                const batches = await InventoryBatch.find({
                  productId: product._id,
                  variantCode: orderItem.variantCode,
                  remainingQty: { $gt: 0 },
                  isActive: true,
                })
                  .sort({ importDate: 1, _id: 1 })
                  .session(session);

                const batchAvailable = batches.reduce(
                  (sum, batch) => sum + number(batch.remainingQty),
                  0,
                );
                if (batchAvailable < damagedReservedQty) {
                  throw new Error(
                    "Không đủ số lượng lô tồn để ghi giảm hàng hỏng giao thất bại: " + orderItem.variantName,
                  );
                }

                let remainingDamaged = damagedReservedQty;
                for (const batch of batches) {
                  if (remainingDamaged <= 0) break;
                  const beforeBatchQty = number(batch.remainingQty);
                  const deductedBatchQty = Math.min(beforeBatchQty, remainingDamaged);
                  batch.remainingQty = beforeBatchQty - deductedBatchQty;
                  batch.isActive = batch.remainingQty > 0;
                  await batch.save({ session });

                  remainingDamaged -= deductedBatchQty;
                }

                const beforeQty = number(variant.qty);
                variant.qty = Math.max(0, beforeQty - damagedReservedQty);
                product.qty = Math.max(
                  0,
                  number(product.qty) - damagedReservedQty,
                );

                const history = new InventoryHistory({
                  type: "export",
                  referenceType: "shopee_return_damage",
                  referenceId: doc._id,
                  referenceCode: doc.returnSn,
                  productId: product._id,
                  productTitle: product.title || "",
                  productCode: product.code || "",
                  variantName: variant.name || returnItem.variantName || "",
                  variantCode: orderItem.variantCode,
                  qty: -damagedReservedQty,
                  beforeQty,
                  afterQty: number(variant.qty),
                  note: "Ghi giảm hàng hỏng từ kiện Shopee giao thất bại " + doc.returnSn,
                  createdBy: getUserId(user),
                  created_at: new Date(),
                });
                await history.save({ session });
              }

              await product.save({ session });
              restockableReceivedQty = Math.max(0, receivedQty - releaseQty);
            }
          }

          const acceptedReturnQty = Math.min(
            restockableReceivedQty,
            deductedRemaining,
          );
          orderItem.returnedQty = number(orderItem.returnedQty) + acceptedReturnQty;
          restockLimitByItem.set(
            String(returnItem._id),
            Math.min(number(returnItem.goodQty), acceptedReturnQty),
          );
        }

        orderDoc.returnedQty = (orderDoc.items || []).reduce(
          (sum, item) => sum + number(item.returnedQty),
          0,
        );
        orderDoc.returnReceived = doc.items.every(
          (item) => number(item.receivedQty) >= number(item.requestedQty),
        );
        orderDoc.stockReturnedAt = new Date();
        await orderDoc.save({ session });
      }

      // =============================================
      // RESTOCK
      // =============================================

      if (choice === "RESTOCK") {
        for (let index = 0; index < doc.items.length; index += 1) {
          const item = doc.items[index];

          const requestedGoodQty = number(item.goodQty);
          const qty = restockLimitByItem.has(String(item._id))
            ? Math.min(requestedGoodQty, number(restockLimitByItem.get(String(item._id))))
            : requestedGoodQty;

          // Chỉ nhập hàng tốt và không vượt quá số lượng đơn đã xuất kho.
          if (qty <= 0) {
            item.restockedQty = 0;
            continue;
          }

          if (item.mappingStatus !== "mapped" && !item.isMapped) {
            throw new Error(
              `SKU "${item.itemName}" chưa được ánh xạ vào sản phẩm nội bộ.`,
            );
          }

          if (!item.productId || !text(item.variantCode)) {
            throw new Error(
              `Thiếu productId hoặc variantCode của "${item.itemName}".`,
            );
          }

          const product = await Product.findById(item.productId).session(
            session,
          );

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${item.productId}.`);
          }

          const variant = (product.variants || []).find(
            (row) => text(row.variantCode) === text(item.variantCode),
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại ${item.variantCode} trong sản phẩm ${product.title}.`,
            );
          }

          const beforeQty = number(variant.qty);

          const afterQty = beforeQty + qty;

          // Giá vốn CNY của phân loại.
          const unitCost = Math.max(0, number(variant.unitCost));

          const batchCode = createReturnBatchCode(doc.returnSn, index);

          // =========================================
          // 1. TẠO INVENTORY BATCH
          // =========================================

          const batch = new InventoryBatch({
            batchCode,

            productId: product._id,

            productTitle: product.title || "",

            productCode: product.code || "",

            variantName: variant.name || item.variantName || "",

            variantCode: item.variantCode,

            importDate: new Date(),

            importQty: qty,

            remainingQty: qty,

            unitCost,

            importReceiptId: null,

            importHistoryId: null,

            source: "RETURN",

            sourceConfidence: "high",

            note:
              `Hàng hoàn Shopee ${doc.returnSn}` +
              (note ? ` - ${text(note)}` : ""),

            createdBy: getUserId(user),

            isActive: true,
          });

          await batch.save({ session });

          // =========================================
          // 2. CỘNG TỒN KHO
          // =========================================

          variant.qty = afterQty;

          product.qty = number(product.qty) + qty;

          product.updated_at = new Date();

          await product.save({ session });

          // =========================================
          // 3. GHI INVENTORY HISTORY
          // =========================================

          const history = new InventoryHistory({
            type: "import",

            referenceType: "shopee_return",

            referenceId: doc._id,

            referenceCode: doc.returnSn,

            productId: product._id,

            productTitle: product.title || "",

            productCode: product.code || "",

            variantName: variant.name || item.variantName || "",

            variantCode: item.variantCode,

            batchId: batch._id,

            batchCode,

            unitCost,

            qty,

            beforeQty,

            afterQty,

            note: `Nhập hàng hoàn Shopee ${doc.returnSn}`,

            createdBy: getUserId(user),

            created_at: new Date(),
          });

          await history.save({ session });

          // Liên kết ngược lịch sử vào lô.
          batch.importHistoryId = history._id;

          await batch.save({ session });

          item.restockedQty = qty;
          item.stockProcessed = true;
          item.stockProcessedAt = new Date();

          allocations.push({
            productId: product._id,

            variantCode: item.variantCode,

            variantName: variant.name || item.variantName || "",

            batchId: batch._id,

            batchCode,

            qty,

            unitCost,

            beforeQty,

            afterQty,
          });

          totalRestockedQty += qty;
        }
      }

      // Không cho phép đóng phiếu RESTOCK nếu thực tế không có
      // dòng hàng nào được cộng vào kho. Tránh UI báo thành công giả.
      if (choice === "RESTOCK" && totalRestockedQty <= 0) {
        throw new Error(
          "Không có số lượng hàng tốt đủ điều kiện nhập kho. Hãy kiểm tra số lượng đã xuất kho, số lượng thực nhận và SKU mapping; phiếu chưa được đóng.",
        );
      }

      // =============================================
      // NO_RESTOCK
      // =============================================

      if (choice === "NO_RESTOCK") {
        for (const item of doc.items) {
          item.restockedQty = 0;
        }
      }

      // =============================================
      // 4. GHI GIAO DỊCH CHỐNG TRÙNG
      // =============================================

      const transaction = new ShopeeStockTransaction({
        idempotencyKey,

        shopId: String(shopId),

        orderSn: doc.orderSn,

        returnSn: doc.returnSn,

        kind: choice === "RESTOCK" ? "return_import" : "return_adjustment",

        allocations,

        totalQty: totalRestockedQty,

        status: "completed",

        note: choice + (note ? ` - ${text(note)}` : ""),

        createdBy: getUserId(user),
      });

      await transaction.save({ session });

      // =============================================
      // 5. ĐÓNG PHIẾU
      // =============================================

      doc.resolution = choice;

      doc.resolutionNote = text(note);

      doc.resolutionAt = new Date();

      doc.resolutionBy = getUserId(user);

      // Alias mới.
      doc.resolvedAt = new Date();

      doc.resolvedBy = getUserId(user);

      doc.restockedStockQty = totalRestockedQty;

      doc.stockProcessed = true;

      doc.stockProcessedAt = new Date();

      doc.status = "COMPLETED";

      doc.warehouseStatus =
        choice === "RESTOCK" && totalRestockedQty > 0 ? "restocked" : "closed";

      await doc.save({ session });

      result = {
        returnDoc: doc,

        transaction,

        totalRestockedQty,

        resolution: choice,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}


// =====================================================
// RE-SYNC MARKED RETURNS THAT NEVER REACHED INVENTORY
// Only restore records marked RESTOCK when no transaction,
// batch, or inventory history exists. Ambiguous records are skipped.
// =====================================================

async function resyncMarkedShopeeReturns({ shopId, user }) {
  const id = text(shopId);
  if (!id) throw new Error("Thiếu shopId.");

  const candidates = await ShopeeReturn.find({
    shopId: id,
    resolution: "RESTOCK",
    stockProcessed: true,
    restockedStockQty: { $gt: 0 },
  }).sort({ resolutionAt: 1, createdAt: 1 }).lean();

  const summary = {
    scanned: candidates.length,
    restored: 0,
    restoredQty: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      let outcome = null;
      await session.withTransaction(async () => {
        const doc = await ShopeeReturn.findOne({
          _id: candidate._id,
          shopId: id,
        }).session(session);

        if (!doc || doc.resolution !== "RESTOCK" || !doc.stockProcessed ||
            number(doc.restockedStockQty) <= 0) {
          outcome = { status: "skipped", reason: "Phiếu không còn ở trạng thái đã đánh dấu lưu kho." };
          return;
        }

        const idempotencyKey = ["SHOPEE", "RETURN", id, doc.returnSn, "RESOLVE"].join(":");
        const existingTransaction = await ShopeeStockTransaction.findOne({
          idempotencyKey,
        }).session(session);

        if (existingTransaction) {
          outcome = { status: "skipped", reason: "Đã có giao dịch kho; không cộng lại." };
          return;
        }

        const existingHistory = await InventoryHistory.findOne({
          referenceType: "shopee_return",
          referenceCode: doc.returnSn,
          type: "import",
          qty: { $gt: 0 },
        }).session(session);

        const existingBatch = await InventoryBatch.findOne({
          source: "RETURN",
          note: { $regex: escapeRegex(doc.returnSn) },
          importQty: { $gt: 0 },
        }).session(session);

        if (existingHistory || existingBatch) {
          outcome = {
            status: "skipped",
            reason: "Đã có lô hoặc lịch sử nhập một phần; cần đối soát thủ công để tránh cộng trùng.",
          };
          return;
        }

        const allocations = [];
        let totalQty = 0;

        for (let index = 0; index < (doc.items || []).length; index += 1) {
          const item = doc.items[index];
          const qty = Math.max(0, number(item.restockedQty));
          if (qty <= 0) continue;

          if (!item.productId || !text(item.variantCode) ||
              (item.mappingStatus !== "mapped" && !item.isMapped)) {
            throw new Error("Thiếu SKU mapping hợp lệ ở sản phẩm: " + text(item.itemName));
          }

          const product = await Product.findById(item.productId).session(session);
          if (!product) throw new Error("Không tìm thấy sản phẩm kho: " + String(item.productId));

          const variant = (product.variants || []).find(
            row => text(row.variantCode || row.code) === text(item.variantCode)
          );
          if (!variant) throw new Error("Không tìm thấy biến thể " + text(item.variantCode));

          const beforeQty = number(variant.qty);
          const afterQty = beforeQty + qty;
          const unitCost = Math.max(0, number(variant.unitCost));
          const batchCode = createReturnBatchCode(doc.returnSn, index);

          const duplicateBatchCode = await InventoryBatch.findOne({ batchCode }).session(session);
          if (duplicateBatchCode) {
            throw new Error("Mã lô hàng hoàn đã tồn tại; hệ thống dừng để tránh nhập trùng.");
          }

          const batch = new InventoryBatch({
            batchCode,
            productId: product._id,
            productTitle: product.title || "",
            productCode: product.code || "",
            variantName: variant.name || item.variantName || "",
            variantCode: item.variantCode,
            importDate: new Date(),
            importQty: qty,
            remainingQty: qty,
            unitCost,
            importReceiptId: null,
            importHistoryId: null,
            source: "RETURN",
            sourceConfidence: "high",
            note: "Đồng bộ phục hồi hàng hoàn Shopee " + doc.returnSn,
            createdBy: getUserId(user),
            isActive: true,
          });
          await batch.save({ session });

          variant.qty = afterQty;
          product.qty = number(product.qty) + qty;
          product.updated_at = new Date();
          await product.save({ session });

          const history = new InventoryHistory({
            type: "import",
            referenceType: "shopee_return",
            referenceId: doc._id,
            referenceCode: doc.returnSn,
            productId: product._id,
            productTitle: product.title || "",
            productCode: product.code || "",
            variantName: variant.name || item.variantName || "",
            variantCode: item.variantCode,
            batchId: batch._id,
            batchCode,
            unitCost,
            qty,
            beforeQty,
            afterQty,
            note: "Phục hồi tồn kho từ phiếu hoàn Shopee " + doc.returnSn,
            createdBy: getUserId(user),
            created_at: new Date(),
          });
          await history.save({ session });

          batch.importHistoryId = history._id;
          await batch.save({ session });

          allocations.push({
            productId: product._id,
            variantCode: item.variantCode,
            variantName: variant.name || item.variantName || "",
            batchId: batch._id,
            batchCode,
            qty,
            unitCost,
            beforeQty,
            afterQty,
          });
          totalQty += qty;
        }

        if (totalQty <= 0 || totalQty !== number(doc.restockedStockQty)) {
          throw new Error(
            "Tổng số lượng đã đánh dấu (" + number(doc.restockedStockQty) +
            ") không khớp số lượng từng sản phẩm (" + totalQty + "). Không thay đổi tồn kho."
          );
        }

        const transaction = new ShopeeStockTransaction({
          idempotencyKey,
          shopId: id,
          orderSn: doc.orderSn,
          returnSn: doc.returnSn,
          kind: "return_import",
          allocations,
          totalQty,
          status: "completed",
          note: "Phục hồi giao dịch nhập kho đã đánh dấu trước đó",
          createdBy: getUserId(user),
        });
        await transaction.save({ session });

        outcome = { status: "restored", qty: totalQty };
      });

      if (outcome?.status === "restored") {
        summary.restored += 1;
        summary.restoredQty += outcome.qty;
      } else {
        summary.skipped += 1;
      }
      summary.details.push({
        returnSn: candidate.returnSn,
        orderSn: candidate.orderSn,
        ...outcome,
      });
    } catch (error) {
      summary.failed += 1;
      summary.details.push({
        returnSn: candidate.returnSn,
        orderSn: candidate.orderSn,
        status: "failed",
        reason: error.message,
      });
    } finally {
      await session.endSession();
    }
  }

  return summary;
}


// =====================================================
// FULL HISTORICAL RETURN RECONCILIATION (READ ONLY)
// =====================================================

async function auditShopeeReturnHistory({ shopId }) {
  const id = text(shopId);
  if (!id) throw new Error("Thiếu shopId.");

  const docs = await ShopeeReturn.find({ shopId: id })
    .sort({ createTime: 1, createdAt: 1, _id: 1 })
    .lean();

  const report = {
    scanned: docs.length,
    safelyRecoverable: [],
    alreadyRecorded: [],
    partialOrAmbiguous: [],
    notMarkedForRestock: [],
    noRestockQuantity: [],
    totals: {
      safelyRecoverable: 0,
      alreadyRecorded: 0,
      partialOrAmbiguous: 0,
      notMarkedForRestock: 0,
      noRestockQuantity: 0,
    },
    auditedAt: new Date(),
  };

  for (const doc of docs) {
    const returnSn = text(doc.returnSn);
    const markedRestock = doc.resolution === "RESTOCK" ||
      (doc.resolution == null && ["restocked", "partially_restocked"].includes(doc.warehouseStatus));
    const qty = Math.max(0, number(doc.restockedStockQty) ||
      (doc.items || []).reduce((sum, item) => sum + Math.max(0, number(item.restockedQty)), 0));

    const [transaction, histories, batches] = await Promise.all([
      ShopeeStockTransaction.findOne({
        shopId: id,
        returnSn,
        kind: "return_import",
        status: "completed",
      }).lean(),
      InventoryHistory.find({
        referenceCode: returnSn,
        referenceType: "shopee_return",
        type: "import",
        qty: { $gt: 0 },
      }).select("_id qty productId variantCode batchCode").lean(),
      InventoryBatch.find({
        source: "RETURN",
        note: { $regex: escapeRegex(returnSn) },
        importQty: { $gt: 0 },
      }).select("_id importQty productId variantCode batchCode").lean(),
    ]);

    const itemQty = (doc.items || []).reduce(
      (sum, item) => sum + Math.max(0, number(item.restockedQty)), 0
    );
    const row = {
      returnSn,
      orderSn: doc.orderSn,
      returnType: doc.returnType,
      resolution: doc.resolution || null,
      warehouseStatus: doc.warehouseStatus,
      stockProcessed: Boolean(doc.stockProcessed),
      markedQty: qty,
      itemQty,
      transactionFound: Boolean(transaction),
      historyCount: histories.length,
      batchCount: batches.length,
      itemCount: (doc.items || []).length,
    };

    if (!markedRestock) {
      report.notMarkedForRestock.push(row);
    } else if (qty <= 0 || itemQty <= 0 || qty !== itemQty) {
      report.noRestockQuantity.push({
        ...row,
        reason: "Thiếu số lượng nhập kho hoặc tổng số lượng đã đánh dấu không khớp từng dòng hàng.",
      });
    } else if (transaction && histories.length && batches.length) {
      report.alreadyRecorded.push(row);
    } else if (!transaction && histories.length === 0 && batches.length === 0 &&
      doc.stockProcessed === true && doc.resolution === "RESTOCK") {
      report.safelyRecoverable.push(row);
    } else {
      report.partialOrAmbiguous.push({
        ...row,
        reason: "Có dấu vết giao dịch/lô/lịch sử chưa đầy đủ hoặc trạng thái cũ chưa đủ căn cứ tự động cộng kho.",
      });
    }
  }

  for (const key of Object.keys(report.totals)) {
    report.totals[key] = report[key].length;
  }

  return report;
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  syncShopeeReturns,

  syncCustomerReturns,
  syncDeliveryFailedPackages,

  getShopeeReturns,
  getShopeeReturnDetail,

  receiveShopeeReturn,
  inspectShopeeReturn,
  resolveShopeeReturn,
  resyncMarkedShopeeReturns,
  auditShopeeReturnHistory,
};
