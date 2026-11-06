const mongoose = require("mongoose");

const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");
const { Product } = require("../models/products");
const InventoryBatch = require("../models/InventoryBatch");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const {
  reserveShopeeOrder,
  deductShopeeOrder,
  releaseShopeeOrder,
  receiveShopeeReturn,
} = require("../services/shopeeAutoSyncService");

// =====================================================
// HELPERS
// =====================================================

const toString = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const sendError = (res, status, message) => {
  return res.status(status).json({
    success: false,
    message,
  });
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeStatus = (value) => toString(value).toUpperCase();

const getRequiredQty = (item) => {
  const quantity = Math.max(0, toNumber(item.quantity));
  const multiplier = Math.max(1, toNumber(item.quantityMultiplier || 1));

  return Math.ceil(quantity * multiplier);
};

const isStockEligible = (item) => {
  return (
    item.mappingStatus === "mapped" &&
    item.allowStockDeduction === true &&
    Boolean(item.productId) &&
    Boolean(toString(item.variantCode))
  );
};

async function findShopeeOrder({ shopId, orderSn }) {
  const filter = {
    orderSn: toString(orderSn),
  };

  if (shopId) {
    filter.shopId = toString(shopId);
  }

  return ShopeeOrder.findOne(filter);
}

async function getUpdatedOrder(orderId) {
  return ShopeeOrder.findById(orderId).lean();
}
// =====================================================
// ĐỒNG BỘ MAPPING MỚI NHẤT VÀO ĐƠN SHOPEE CŨ
// Khóa đối chiếu: shopId + itemId + modelId
// =====================================================

async function applyLatestSkuMappings(order) {
  if (!order || !Array.isArray(order.items) || !order.items.length) {
    return order;
  }

  const itemIds = [
    ...new Set(
      order.items.map((item) => toString(item.itemId)).filter(Boolean),
    ),
  ];

  if (!itemIds.length) return order;

  const mappings = await ShopeeSkuMapping.find({
    shopId: toString(order.shopId),
    itemId: { $in: itemIds },
  }).lean();

  const mappingMap = new Map();

  for (const mapping of mappings) {
    const key = `${toString(mapping.itemId)}_${toString(mapping.modelId)}`;
    mappingMap.set(key, mapping);
  }

  let changed = false;

  for (const item of order.items) {
    const key = `${toString(item.itemId)}_${toString(item.modelId)}`;
    const mapping = mappingMap.get(key);

    // Không có mapping mới thì giữ snapshot hiện tại.
    if (!mapping) continue;

    const isActive = mapping.isActive !== false;

    const hasValidMapping =
      isActive &&
      Boolean(mapping.productId) &&
      Boolean(toString(mapping.variantCode));

    item.productId = mapping.productId || null;
    item.variantCode = toString(mapping.variantCode);
    item.variantName = toString(mapping.variantName);
    item.quantityMultiplier = Math.max(
      1,
      toNumber(mapping.quantityMultiplier || 1),
    );

    item.mappingStatus = hasValidMapping ? "mapped" : "unmapped";

    item.allowStockDeduction =
      hasValidMapping && mapping.allowStockDeduction === true;

    changed = true;
  }

  // Lưu snapshot mới để các lần xử lý tiếp theo dùng cùng mapping.
  if (changed && typeof order.save === "function") {
    await order.save();
  }

  return order;
}

function findProductVariant(product, variantCode) {
  return (product?.variants || []).find(
    (variant) => toString(variant.variantCode) === toString(variantCode),
  );
}

/**
 * FIFO:
 * - Ưu tiên đúng productId + variantCode.
 * - Chỉ fallback variantName với lô cũ chưa có variantCode.
 */
async function findFifoBatches(item, session = null) {
  const variantCode = toString(item.variantCode);
  const variantName = toString(item.variantName);

  const conditions = [{ variantCode }];

  if (variantName) {
    conditions.push({
      variantName,
      $or: [
        { variantCode: "" },
        { variantCode: null },
        { variantCode: { $exists: false } },
      ],
    });
  }

  let query = InventoryBatch.find({
    productId: item.productId,
    remainingQty: { $gt: 0 },
    isActive: true,
    $or: conditions,
  }).sort({
    importDate: 1,
    createdAt: 1,
    _id: 1,
  });

  if (session) {
    query = query.session(session);
  }

  return query.lean();
}

function getPagination(query, defaultLimit = 50) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || defaultLimit));

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

// =====================================================
// 1. DANH SÁCH GIAO DỊCH TỒN KHO
// GET /shopee/stock/transactions
// =====================================================

exports.getStockTransactionsAsync = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const filter = {};

    if (req.query.shopId) {
      filter.shopId = toString(req.query.shopId);
    }

    if (req.query.orderSn) {
      filter.orderSn = toString(req.query.orderSn);
    }

    if (req.query.kind) {
      filter.kind = toString(req.query.kind);
    }

    if (req.query.status) {
      filter.status = toString(req.query.status);
    }

    if (req.query.from || req.query.to) {
      filter.createdAt = {};

      if (req.query.from) {
        const from = new Date(req.query.from);

        if (Number.isNaN(from.getTime())) {
          return sendError(res, 400, "Ngày bắt đầu không hợp lệ.");
        }

        filter.createdAt.$gte = from;
      }

      if (req.query.to) {
        const to = new Date(req.query.to);

        if (Number.isNaN(to.getTime())) {
          return sendError(res, 400, "Ngày kết thúc không hợp lệ.");
        }

        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    const [transactions, total] = await Promise.all([
      ShopeeStockTransaction.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      ShopeeStockTransaction.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] getTransactions:", error);
    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 2. CHI TIẾT TRẠNG THÁI KHO CỦA ĐƠN
// GET /shopee/stock/orders/:orderSn
// =====================================================

exports.getOrderStockDetailAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.query.shopId);

    if (!orderSn) {
      return sendError(res, 400, "Thiếu mã đơn Shopee.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }

    const transactions = await ShopeeStockTransaction.find({
      shopId: order.shopId,
      orderSn: order.orderSn,
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    return res.json({
      success: true,
      data: {
        order,
        stock: {
          stockStatus: order.stockStatus || "pending",
          stockDeducted: Boolean(order.stockDeducted),
          returnReceived: Boolean(order.returnReceived),
          reservedAt: order.stockReservedAt || null,
          deductedAt: order.stockDeductedAt || null,
          releasedAt: order.stockReleasedAt || null,
          returnedAt: order.stockReturnedAt || null,
          returnedQty: toNumber(order.returnedQty),
        },
        transactions,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] getOrderStockDetail:", error);
    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 3. GIỮ TỒN KHO CHO ĐƠN
// =====================================================

exports.reserveOrderStockAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.body.shopId || req.query.shopId);

    if (!orderSn || !shopId) {
      return sendError(res, 400, "Thiếu orderSn hoặc shopId.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }
    await applyLatestSkuMappings(order);
    const status = normalizeStatus(order.orderStatus);

    if (!["READY_TO_SHIP", "PROCESSED"].includes(status)) {
      return sendError(
        res,
        400,
        `Không thể giữ kho khi đơn đang ở trạng thái ${status || "không xác định"}.`,
      );
    }

    if (order.stockDeducted) {
      return sendError(res, 409, "Đơn này đã trừ kho, không thể giữ kho lại.");
    }

    const result = await reserveShopeeOrder(order);
    const updatedOrder = await getUpdatedOrder(order._id);

    return res.json({
      success: true,
      message: "Đã xử lý giữ tồn kho cho đơn Shopee.",
      data: {
        order: updatedOrder,
        result: result || null,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] reserveOrderStock:", error);
    return sendError(res, 400, error.message);
  }
};

// =====================================================
// 4. XÁC NHẬN TRỪ KHO FIFO
// CHỈ COMPLETED MỚI ĐƯỢC TRỪ KHO VẬT LÝ
// =====================================================

exports.deductOrderStockAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.body.shopId || req.query.shopId);

    if (!orderSn || !shopId) {
      return sendError(res, 400, "Thiếu orderSn hoặc shopId.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }
    await applyLatestSkuMappings(order);
    if (normalizeStatus(order.orderStatus) !== "COMPLETED") {
      return sendError(
        res,
        400,
        "Chỉ được xác nhận trừ kho khi đơn Shopee đã COMPLETED.",
      );
    }

    if (order.stockDeducted) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        message: "Đơn này đã được trừ kho trước đó.",
        data: order,
      });
    }

    const result = await deductShopeeOrder(order);
    const updatedOrder = await getUpdatedOrder(order._id);

    return res.json({
      success: true,
      message: "Đã xác nhận trừ kho Shopee theo FIFO.",
      data: {
        order: updatedOrder,
        result: result || null,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] deductOrderStock:", error);
    return sendError(res, 400, error.message);
  }
};

// =====================================================
// 5. GIẢI PHÓNG TỒN KHO ĐÃ GIỮ
// =====================================================

exports.releaseOrderStockAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.body.shopId || req.query.shopId);

    if (!orderSn || !shopId) {
      return sendError(res, 400, "Thiếu orderSn hoặc shopId.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }

    if (normalizeStatus(order.orderStatus) !== "CANCELLED") {
      return sendError(
        res,
        400,
        "Chỉ giải phóng tồn kho khi đơn Shopee đã bị hủy.",
      );
    }

    if (order.stockDeducted) {
      return sendError(
        res,
        409,
        "Đơn đã trừ kho. Không thể giải phóng như đơn chưa xuất.",
      );
    }

    const result = await releaseShopeeOrder(order);
    const updatedOrder = await getUpdatedOrder(order._id);

    return res.json({
      success: true,
      message: "Đã giải phóng tồn kho giữ cho đơn bị hủy.",
      data: {
        order: updatedOrder,
        result: result || null,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] releaseOrderStock:", error);
    return sendError(res, 400, error.message);
  }
};

// =====================================================
// 6. TỔNG QUAN TRẠNG THÁI KHO SHOPEE
// =====================================================

exports.getStockSummaryAsync = async (req, res) => {
  try {
    const filter = {};

    if (req.query.shopId) {
      filter.shopId = toString(req.query.shopId);
    }

    const transactionFilter = req.query.shopId
      ? { shopId: toString(req.query.shopId) }
      : {};

    const [
      total,
      ready,
      deducted,
      partiallyDeducted,
      pending,
      unmapped,
      blocked,
      cancelled,
      transactions,
    ] = await Promise.all([
      ShopeeOrder.countDocuments(filter),
      ShopeeOrder.countDocuments({ ...filter, stockStatus: "ready" }),
      ShopeeOrder.countDocuments({ ...filter, stockStatus: "deducted" }),
      ShopeeOrder.countDocuments({
        ...filter,
        stockStatus: "partially_deducted",
      }),
      ShopeeOrder.countDocuments({ ...filter, stockStatus: "pending" }),
      ShopeeOrder.countDocuments({ ...filter, stockStatus: "unmapped" }),
      ShopeeOrder.countDocuments({ ...filter, stockStatus: "blocked" }),
      ShopeeOrder.countDocuments({
        ...filter,
        orderStatus: "CANCELLED",
      }),
      ShopeeStockTransaction.countDocuments(transactionFilter),
    ]);

    return res.json({
      success: true,
      data: {
        totalOrders: total,
        readyOrders: ready,
        deductedOrders: deducted,
        partiallyDeductedOrders: partiallyDeducted,
        pendingOrders: pending,
        unmappedOrders: unmapped,
        blockedOrders: blocked,
        cancelledOrders: cancelled,
        totalTransactions: transactions,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] getStockSummary:", error);
    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 7. DANH SÁCH ĐƠN CẦN XỬ LÝ KHO
// =====================================================

exports.getPendingStockOrdersAsync = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query, 30);

    const filter = {
      orderStatus: { $nin: ["CANCELLED", "IN_CANCEL"] },
      stockStatus: { $ne: "deducted" },
    };

    if (req.query.shopId) {
      filter.shopId = toString(req.query.shopId);
    }

    if (req.query.orderStatus) {
      filter.orderStatus = toString(req.query.orderStatus).toUpperCase();
    }

    if (req.query.stockStatus) {
      filter.stockStatus = toString(req.query.stockStatus);
    }

    const search = toString(req.query.search || req.query.keyword);

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");

      filter.$and = [
        {
          $or: [
            { orderSn: regex },
            { buyerUsername: regex },
            { recipientName: regex },
            { customerName: regex },
          ],
        },
      ];
    }

    const [orders, total] = await Promise.all([
      ShopeeOrder.find(filter)
        .sort({ updateTime: -1, createdAt: -1 })
        .skip(skip)
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
    console.error("[Shopee Stock] getPendingStockOrders:", error);
    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 8. LỊCH SỬ GIAO DỊCH TỒN KHO THEO ĐƠN
// =====================================================

exports.getStockHistoryAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.query.shopId);

    if (!orderSn) {
      return sendError(res, 400, "Thiếu mã đơn Shopee.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }

    const transactions = await ShopeeStockTransaction.find({
      shopId: order.shopId,
      orderSn: order.orderSn,
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    return res.json({
      success: true,
      data: {
        orderSn: order.orderSn,
        shopId: order.shopId,
        orderStatus: order.orderStatus,
        stockStatus: order.stockStatus || "pending",
        stockDeducted: Boolean(order.stockDeducted),
        returnedQty: toNumber(order.returnedQty),
        returnReceived: Boolean(order.returnReceived),
        deductedAt: order.stockDeductedAt || null,
        transactions,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] getStockHistory:", error);
    return sendError(res, 500, error.message);
  }
};

// =====================================================
// 9. XÁC NHẬN XUẤT KHO
// =====================================================

exports.deductStockAsync = async (req, res) => {
  return exports.deductOrderStockAsync(req, res);
};

// =====================================================
// 10. TIẾP NHẬN HÀNG HOÀN
// =====================================================

exports.receiveReturnAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.body.shopId || req.query.shopId);

    if (!orderSn || !shopId) {
      return sendError(res, 400, "Thiếu orderSn hoặc shopId.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }

    if (!order.stockDeducted) {
      return sendError(
        res,
        400,
        "Đơn chưa xuất kho nên không thể tiếp nhận hàng hoàn.",
      );
    }

    if (order.returnReceived) {
      return sendError(
        res,
        409,
        "Đơn này đã được tiếp nhận hàng hoàn trước đó.",
      );
    }

    const status = normalizeStatus(order.orderStatus);

    if (!["RETURNED", "COMPLETED"].includes(status)) {
      return sendError(res, 400, "Đơn chưa ở trạng thái hoàn hàng hợp lệ.");
    }

    const result = await receiveShopeeReturn(order, {
      userId: req.user?._id || req.user?.id || null,
      note: toString(req.body.note),
      items: req.body.items,
      returnSn: toString(req.body.returnSn),
    });

    const updatedOrder = await getUpdatedOrder(order._id);

    return res.json({
      success: true,
      message: "Đã tiếp nhận hàng hoàn.",
      data: {
        order: updatedOrder,
        result: result || null,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] receiveReturn:", error);
    return sendError(res, 400, error.message);
  }
};

// =====================================================
// 11. PREVIEW XUẤT KHO FIFO
// =====================================================

exports.previewStockDeductionAsync = async (req, res) => {
  try {
    const orderSn = toString(req.params.orderSn);
    const shopId = toString(req.body.shopId || req.query.shopId);

    if (!orderSn || !shopId) {
      return sendError(res, 400, "Thiếu orderSn hoặc shopId.");
    }

    const order = await findShopeeOrder({ shopId, orderSn });

    if (!order) {
      return sendError(res, 404, "Không tìm thấy đơn Shopee.");
    }

    // LẤY MAPPING MỚI NHẤT TRƯỚC KHI KIỂM TRA TỒN KHO
    await applyLatestSkuMappings(order);
    if (order.stockDeducted) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        message: "Đơn này đã được xuất kho.",
        data: {
          orderSn,
          shopId,
          stockStatus: order.stockStatus,
          items: [],
          summary: {
            totalRequired: 0,
            totalAvailable: 0,
            totalShortage: 0,
            totalItems: (order.items || []).length,
            eligibleItems: 0,
          },
        },
      });
    }

    const items = [];

    let totalRequired = 0;
    let totalAvailable = 0;
    let totalShortage = 0;
    let canDeduct = true;
    let eligibleItems = 0;
    let estimatedCost = 0;

    for (const item of order.items || []) {
      const requiredQty = getRequiredQty(item);

      const baseItem = {
        itemId: item.itemId,
        modelId: item.modelId,
        itemName: item.itemName,
        modelName: item.modelName,
        variantCode: item.variantCode,
        variantName: item.variantName,
        mappingStatus: item.mappingStatus || "unmapped",
        allowStockDeduction: item.allowStockDeduction === true,
      };

      if (!isStockEligible(item)) {
        items.push({
          ...baseItem,
          requiredQty,
          needDeduct: 0,
          canDeduct: false,
          batches: [],
          reason:
            "Sản phẩm chưa được ánh xạ đầy đủ hoặc chưa cho phép xử lý tồn kho.",
        });

        continue;
      }

      eligibleItems += 1;

      const alreadyDeducted = Math.max(0, toNumber(item.deductedQty));

      const needDeduct = Math.max(0, requiredQty - alreadyDeducted);

      if (needDeduct <= 0) {
        items.push({
          ...baseItem,
          requiredQty,
          alreadyDeducted,
          needDeduct: 0,
          canDeduct: true,
          batches: [],
          estimatedCost: 0,
          message: "Sản phẩm đã xuất đủ.",
        });

        continue;
      }

      if (!mongoose.isValidObjectId(item.productId)) {
        throw new Error(`Mã sản phẩm không hợp lệ: ${item.productId}.`);
      }

      const product = await Product.findById(item.productId).lean();

      if (!product) {
        throw new Error(`Không tìm thấy sản phẩm ${item.productId}.`);
      }

      const variant = findProductVariant(product, item.variantCode);

      if (!variant) {
        throw new Error(
          `Không tìm thấy biến thể ${item.variantCode} của ${product.title}.`,
        );
      }

      const physicalQty = Math.max(0, toNumber(variant.qty));
      const reservedQty = Math.max(0, toNumber(variant.reservedQty));

      const ownReserved = Math.min(
        Math.max(0, toNumber(item.reservedQty)),
        needDeduct,
      );

      const availableForOrder = Math.max(
        0,
        physicalQty - reservedQty + ownReserved,
      );

      const batches = await findFifoBatches(item);

      const batchAvailable = batches.reduce(
        (sum, batch) => sum + Math.max(0, toNumber(batch.remainingQty)),
        0,
      );

      let remaining = needDeduct;
      const batchAllocations = [];

      for (const batch of batches) {
        if (remaining <= 0) break;

        const availableQty = Math.max(0, toNumber(batch.remainingQty));

        const deductQty = Math.min(availableQty, remaining);

        if (deductQty <= 0) continue;

        const unitCost = toNumber(batch.unitCost);
        const costAmount = deductQty * unitCost;

        batchAllocations.push({
          batchId: batch._id,
          batchCode: batch.batchCode || "",
          importDate: batch.importDate || null,
          availableQty,
          deductQty,
          remainingAfterDeduction: availableQty - deductQty,
          unitCost,
          costAmount,
        });

        remaining -= deductQty;
      }

      const shortageByVariant = Math.max(0, needDeduct - availableForOrder);

      const shortageByBatch = Math.max(0, needDeduct - batchAvailable);

      const shortage = Math.max(shortageByVariant, shortageByBatch);

      const itemCanDeduct = shortage === 0;

      if (!itemCanDeduct) {
        canDeduct = false;
      }

      const itemEstimatedCost = batchAllocations.reduce(
        (sum, batch) => sum + batch.costAmount,
        0,
      );

      totalRequired += needDeduct;

      totalAvailable += Math.min(needDeduct, availableForOrder, batchAvailable);

      totalShortage += shortage;
      estimatedCost += itemEstimatedCost;

      items.push({
        ...baseItem,

        productId: product._id,
        productTitle: product.title,
        productCode: product.code,

        requiredQty,
        alreadyDeducted,
        needDeduct,

        physicalQty,
        reservedQty,
        ownReserved,
        availableForOrder,

        batchAvailable,
        shortage,

        canDeduct: itemCanDeduct,
        batches: batchAllocations,

        estimatedCost: itemEstimatedCost,

        reason: itemCanDeduct
          ? ""
          : "Không đủ tồn kho biến thể hoặc tồn kho các lô FIFO.",
      });
    }

    const orderStatus = normalizeStatus(order.orderStatus);

    const canConfirmDeduction =
      canDeduct && eligibleItems > 0 && orderStatus === "COMPLETED";

    let message = "Đủ điều kiện xuất kho theo FIFO.";

    if (eligibleItems === 0) {
      canDeduct = false;
      message = "Đơn chưa có sản phẩm đủ điều kiện xử lý tồn kho.";
    } else if (totalShortage > 0) {
      message = "Có sản phẩm không đủ tồn kho để xuất.";
    } else if (orderStatus !== "COMPLETED") {
      message =
        "Tồn kho đủ, nhưng chỉ được xác nhận trừ kho khi đơn COMPLETED.";
    }

    return res.json({
      success: true,
      message,
      data: {
        orderSn,
        shopId,
        orderStatus: order.orderStatus,
        stockStatus: order.stockStatus || "pending",

        canDeduct,
        canConfirmDeduction,

        summary: {
          totalRequired,
          totalAvailable,
          totalShortage,
          totalItems: (order.items || []).length,
          eligibleItems,
          estimatedCost,
        },

        items,
      },
    });
  } catch (error) {
    console.error("[Shopee Stock] previewStockDeduction:", error);
    return sendError(res, 400, error.message);
  }
};

// =====================================================
// GET ALL SHOPEE STOCK TRANSACTIONS
// GET /api/shopee/stock/transactions
// =====================================================

exports.getStockTransactionsAsync = async (req, res) => {
  try {
    const {
      shopId,
      orderSn,
      kind,
      status,
      from,
      to,
      page = 1,
      limit = 50,
    } = req.query;

    if (!shopId || !String(shopId).trim()) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee.",
      });
    }

    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(limit, 10) || 50),
    );

    const filter = {
      shopId: String(shopId).trim(),
    };

    // Các bộ lọc đều không bắt buộc
    if (orderSn && String(orderSn).trim()) {
      filter.orderSn = {
        $regex: String(orderSn).trim(),
        $options: "i",
      };
    }

    if (kind && String(kind).trim()) {
      filter.kind = String(kind).trim();
    }

    if (status && String(status).trim()) {
      filter.status = String(status).trim();
    }

    if (from || to) {
      filter.createdAt = {};

      if (from) {
        const fromDate = new Date(from);

        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Ngày bắt đầu không hợp lệ.",
          });
        }

        filter.createdAt.$gte = fromDate;
      }

      if (to) {
        const toDate = new Date(to);

        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Ngày kết thúc không hợp lệ.",
          });
        }

        // Bao gồm toàn bộ ngày kết thúc nếu người dùng chỉ gửi YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
          toDate.setHours(23, 59, 59, 999);
        }

        filter.createdAt.$lte = toDate;
      }
    }

    const skip = (currentPage - 1) * pageSize;

    const [transactions, total, summary] = await Promise.all([
      ShopeeStockTransaction.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),

      ShopeeStockTransaction.countDocuments(filter),

      ShopeeStockTransaction.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$kind",
            count: { $sum: 1 },
            totalQty: { $sum: { $ifNull: ["$totalQty", 0] } },
          },
        },
      ]),
    ]);

    const summaryByKind = {};

    for (const item of summary) {
      summaryByKind[item._id || "unknown"] = {
        count: item.count,
        totalQty: item.totalQty,
      };
    }

    return res.status(200).json({
      success: true,
      message: "Lấy lịch sử giao dịch kho Shopee thành công.",
      transactions,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        hasNextPage: currentPage * pageSize < total,
        hasPrevPage: currentPage > 1,
      },
      summary: summaryByKind,
    });
  } catch (error) {
    console.error("[Shopee] getStockTransactionsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy lịch sử giao dịch kho Shopee.",
      error: error.message,
    });
  }
};
