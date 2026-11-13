const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/customer");
const { Product } = require("../models/products");
const InventoryHistory = require("../models/inventoryHistory");
const InventoryBatch = require("../models/InventoryBatch");

const {
  emitStockNotification,
} = require("../services/stockNotificationService");

/* =========================================================
   CONSTANT
========================================================= */

const UNCOMPLETED_STATUSES = ["pending", "confirmed", "shipping"];

const ALLOWED_STATUSES = [
  "pending",
  "confirmed",
  "shipping",
  "completed",
  "cancelled",
];

const ALLOWED_PAYMENT_METHODS = ["cash", "transfer", "cod", "debt"];

/* =========================================================
   BASIC HELPERS
========================================================= */

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizeVariantCode = (value) => String(value || "").trim();

const normalizeVariantName = (value) => String(value || "").trim();

const getProductCode = (product) => {
  return (
    product?.code ||
    product?.productCode ||
    product?.sku ||
    product?.product_code ||
    ""
  );
};

const getVariants = (product) => {
  return Array.isArray(product?.variants) ? product.variants : [];
};
const BATCH_SOURCES = ["IMPORT", "OPENING", "ADJUSTMENT", "RETURN", "OTHER"];

const SOURCE_CONFIDENCES = ["high", "medium", "low"];

const normalizeBatchSource = (value) => {
  const normalized = String(value || "IMPORT")
    .trim()
    .toUpperCase();

  return BATCH_SOURCES.includes(normalized) ? normalized : "OTHER";
};

const normalizeSourceConfidence = (value) => {
  const normalized = String(value || "medium")
    .trim()
    .toLowerCase();

  if (normalized === "inferred") return "medium";
  if (normalized === "unknown") return "low";

  return SOURCE_CONFIDENCES.includes(normalized) ? normalized : "low";
};

const normalizeInventoryBatchEnums = (batch) => {
  batch.source = normalizeBatchSource(batch.source);

  batch.sourceConfidence = normalizeSourceConfidence(batch.sourceConfidence);

  return batch;
};
/* =========================================================
   FIND VARIANT

   Ưu tiên variantCode.
   Chỉ fallback variantName nếu tên duy nhất.
========================================================= */

const findVariant = (product, variantName = "", variantCode = "") => {
  const variants = getVariants(product);

  const code = normalizeVariantCode(variantCode);
  const name = normalizeVariantName(variantName);

  if (code) {
    return (
      variants.find(
        (variant) => normalizeVariantCode(variant?.variantCode) === code,
      ) || null
    );
  }

  if (!name) return null;

  const matched = variants.filter(
    (variant) => normalizeVariantName(variant?.name) === name,
  );

  if (matched.length > 1) {
    throw new Error(
      `Tên biến thể "${name}" bị trùng trong sản phẩm "${product?.title}". Cần sử dụng variantCode.`,
    );
  }

  return matched[0] || null;
};

/* =========================================================
   GET PRODUCT PRICE
========================================================= */


/* =========================================================
   ENRICH ORDER COST
   - Ưu tiên giá vốn FIFO đã lưu trong batchAllocations.
   - Fallback unitCost snapshot trong đơn.
   - Đơn cũ: lấy unitCost/defaultPrice từ Product Variant.
========================================================= */

const enrichOrdersWithCost = async (orders = []) => {
  if (!Array.isArray(orders) || orders.length === 0) return orders;

  const productIds = [
    ...new Set(
      orders.flatMap((order) =>
        (order.items || [])
          .map((item) => String(item.productId || ""))
          .filter((id) => mongoose.Types.ObjectId.isValid(id)),
      ),
    ),
  ];

  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
        .select("title code price unitCost variants")
        .lean()
    : [];

  const productMap = new Map(
    products.map((product) => [String(product._id), product]),
  );

  return orders.map((order) => {
    let orderCostCny = 0;
    let hasCostData = true;

    const items = (order.items || []).map((item) => {
      const qty = Math.max(0, toNumber(item.qty));
      const product = productMap.get(String(item.productId || ""));
      let variant = null;

      if (product) {
        try {
          variant = findVariant(
            product,
            item.variantName,
            item.variantCode,
          );
        } catch (_) {
          variant = null;
        }
      }

      const allocations = Array.isArray(item.batchAllocations)
        ? item.batchAllocations
        : [];
      const allocatedQty = allocations.reduce(
        (sum, allocation) => sum + Math.max(0, toNumber(allocation.qty)),
        0,
      );
      const allocatedCost = allocations.reduce(
        (sum, allocation) =>
          sum +
          Math.max(0, toNumber(allocation.qty)) *
            Math.max(0, toNumber(allocation.unitCost)),
        0,
      );

      let unitCost = null;
      let costSource = "missing";

      if (qty > 0 && allocatedQty >= qty && allocatedCost > 0) {
        unitCost = allocatedCost / allocatedQty;
        costSource = "fifo";
      } else if (item.unitCost !== null && item.unitCost !== undefined &&
                 toNumber(item.unitCost) > 0) {
        unitCost = toNumber(item.unitCost);
        costSource = "order_snapshot";
      } else if (toNumber(variant?.unitCost) > 0) {
        unitCost = toNumber(variant.unitCost);
        costSource = "product_unit_cost";
      } else if (toNumber(variant?.defaultPrice) > 0) {
        unitCost = toNumber(variant.defaultPrice);
        costSource = "product_default_price";
      } else if (!variant && !item.variantCode && !item.variantName &&
                 toNumber(product?.unitCost) > 0) {
        unitCost = toNumber(product.unitCost);
        costSource = "product_unit_cost";
      }

      const totalCostCny =
        unitCost !== null ? unitCost * qty : 0;

      if (unitCost === null && qty > 0) hasCostData = false;
      orderCostCny += totalCostCny;

      return {
        ...item,
        unitCost,
        totalCostCny,
        costSource,
        hasCost: unitCost !== null,
      };
    });

    return {
      ...order,
      items,
      totalCostCny: orderCostCny,
      hasCostData,
    };
  });
};

const getProductPrice = (product, variantName = "", variantCode = "") => {
  const name = normalizeVariantName(variantName);
  const code = normalizeVariantCode(variantCode);

  if (!name && !code) {
    return {
      price: toNumber(product?.price),
      variant: null,
    };
  }

  const variant = findVariant(product, name, code);

  if (!variant) {
    return {
      price: null,
      variant: null,
    };
  }

  return {
    price: toNumber(variant.price),
    variant,
  };
};

/* =========================================================
   FIND INVENTORY BATCHES FIFO

   Lô mới: tìm theo variantCode.
   Lô cũ: chỉ tìm theo variantName nếu tên duy nhất.
========================================================= */

const findInventoryBatchesFIFO = async ({
  product,
  variant,
  variantName = "",
  session,
}) => {
  const productId = product._id;

  const variantCode = normalizeVariantCode(variant?.variantCode);

  const cleanVariantName = normalizeVariantName(variant?.name || variantName);

  const baseFilter = {
    productId,
    isActive: { $ne: false },
    remainingQty: { $gt: 0 },
  };

  const variantFilter = [];

  if (variantCode) {
    // Lô đã có variantCode.
    variantFilter.push({
      variantCode,
    });

    // Kiểm tra tên có duy nhất trong Product không.
    const sameNameVariants = getVariants(product).filter(
      (item) => normalizeVariantName(item?.name) === cleanVariantName,
    );

    // Chỉ cho phép lấy lô cũ theo tên nếu tên duy nhất.
    if (cleanVariantName && sameNameVariants.length === 1) {
      variantFilter.push({
        variantCode: { $in: ["", null] },
        variantName: cleanVariantName,
      });
    }
  } else if (cleanVariantName) {
    const sameNameVariants = getVariants(product).filter(
      (item) => normalizeVariantName(item?.name) === cleanVariantName,
    );

    if (sameNameVariants.length > 1) {
      throw new Error(
        `Không thể xác định lô cũ của "${cleanVariantName}" vì tên biến thể bị trùng. Cần cập nhật variantCode cho lô.`,
      );
    }

    variantFilter.push({
      variantCode: { $in: ["", null] },
      variantName: cleanVariantName,
    });
  } else {
    variantFilter.push({
      variantCode: { $in: ["", null] },
      variantName: { $in: ["", null] },
    });
  }

  if (!variantFilter.length) {
    return [];
  }

  return InventoryBatch.find({
    ...baseFilter,
    $or: variantFilter,
  })
    .sort({
      importDate: 1,
      created_at: 1,
      _id: 1,
    })
    .session(session);
};

/* =========================================================
   CALCULATE ORDER TOTAL
========================================================= */

const calculateOrderTotal = (order) => {
  let subtotal = 0;

  for (const item of order.items || []) {
    const qty = toNumber(item.qty);
    const price = toNumber(item.price);

    item.total = price * qty;
    subtotal += item.total;
  }

  const discount = Math.max(0, toNumber(order.discount));

  const shippingFee = Math.max(0, toNumber(order.shippingFee));

  const paidAmount = Math.max(0, toNumber(order.paidAmount));

  const totalAmount = Math.max(0, subtotal - discount + shippingFee);

  const debt = Math.max(0, totalAmount - paidAmount);

  order.subtotal = subtotal;
  order.totalAmount = totalAmount;
  order.debt = debt;
  order.updated_at = new Date();

  return {
    subtotal,
    totalAmount,
    debt,
  };
};

/* =========================================================
   GENERATE ORDER CODE
========================================================= */

const generateOrderCode = async () => {
  const now = new Date();

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  const prefix = `DH${yyyy}${mm}${dd}`;

  const lastOrder = await Order.findOne({
    code: {
      $regex: `^${prefix}-`,
    },
  })
    .sort({ code: -1 })
    .lean();

  let sequence = 1;

  if (lastOrder?.code) {
    const parts = String(lastOrder.code).split("-");
    sequence = (Number(parts[1]) || 0) + 1;
  }

  return `${prefix}-${String(sequence).padStart(4, "0")}`;
};

/* =========================================================
   BUILD INVENTORY HISTORY
========================================================= */

const buildInventoryHistory = ({
  order,
  product,
  variantName,
  variantCode,
  qty,
  beforeQty,
  afterQty,
  userId,
}) => {
  return {
    type: "order",
    referenceType: "Order",
    referenceId: order._id,
    referenceCode: order.code || "",

    productId: product._id,
    productTitle: product.title || "",
    productCode: getProductCode(product),

    variantName: normalizeVariantName(variantName),
    variantCode: normalizeVariantCode(variantCode),

    qty: -Math.abs(toNumber(qty)),
    beforeQty: toNumber(beforeQty),
    afterQty: toNumber(afterQty),

    note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

    createdBy: userId || null,
    rollback: false,
    rollback_at: null,
    rollbackBy: null,
    created_at: new Date(),
  };
};

/* =========================================================
   FIFO: DEDUCT ORDER STOCK
========================================================= */

const deductOrderStockFIFO = async ({ order, session, userId }) => {
  const productCache = new Map();
  const historyDocuments = [];

  for (const item of order.items || []) {
    const qty = toNumber(item.qty);

    const requestedVariantCode = normalizeVariantCode(item.variantCode);

    const requestedVariantName = normalizeVariantName(item.variantName);

    if (!item.productId || qty <= 0) {
      throw new Error(
        `Sản phẩm "${item.productTitle}" có số lượng không hợp lệ`,
      );
    }

    const productId = String(item.productId);

    let product = productCache.get(productId);

    if (!product) {
      product = await Product.findById(item.productId).session(session);

      if (!product) {
        throw new Error(`Không tìm thấy sản phẩm "${item.productTitle}"`);
      }

      productCache.set(productId, product);
    }

    let variant = null;

    if (requestedVariantCode || requestedVariantName) {
      variant = findVariant(
        product,
        requestedVariantName,
        requestedVariantCode,
      );

      if (!variant) {
        throw new Error(
          `Không tìm thấy biến thể "${requestedVariantCode || requestedVariantName}" của sản phẩm "${product.title}"`,
        );
      }

      // Đồng bộ snapshot theo Product.
      item.variantCode = normalizeVariantCode(variant.variantCode);

      item.variantName = normalizeVariantName(variant.name);

      const availableVariantQty =
        toNumber(variant.qty) - toNumber(variant.reservedQty);

      if (availableVariantQty < qty) {
        throw new Error(
          `Biến thể "${item.variantName}" chỉ còn khả dụng ${availableVariantQty}, cần xuất ${qty}.`,
        );
      }
    } else if (getVariants(product).length > 0) {
      throw new Error(
        `Sản phẩm "${product.title}" có phân loại nhưng đơn hàng chưa chọn phân loại.`,
      );
    }

    const availableProductQty = toNumber(product.qty);

    if (availableProductQty < qty) {
      throw new Error(
        `Sản phẩm "${product.title}" chỉ còn ${availableProductQty}, cần xuất ${qty}.`,
      );
    }

    // Lấy lô FIFO.
    const batches = await findInventoryBatchesFIFO({
      product,
      variant,
      variantName: requestedVariantName,
      session,
    });

    const availableBatchQty = batches.reduce(
      (sum, batch) => sum + Math.max(0, toNumber(batch.remainingQty)),
      0,
    );

    if (availableBatchQty < qty) {
      throw new Error(
        `Không đủ hàng trong các lô của "${product.title}" - ` +
          `${item.variantName || "Không phân loại"}. ` +
          `Tồn lô: ${availableBatchQty}, cần xuất: ${qty}.`,
      );
    }

    let remainingToDeduct = qty;
    const allocations = [];

    // Trừ lô theo FIFO.
    for (const batch of batches) {
      if (remainingToDeduct <= 0) break;

      const batchBeforeQty = toNumber(batch.remainingQty);

      const deductQty = Math.min(batchBeforeQty, remainingToDeduct);

      if (deductQty <= 0) continue;

      batch.remainingQty = batchBeforeQty - deductQty;
      normalizeInventoryBatchEnums(batch);

      await batch.save({ session });

      allocations.push({
        batchId: batch._id,
        batchCode: batch.batchCode || "",
        variantCode: normalizeVariantCode(
          batch.variantCode || variant?.variantCode,
        ),
        variantName: normalizeVariantName(
          batch.variantName || variant?.name || requestedVariantName,
        ),
        qty: deductQty,
        unitCost: toNumber(batch.unitCost),
      });

      historyDocuments.push(
        buildInventoryHistory({
          order,
          product,
          variantName: variant?.name || requestedVariantName,
          variantCode: variant?.variantCode || requestedVariantCode,
          qty: deductQty,
          beforeQty: batchBeforeQty,
          afterQty: batch.remainingQty,
          userId,
        }),
      );

      const history = historyDocuments[historyDocuments.length - 1];

      history.batchId = batch._id;
      history.batchCode = batch.batchCode || "";
      history.unitCost = toNumber(batch.unitCost);

      remainingToDeduct -= deductQty;
    }

    if (remainingToDeduct > 0) {
      throw new Error(
        `Không thể phân bổ đủ lô cho sản phẩm "${product.title}".`,
      );
    }

    // Không sử dụng batchAllocations từ FE.
    item.batchAllocations = allocations;

    if (variant) {
      variant.qty = toNumber(variant.qty) - qty;
    }

    product.qty = toNumber(product.qty) - qty;

    product.soldQty = toNumber(product.soldQty) + qty;

    product.updated_at = new Date();

    await product.save({ session });
  }

  if (historyDocuments.length > 0) {
    await InventoryHistory.insertMany(historyDocuments, {
      session,
      ordered: true,
    });
  }

  order.stockDeducted = true;
  order.markModified("items");

  return {
    historyRecords: historyDocuments.length,
    allocatedItems: (order.items || []).length,
  };
};

/* =========================================================
   FIFO: RESTORE ORDER STOCK
========================================================= */

const restoreOrderStockFIFO = async ({ order, session }) => {
  const histories = await InventoryHistory.find({
    referenceType: "Order",
    referenceId: order._id,
    type: "order",
    rollback: { $ne: true },
  })
    .sort({ created_at: 1 })
    .session(session);

  if (!histories.length && order.stockDeducted) {
    throw new Error(
      `Không tìm thấy lịch sử xuất kho của đơn ${order.code || order._id}.`,
    );
  }

  const productCache = new Map();
  let restoredQty = 0;

  for (const history of histories) {
    const qty = Math.abs(toNumber(history.qty));

    if (qty <= 0) continue;

    const productId = String(history.productId);

    let product = productCache.get(productId);

    if (!product) {
      product = await Product.findById(history.productId).session(session);

      if (!product) {
        throw new Error(
          `Không tìm thấy sản phẩm ${history.productId} để hoàn kho.`,
        );
      }

      productCache.set(productId, product);
    }

    // Hoàn về đúng lô.
    if (history.batchId) {
      const batch = await InventoryBatch.findById(history.batchId).session(
        session,
      );

      if (!batch) {
        throw new Error(
          `Không tìm thấy lô ${history.batchCode || history.batchId} để hoàn kho.`,
        );
      }

      batch.remainingQty = toNumber(batch.remainingQty) + qty;
      normalizeInventoryBatchEnums(batch);

      await batch.save({ session });
    }

    const variantCode = normalizeVariantCode(history.variantCode);

    const variantName = normalizeVariantName(history.variantName);

    if (variantCode || variantName) {
      const variant = findVariant(product, variantName, variantCode);

      if (!variant) {
        throw new Error(
          `Không tìm thấy biến thể "${variantCode || variantName}" khi hoàn kho sản phẩm "${product.title}".`,
        );
      }

      variant.qty = toNumber(variant.qty) + qty;
    }

    product.qty = toNumber(product.qty) + qty;

    product.soldQty = Math.max(0, toNumber(product.soldQty) - qty);

    product.updated_at = new Date();

    await product.save({ session });

    restoredQty += qty;
  }

  // Xóa lịch sử xuất sau khi hoàn kho thành công.
  await InventoryHistory.deleteMany(
    {
      referenceType: "Order",
      referenceId: order._id,
      type: "order",
    },
    { session },
  );

  order.stockDeducted = false;

  // Xóa phân bổ cũ để tránh hiển thị nhầm phân bổ đã hoàn.
  for (const item of order.items || []) {
    item.batchAllocations = [];
  }

  order.markModified("items");

  return {
    historyRecords: histories.length,
    restoredQty,
  };
};

/* =========================================================
   REBUILD SOLD QTY
   POST /api/order/rebuild-sold-qty
========================================================= */

const rebuildProductSoldQtyAsync = async (req, res) => {
  try {
    const soldData = await Order.aggregate([
      {
        $match: {
          status: "completed",
        },
      },
      {
        $unwind: "$items",
      },
      {
        $match: {
          "items.productId": {
            $exists: true,
            $ne: null,
          },
        },
      },
      {
        $group: {
          _id: "$items.productId",
          soldQty: {
            $sum: {
              $convert: {
                input: "$items.qty",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
      },
    ]);

    const bulkOperations = soldData
      .filter((item) => mongoose.Types.ObjectId.isValid(item._id))
      .map((item) => ({
        updateOne: {
          filter: { _id: item._id },
          update: {
            $set: {
              soldQty: Number(item.soldQty) || 0,
              updated_at: new Date(),
            },
          },
        },
      }));

    // Reset các sản phẩm không có đơn completed.
    await Product.updateMany({}, { $set: { soldQty: 0 } });

    if (bulkOperations.length > 0) {
      await Product.bulkWrite(bulkOperations);
    }

    const topProducts = await Product.find({
      soldQty: { $gt: 0 },
    })
      .sort({ soldQty: -1 })
      .limit(20)
      .select("_id title code soldQty qty thumbnail")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Đã rebuild số lượng sản phẩm đã bán",
      totalProducts: soldData.length,
      topProducts,
    });
  } catch (error) {
    console.error("rebuildProductSoldQtyAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể rebuild số lượng sản phẩm đã bán",
    });
  }
};

/* =========================================================
   SYNC ORDER STOCK
   Chỉ xử lý đơn completed chưa trừ kho.
========================================================= */

const syncOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    const filter = {
      stockDeducted: { $ne: true },
      status: "completed",
    };

    if (orderId) {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return res.status(400).json({
          success: false,
          message: "orderId không hợp lệ",
        });
      }

      filter._id = orderId;
    }

    const result = {
      totalOrders: 0,
      updatedOrders: 0,
      historyRecords: 0,
      skippedOrders: 0,
    };

    await session.withTransaction(async () => {
      const orders = await Order.find(filter)
        .sort({ created_at: 1 })
        .session(session);

      result.totalOrders = orders.length;

      for (const order of orders) {
        if (!Array.isArray(order.items) || order.items.length === 0) {
          result.skippedOrders++;
          continue;
        }

        const stockResult = await deductOrderStockFIFO({
          order,
          session,
          userId: req.user?._id || null,
        });

        order.updated_at = new Date();

        await order.save({ session });

        result.updatedOrders++;
        result.historyRecords += stockResult.historyRecords;
      }
    });

    return res.status(200).json({
      success: true,
      message: "Đồng bộ tồn kho đơn completed theo FIFO thành công",
      ...result,
    });
  } catch (error) {
    console.error("syncOrderStockAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Không thể đồng bộ tồn kho theo FIFO",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   CREATE ORDER
   Tạo đơn nhưng chưa trừ kho.
========================================================= */

const createOrderAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      customerId,
      customerName = "",
      customerPhone = "",
      customerAddress = "",
      items = [],
      discount = 0,
      shippingFee = 0,
      paidAmount = 0,
      paymentMethod = "cash",
      note = "",
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Đơn hàng chưa có sản phẩm",
      });
    }

    if (customerId && !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "customerId không hợp lệ",
      });
    }

    if (!customerId && (!String(customerName || "").trim() || !String(customerPhone || "").trim() || !String(customerAddress || "").trim())) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng cung cấp tên, số điện thoại và địa chỉ nhận hàng",
      });
    }

    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    const discountNumber = Math.max(0, toNumber(discount));
    const shippingNumber = Math.max(0, toNumber(shippingFee));
    const paidNumber = Math.max(0, toNumber(paidAmount));

    let createdOrder = null;

    await session.withTransaction(async () => {
      let customer = null;

      if (customerId) {
        customer = await Customer.findById(customerId).session(session);

        if (!customer) {
          throw new Error("Không tìm thấy khách hàng");
        }
      }

      // Gộp dòng theo productId + variantCode
      const mergedItems = new Map();

      for (const rawItem of items) {
        if (
          !rawItem?.productId ||
          !mongoose.Types.ObjectId.isValid(rawItem.productId)
        ) {
          throw new Error("productId không hợp lệ");
        }

        const qty = toNumber(rawItem.qty);

        if (qty <= 0) {
          throw new Error("Số lượng sản phẩm phải lớn hơn 0");
        }

        const variantCode = normalizeVariantCode(rawItem.variantCode);
        const variantName = normalizeVariantName(rawItem.variantName);

        const variantKey = variantCode
          ? `code:${variantCode}`
          : `name:${variantName}`;

        const key = `${String(rawItem.productId)}_${variantKey}`;

        if (!mergedItems.has(key)) {
          mergedItems.set(key, {
            productId: rawItem.productId,
            variantCode,
            variantName,
            qty: 0,
          });
        }

        const merged = mergedItems.get(key);

        if (
          merged.variantName &&
          variantName &&
          merged.variantName !== variantName
        ) {
          throw new Error(
            `Dữ liệu biến thể ${variantCode || variantName} không thống nhất.`,
          );
        }

        merged.qty += qty;
      }

      const productCache = new Map();
      const orderItems = [];

      let subtotal = 0;

      for (const item of mergedItems.values()) {
        const productId = String(item.productId);

        let product = productCache.get(productId);

        if (!product) {
          product = await Product.findById(item.productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
          }

          productCache.set(productId, product);
        }

        const variantName = normalizeVariantName(item.variantName);
        const variantCode = normalizeVariantCode(item.variantCode);

        let price = toNumber(product.price);
        let unitCost = toNumber(product.unitCost);
        let variant = null;

        if (variantCode || variantName) {
          variant = findVariant(product, variantName, variantCode);

          if (!variant) {
            throw new Error(
              `Không tìm thấy biến thể "${variantCode || variantName}" của sản phẩm "${product.title}"`,
            );
          }

          item.variantCode = normalizeVariantCode(variant.variantCode);
          item.variantName = normalizeVariantName(variant.name);

          price = toNumber(variant.price);

          // Lấy giá vốn từ Product Variant
          unitCost = toNumber(variant.unitCost);
        } else if (getVariants(product).length > 0) {
          throw new Error(
            `Sản phẩm "${product.title}" có phân loại nhưng chưa chọn phân loại.`,
          );
        }

        const itemTotal = price * item.qty;

        subtotal += itemTotal;

        orderItems.push({
          productId: product._id,
          productTitle: product.title || "",
          productCode: getProductCode(product),

          variantName: variant?.name || "",
          variantCode: variant?.variantCode || "",

          price,
          unitCost,

          qty: item.qty,
          total: itemTotal,
          thumbnail: product.thumbnail || "",

          // Giữ nguyên cơ chế tạo đơn: chưa phân bổ và chưa trừ kho.
          batchAllocations: [],
        });
      }

      const totalAmount = Math.max(
        0,
        subtotal - discountNumber + shippingNumber,
      );

      if (paidNumber > totalAmount) {
        throw new Error("Số tiền khách trả không được lớn hơn tổng tiền");
      }

      const debt = Math.max(0, totalAmount - paidNumber);

      const code = await generateOrderCode();

      const order = new Order({
        code,

        customerId: customer?._id || null,
        customerName: customer?.name || String(customerName || "").trim(),
        customerPhone: customer?.phone || String(customerPhone || "").trim(),
        customerAddress: customer?.address || String(customerAddress || "").trim(),

        items: orderItems,

        subtotal,
        discount: discountNumber,
        shippingFee: shippingNumber,
        totalAmount,
        paidAmount: paidNumber,
        debt,

        paymentMethod,
        status: "pending",
        stockDeducted: false,

        note: String(note || "").trim(),

        created_at: new Date(),
        updated_at: new Date(),
      });

      await order.save({ session });

      if (customer) {
        customer.totalOrders = toNumber(customer.totalOrders) + 1;
        customer.totalSpent = toNumber(customer.totalSpent) + paidNumber;
        customer.debt = toNumber(customer.debt) + debt;
        customer.updated_at = new Date();

        await customer.save({ session });
      }

      createdOrder = order;
    });

    return res.status(201).json({
      success: true,
      message: "Tạo đơn hàng thành công, chưa trừ tồn kho",
      order: createdOrder,
    });
  } catch (error) {
    console.error("createOrderAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Không thể tạo đơn hàng",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   ROLLBACK ORDER STOCK
========================================================= */

const rollbackOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu orderId",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "orderId không hợp lệ",
      });
    }

    let result = null;

    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.stockDeducted !== true) {
        throw new Error("Đơn hàng này hiện không có tồn kho đã bị trừ");
      }

      result = await restoreOrderStockFIFO({
        order,
        session,
      });

      order.updated_at = new Date();

      await order.save({ session });

      // Tính lại công nợ khách hàng từ các đơn còn hiệu lực.
      if (order.customerId) {
        const customer = await Customer.findById(order.customerId).session(
          session,
        );

        if (customer) {
          const customerOrders = await Order.find({
            customerId: customer._id,
            status: { $ne: "cancelled" },
            _id: { $ne: order._id },
          })
            .select("debt")
            .session(session)
            .lean();

          customer.debt = customerOrders.reduce(
            (sum, item) => sum + Math.max(0, toNumber(item.debt)),
            0,
          );

          customer.updated_at = new Date();

          await customer.save({ session });
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: "Rollback tồn kho thành công",
      historyRecords: result?.historyRecords || 0,
      restoredQty: result?.restoredQty || 0,
    });
  } catch (error) {
    console.error("rollbackOrderStockAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Không thể rollback tồn kho",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   SYNC ONE PRODUCT PRICE TO ORDERS
========================================================= */

const syncProductPriceToOrders = async ({
  productId,
  variantName = "",
  variantCode = "",
  newPrice,
}) => {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    throw new Error("productId không hợp lệ");
  }

  const price = Number(newPrice);

  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Giá mới không hợp lệ");
  }

  const cleanVariantName = normalizeVariantName(variantName);

  const cleanVariantCode = normalizeVariantCode(variantCode);

  const orders = await Order.find({
    status: { $in: UNCOMPLETED_STATUSES },
    "items.productId": productId,
  });

  let updatedOrders = 0;
  let updatedItems = 0;

  for (const order of orders) {
    let changed = false;

    for (const item of order.items || []) {
      if (String(item.productId) !== String(productId)) {
        continue;
      }

      const itemCode = normalizeVariantCode(item.variantCode);

      const itemName = normalizeVariantName(item.variantName);

      let matched = false;

      if (cleanVariantCode) {
        matched = itemCode === cleanVariantCode;
      } else if (cleanVariantName) {
        matched = !itemCode && itemName === cleanVariantName;
      } else {
        matched = !itemCode && !itemName;
      }

      if (!matched) continue;

      if (toNumber(item.price) !== price) {
        item.price = price;
        item.total = toNumber(item.qty) * price;

        changed = true;
        updatedItems++;
      }
    }

    if (!changed) continue;

    calculateOrderTotal(order);
    order.markModified("items");

    await order.save();

    updatedOrders++;
  }

  return {
    updatedOrders,
    updatedItems,
  };
};

/* =========================================================
   SYNC ALL UNCOMPLETED ORDER PRICES
========================================================= */

const syncAllUncompletedOrderPricesAsync = async (req, res) => {
  try {
    const orders = await Order.find({
      status: { $in: UNCOMPLETED_STATUSES },
    });

    let updatedOrders = 0;
    let updatedItems = 0;

    for (const order of orders) {
      let orderChanged = false;

      for (const item of order.items || []) {
        if (
          !item.productId ||
          !mongoose.Types.ObjectId.isValid(item.productId)
        ) {
          continue;
        }

        const product = await Product.findById(item.productId).lean();

        if (!product) continue;

        const { price, variant } = getProductPrice(
          product,
          item.variantName,
          item.variantCode,
        );

        if (price === null) continue;

        const oldPrice = toNumber(item.price);

        if (oldPrice !== price) {
          item.price = price;
          item.total = toNumber(item.qty) * price;

          orderChanged = true;
          updatedItems++;
        }

        // Cập nhật snapshot tên và mã biến thể.
        if (variant) {
          const currentName = normalizeVariantName(item.variantName);

          const currentCode = normalizeVariantCode(item.variantCode);

          const nextName = normalizeVariantName(variant.name);

          const nextCode = normalizeVariantCode(variant.variantCode);

          if (currentName !== nextName) {
            item.variantName = nextName;
            orderChanged = true;
          }

          if (currentCode !== nextCode) {
            item.variantCode = nextCode;
            orderChanged = true;
          }

          const defaultPrice = toNumber(variant.defaultPrice);

          if (toNumber(item.defaultPrice) !== defaultPrice) {
            item.defaultPrice = defaultPrice;
            orderChanged = true;
          }
        }

        if (product.title && item.productTitle !== product.title) {
          item.productTitle = product.title;
          orderChanged = true;
        }

        const productCode = getProductCode(product);

        if (productCode && item.productCode !== productCode) {
          item.productCode = productCode;
          orderChanged = true;
        }
      }

      if (!orderChanged) continue;

      calculateOrderTotal(order);
      order.markModified("items");

      await order.save();

      updatedOrders++;
    }

    return res.status(200).json({
      success: true,
      message: "Đồng bộ giá đơn hàng thành công",
      updatedOrders,
      updatedItems,
    });
  } catch (error) {
    console.error("syncAllUncompletedOrderPricesAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể đồng bộ giá đơn hàng",
    });
  }
};

/* =========================================================
   GET ORDER BY ID
========================================================= */

const getOrderByIdAsync = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID đơn hàng không hợp lệ",
      });
    }

    const order = await Order.findById(id).populate("customerId").lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    const [enrichedOrder] = await enrichOrdersWithCost([order]);

    return res.status(200).json({
      success: true,
      order: enrichedOrder,
    });
  } catch (error) {
    console.error("getOrderByIdAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy đơn hàng",
    });
  }
};

/* =========================================================
   LIST ORDERS
========================================================= */

const listOrdersAsync = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const skip = (page - 1) * limit;

    const search = String(req.query.search || "").trim();

    const status = String(req.query.status || "").trim();

    const fromDate = String(req.query.fromDate || "").trim();

    const toDate = String(req.query.toDate || "").trim();

    const filter = {};
    // Mini App truyền số điện thoại để chỉ nhận đơn của đúng khách hàng.
    const customerPhone = String(req.query.phone || "").trim();
    if (customerPhone) filter.customerPhone = customerPhone;

    if (status) {
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Trạng thái đơn hàng không hợp lệ",
        });
      }

      filter.status = status;
    }

    if (search) {
      const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      filter.$or = [
        {
          code: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          customerName: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          customerPhone: {
            $regex: safeSearch,
            $options: "i",
          },
        },
      ];
    }

    if (fromDate || toDate) {
      const createdAtFilter = {};

      if (fromDate) {
        const startDate = new Date(`${fromDate}T00:00:00+07:00`);

        if (Number.isNaN(startDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Ngày bắt đầu không hợp lệ",
          });
        }

        createdAtFilter.$gte = startDate;
      }

      if (toDate) {
        const endDate = new Date(`${toDate}T23:59:59.999+07:00`);

        if (Number.isNaN(endDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Ngày kết thúc không hợp lệ",
          });
        }

        createdAtFilter.$lte = endDate;
      }

      filter.created_at = createdAtFilter;
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Order.countDocuments(filter),
    ]);

    const enrichedOrders = await enrichOrdersWithCost(orders);

    return res.status(200).json({
      success: true,
      orders: enrichedOrders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error("listOrdersAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách đơn hàng",
    });
  }
};

/* =========================================================
   UPDATE ORDER STATUS

   completed:
   - Xuất kho FIFO.

   cancelled:
   - Nếu đã trừ kho thì hoàn lại đúng lô.

   pending / confirmed / shipping:
   - Không trừ kho.
========================================================= */

const updateOrderStatusAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id } = req.params;
    const { status: newStatus } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID đơn hàng không hợp lệ",
      });
    }

    if (!ALLOWED_STATUSES.includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: "Trạng thái đơn hàng không hợp lệ",
      });
    }

    let updatedOrder = null;
    let stockResult = null;

    await session.withTransaction(async () => {
      const order = await Order.findById(id).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.status === newStatus) {
        updatedOrder = order;
        return;
      }

      // Hoàn tất đơn: xuất kho FIFO
      if (newStatus === "completed" && order.stockDeducted !== true) {
        stockResult = await deductOrderStockFIFO({
          order,
          session,
          userId: req.user?._id || null,
        });
      }

      // Hủy đơn: hoàn kho nếu đã xuất kho
      if (newStatus === "cancelled" && order.stockDeducted === true) {
        stockResult = await restoreOrderStockFIFO({
          order,
          session,
        });
      }

      // Hủy đơn: đưa số tiền thanh toán và công nợ về 0
      if (newStatus === "cancelled") {
        order.paidAmount = 0;
        order.debt = 0;
      }

      order.status = newStatus;
      order.updated_at = new Date();

      await order.save({ session });

      updatedOrder = order;
    });

    return res.status(200).json({
      success: true,
      message:
        newStatus === "completed"
          ? "Xác nhận hoàn tất và xuất kho FIFO thành công"
          : newStatus === "cancelled"
            ? "Hủy đơn hàng, hoàn kho và đưa thanh toán về 0 thành công"
            : "Cập nhật trạng thái đơn hàng thành công",
      order: updatedOrder,
      stock: stockResult,
    });
  } catch (error) {
    console.error("updateOrderStatusAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Không thể cập nhật trạng thái đơn hàng",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   SYNC PRODUCT PRICE API
   Hỗ trợ variantCode và variantName.
========================================================= */

const syncProductPriceAsync = async (req, res) => {
  try {
    const { productId, variantName = "", variantCode = "" } = req.body || {};

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const product = await Product.findById(productId).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    const { price: newPrice, variant } = getProductPrice(
      product,
      variantName,
      variantCode,
    );

    if (newPrice === null) {
      return res.status(404).json({
        success: false,
        message: `Không tìm thấy biến thể "${variantCode || variantName}"`,
      });
    }

    if (!Number.isFinite(newPrice) || newPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "Giá sản phẩm không hợp lệ",
      });
    }

    const result = await syncProductPriceToOrders({
      productId,
      variantName: variant?.name || variantName,
      variantCode: variant?.variantCode || variantCode,
      newPrice,
    });

    return res.status(200).json({
      success: true,
      message: "Đồng bộ giá thành công",
      data: {
        productId,
        variantName: variant?.name || null,
        variantCode: variant?.variantCode || null,
        newPrice,
        ...result,
      },
    });
  } catch (error) {
    console.error("syncProductPriceAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Lỗi đồng bộ giá",
    });
  }
};

/* =========================================================
   PAY ORDER DEBT
========================================================= */

const payOrderDebtAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId, amount } = req.body || {};

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "orderId không hợp lệ",
      });
    }

    const paymentAmount = Number(amount);

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Số tiền thanh toán không hợp lệ",
      });
    }

    let responseData = null;

    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.status === "cancelled") {
        throw new Error("Không thể thu công nợ của đơn đã hủy");
      }

      const totalAmount = toNumber(order.totalAmount);

      const paidAmount = toNumber(order.paidAmount);

      const currentDebt = Math.max(totalAmount - paidAmount, 0);

      if (currentDebt <= 0) {
        throw new Error("Đơn hàng không còn công nợ");
      }

      if (paymentAmount > currentDebt) {
        throw new Error("Số tiền thanh toán lớn hơn công nợ");
      }

      order.paidAmount = paidAmount + paymentAmount;

      order.debt = Math.max(totalAmount - order.paidAmount, 0);

      order.paymentStatus = order.debt === 0 ? "paid" : "partial";

      order.updated_at = new Date();

      await order.save({ session });

      if (order.customerId) {
        const customer = await Customer.findById(order.customerId).session(
          session,
        );

        if (customer) {
          const customerOrders = await Order.find({
            customerId: customer._id,
            status: { $ne: "cancelled" },
          })
            .select("debt")
            .session(session)
            .lean();

          customer.debt = customerOrders.reduce(
            (sum, item) => sum + Math.max(0, toNumber(item.debt)),
            0,
          );

          customer.updated_at = new Date();

          await customer.save({ session });
        }
      }

      responseData = {
        orderId: order._id,
        totalAmount,
        paidAmount: order.paidAmount,
        debt: order.debt,
        paymentStatus: order.paymentStatus,
      };
    });

    return res.status(200).json({
      success: true,
      message:
        responseData.debt === 0
          ? "Đã hoàn thành công nợ"
          : "Đã thanh toán một phần công nợ",
      data: responseData,
    });
  } catch (error) {
    console.error("payOrderDebtAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Lỗi thanh toán công nợ",
    });
  } finally {
    await session.endSession();
  }
};

/* =========================================================
   SYNC ORDER VARIANTS
   Bổ sung defaultPrice và variantCode vào order.
========================================================= */

const syncOrderVariantsAsync = async (req, res) => {
  try {
    const orderItem = req.body.orderId || {};
    const orderId = orderItem._id ?? "";

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: "orderId không hợp lệ",
      });
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy order",
      });
    }

    let updatedItems = 0;
    let skippedItems = 0;

    for (const item of order.items || []) {
      if (!item.productId) {
        skippedItems++;
        continue;
      }

      const product = await Product.findById(item.productId).lean();

      if (!product) {
        skippedItems++;
        continue;
      }

      const variantName = normalizeVariantName(item.variantName);

      const variantCode = normalizeVariantCode(item.variantCode);

      if (!variantName && !variantCode) {
        skippedItems++;
        continue;
      }

      const variant = findVariant(product, variantName, variantCode);

      if (!variant) {
        skippedItems++;
        continue;
      }

      const defaultPrice = Number(variant.defaultPrice);

      const price = Number(variant.price);

      if (!Number.isFinite(defaultPrice) || !Number.isFinite(price)) {
        skippedItems++;
        continue;
      }

      item.variantCode = normalizeVariantCode(variant.variantCode);

      item.variantName = normalizeVariantName(variant.name);

      item.defaultPrice = defaultPrice;
      item.price = price;
      item.total = price * toNumber(item.qty);

      updatedItems++;
    }

    if (updatedItems > 0) {
      calculateOrderTotal(order);
      order.markModified("items");
      await order.save();
    }

    return res.status(200).json({
      success: true,
      message: "Đã đồng bộ variantCode và defaultPrice vào đơn hàng",
      data: {
        orderId,
        updatedItems,
        skippedItems,
        order,
      },
    });
  } catch (error) {
    console.error("syncOrderVariantsAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Lỗi đồng bộ biến thể đơn hàng",
    });
  }
};

/* =========================================================
   CUSTOMER PURCHASE STATISTICS
========================================================= */

const getCustomerPurchaseStatsAsync = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));

    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const orders = await Order.find({
      status: { $ne: "cancelled" },
    })
      .sort({ created_at: -1 })
      .lean();

    const customersMap = new Map();

    for (const order of orders) {
      const customerName = String(order.customerName || "Khách lẻ").trim();

      const customerPhone = String(order.customerPhone || "").trim();

      const customerKey = customerPhone
        ? `phone:${customerPhone}`
        : `name:${customerName.toLowerCase()}`;

      if (!customersMap.has(customerKey)) {
        customersMap.set(customerKey, {
          customerName,
          customerPhone,
          orderCount: 0,
          totalQty: 0,
          totalSpent: 0,
          totalPaid: 0,
          totalDebt: 0,
          lastOrderAt: null,
          productsMap: new Map(),
        });
      }

      const customer = customersMap.get(customerKey);

      customer.orderCount++;
      customer.totalSpent += toNumber(order.totalAmount);
      customer.totalPaid += toNumber(order.paidAmount);
      customer.totalDebt += toNumber(order.debt);

      const orderDate = order.created_at || order.createdAt;

      if (
        orderDate &&
        (!customer.lastOrderAt ||
          new Date(orderDate) > new Date(customer.lastOrderAt))
      ) {
        customer.lastOrderAt = orderDate;
      }

      for (const item of order.items || []) {
        const qty = toNumber(item.qty);
        const price = toNumber(item.price);

        const productTitle = item.productTitle || item.title || "Sản phẩm";

        const productCode = item.productCode || "";

        const variantName = normalizeVariantName(item.variantName);

        const variantCode = normalizeVariantCode(item.variantCode);

        const productKey = [
          String(item.productId || ""),
          productCode,
          variantCode || variantName,
        ].join("|");

        if (!customer.productsMap.has(productKey)) {
          customer.productsMap.set(productKey, {
            productId: item.productId || null,
            productTitle,
            productCode,
            variantName,
            variantCode,
            totalQty: 0,
            totalAmount: 0,
            orderCount: 0,
          });
        }

        const product = customer.productsMap.get(productKey);

        product.totalQty += qty;

        product.totalAmount += toNumber(item.total) || price * qty;

        product.orderCount++;

        customer.totalQty += qty;
      }
    }

    let customers = Array.from(customersMap.values()).map((customer) => {
      const products = Array.from(customer.productsMap.values());

      return {
        customerName: customer.customerName,
        customerPhone: customer.customerPhone,
        orderCount: customer.orderCount,
        totalQty: customer.totalQty,
        totalSpent: customer.totalSpent,
        totalPaid: customer.totalPaid,
        totalDebt: customer.totalDebt,
        lastOrderAt: customer.lastOrderAt,
        products,
        productDetails: products,
      };
    });

    if (search) {
      customers = customers.filter(
        (customer) =>
          customer.customerName.toLowerCase().includes(search) ||
          customer.customerPhone.toLowerCase().includes(search),
      );
    }

    const totalCustomers = customers.length;
    const totalPages = Math.ceil(totalCustomers / limit);

    const data = customers.slice((page - 1) * limit, page * limit);

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        totalCustomers,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    console.error("getCustomerPurchaseStatsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể thống kê sản phẩm khách hàng đã mua",
      error: error.message,
    });
  }
};

/* =========================================================
   BEST SELLING PRODUCTS

   Nhóm biến thể theo variantCode.
   Legacy: chỉ dùng variantName khi không có code.
========================================================= */

const getBestSellingProductsAsync = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 20),
    );

    const search = String(req.query.search || "").trim();

    const type = String(req.query.type || "").trim();

    const categoryId = String(req.query.categoryId || "").trim();

    const fromDate = String(req.query.fromDate || "").trim();

    const toDate = String(req.query.toDate || "").trim();

    const sortBy = req.query.sortBy === "revenue" ? "revenue" : "qty";

    const match = {
      stockDeducted: true,
      status: { $ne: "cancelled" },
    };

    const validDate = /^\d{4}-\d{2}-\d{2}$/;

    if (
      (fromDate && !validDate.test(fromDate)) ||
      (toDate && !validDate.test(toDate))
    ) {
      return res.status(400).json({
        success: false,
        message: "Ngày phải có định dạng YYYY-MM-DD",
      });
    }

    if (fromDate || toDate) {
      match.created_at = {};

      if (fromDate) {
        match.created_at.$gte = new Date(`${fromDate}T00:00:00+07:00`);
      }

      if (toDate) {
        match.created_at.$lte = new Date(`${toDate}T23:59:59.999+07:00`);
      }

      if (
        Object.values(match.created_at).some((date) =>
          Number.isNaN(date.getTime()),
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Ngày không hợp lệ",
        });
      }
    }

    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({
        success: false,
        message: "categoryId không hợp lệ",
      });
    }

    const numeric = (field) => ({
      $convert: {
        input: field,
        to: "double",
        onError: 0,
        onNull: 0,
      },
    });

    const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const pipeline = [
      { $match: match },
      { $unwind: "$items" },

      {
        $match: {
          "items.productId": { $ne: null },
        },
      },

      {
        $addFields: {
          itemQty: numeric("$items.qty"),
          itemRevenue: {
            $multiply: [numeric("$items.qty"), numeric("$items.price")],
          },
          itemVariantCode: {
            $ifNull: ["$items.variantCode", ""],
          },
          itemVariantName: {
            $ifNull: ["$items.variantName", ""],
          },
        },
      },

      {
        $match: {
          itemQty: { $gt: 0 },
        },
      },

      {
        $group: {
          _id: {
            productId: "$items.productId",

            // Mã là khóa chính; legacy dùng tên.
            variantKey: {
              $cond: [
                {
                  $ne: ["$itemVariantCode", ""],
                },
                {
                  $concat: ["CODE:", "$itemVariantCode"],
                },
                {
                  $concat: ["NAME:", "$itemVariantName"],
                },
              ],
            },

            variantCode: "$itemVariantCode",
            variantName: "$itemVariantName",
          },

          productTitle: {
            $last: "$items.productTitle",
          },

          productCode: {
            $last: "$items.productCode",
          },

          thumbnail: {
            $last: "$items.thumbnail",
          },

          soldQty: {
            $sum: "$itemQty",
          },

          revenue: {
            $sum: "$itemRevenue",
          },

          orderIds: {
            $addToSet: "$_id",
          },
        },
      },

      {
        $group: {
          _id: "$_id.productId",

          productTitle: {
            $last: "$productTitle",
          },

          productCode: {
            $last: "$productCode",
          },

          thumbnail: {
            $last: "$thumbnail",
          },

          soldQty: {
            $sum: "$soldQty",
          },

          revenue: {
            $sum: "$revenue",
          },

          orderIdArrays: {
            $push: "$orderIds",
          },

          variants: {
            $push: {
              variantKey: "$_id.variantKey",
              variantCode: "$_id.variantCode",
              name: "$_id.variantName",
              soldQty: "$soldQty",
              revenue: "$revenue",
            },
          },
        },
      },

      {
        $addFields: {
          orderCount: {
            $size: {
              $reduce: {
                input: "$orderIdArrays",
                initialValue: [],
                in: {
                  $setUnion: ["$$value", "$$this"],
                },
              },
            },
          },
        },
      },

      {
        $lookup: {
          from: Product.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },

      {
        $unwind: {
          path: "$product",
          preserveNullAndEmptyArrays: true,
        },
      },

      {
        $addFields: {
          productTitle: {
            $ifNull: ["$product.title", "$productTitle"],
          },

          productCode: {
            $ifNull: ["$product.code", "$productCode"],
          },

          thumbnail: {
            $ifNull: ["$product.thumbnail", "$thumbnail"],
          },

          stockQty: {
            $ifNull: ["$product.qty", 0],
          },

          type: "$product.type",
          categoryId: "$product.categoryId",

          variants: {
            $map: {
              input: "$variants",
              as: "v",
              in: {
                name: "$$v.name",
                variantCode: "$$v.variantCode",
                soldQty: "$$v.soldQty",
                revenue: "$$v.revenue",

                stockQty: {
                  $let: {
                    vars: {
                      matchingByCode: {
                        $filter: {
                          input: {
                            $ifNull: ["$product.variants", []],
                          },
                          as: "pv",
                          cond: {
                            $and: [
                              {
                                $ne: ["$$v.variantCode", ""],
                              },
                              {
                                $eq: ["$$pv.variantCode", "$$v.variantCode"],
                              },
                            ],
                          },
                        },
                      },

                      matchingByName: {
                        $filter: {
                          input: {
                            $ifNull: ["$product.variants", []],
                          },
                          as: "pv",
                          cond: {
                            $and: [
                              {
                                $eq: ["$$v.variantCode", ""],
                              },
                              {
                                $eq: ["$$pv.name", "$$v.name"],
                              },
                            ],
                          },
                        },
                      },
                    },

                    in: {
                      $ifNull: [
                        {
                          $arrayElemAt: [
                            {
                              $cond: [
                                {
                                  $ne: ["$$v.variantCode", ""],
                                },
                                "$$matchingByCode",
                                "$$matchingByName",
                              ],
                            },
                            0,
                          ],
                        },
                        {},
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },

      // Lấy qty từ biến thể tương ứng.
      {
        $addFields: {
          variants: {
            $map: {
              input: "$variants",
              as: "v",
              in: {
                name: "$$v.name",
                variantCode: "$$v.variantCode",
                soldQty: "$$v.soldQty",
                revenue: "$$v.revenue",
                stockQty: {
                  $ifNull: ["$$v.stockQty.qty", 0],
                },
              },
            },
          },
        },
      },

      ...(type ? [{ $match: { type } }] : []),

      ...(categoryId
        ? [
            {
              $match: {
                categoryId: new mongoose.Types.ObjectId(categoryId),
              },
            },
          ]
        : []),

      ...(search
        ? [
            {
              $match: {
                $or: [
                  {
                    productTitle: {
                      $regex: safeSearch,
                      $options: "i",
                    },
                  },
                  {
                    productCode: {
                      $regex: safeSearch,
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),

      {
        $project: {
          product: 0,
          orderIdArrays: 0,
        },
      },

      {
        $sort: {
          [sortBy === "revenue" ? "revenue" : "soldQty"]: -1,
          _id: 1,
        },
      },

      {
        $facet: {
          rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],

          summary: [
            {
              $group: {
                _id: null,
                totalProducts: { $sum: 1 },
                totalSold: { $sum: "$soldQty" },
                totalRevenue: { $sum: "$revenue" },
              },
            },
          ],

          top10: [
            { $limit: 10 },
            {
              $project: {
                productTitle: 1,
                productCode: 1,
                soldQty: 1,
                revenue: 1,
              },
            },
          ],
        },
      },
    ];

    const [result] = await Order.aggregate(pipeline).allowDiskUse(true);

    const summary = result?.summary?.[0] || {
      totalProducts: 0,
      totalSold: 0,
      totalRevenue: 0,
    };

    return res.json({
      success: true,
      data: result?.rows || [],
      summary,
      top10: result?.top10 || [],

      pagination: {
        page,
        limit,
        total: summary.totalProducts,
        totalPages: Math.ceil(summary.totalProducts / limit),
      },
    });
  } catch (error) {
    console.error("getBestSellingProductsAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể thống kê sản phẩm bán chạy",
    });
  }
};

/* =========================================================
   EXPORT
========================================================= */

module.exports = {
  createOrderAsync,
  getOrderByIdAsync,
  listOrdersAsync,
  updateOrderStatusAsync,

  syncProductPriceAsync,
  syncAllUncompletedOrderPricesAsync,
  syncProductPriceToOrders,

  syncOrderStockAsync,
  rollbackOrderStockAsync,

  payOrderDebtAsync,
  syncOrderVariantsAsync,
  rebuildProductSoldQtyAsync,

  getCustomerPurchaseStatsAsync,
  getBestSellingProductsAsync,
};
