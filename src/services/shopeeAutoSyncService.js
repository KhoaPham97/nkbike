const mongoose = require("mongoose");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");

const { Product } = require("../models/products");
const InventoryBatch = require("../models/InventoryBatch");
const InventoryHistory = require("../models/inventoryHistory");

const { getShopeeOrders } = require("./shopeeService");

// =====================================================
// CONFIG
// =====================================================

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const LOOKBACK_DAYS = 7;

// =====================================================
// COMMON HELPERS
// =====================================================

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function getItemKey(item) {
  return `${toText(item.itemId || "0")}_${toText(item.modelId || "0")}`;
}

function normalizeShopeeStatus(status) {
  return toText(status).toUpperCase();
}

function getShopeeItems(order) {
  return order.item_list || order.items || order.order_items || [];
}

function toShopeeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const number = Number(value);

  if (Number.isFinite(number) && number > 0) {
    return new Date(number < 1e12 ? number * 1000 : number);
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getRequiredQty(item) {
  const quantity = Math.max(0, toNumber(item.quantity));
  const multiplier = Math.max(0.000001, toNumber(item.quantityMultiplier, 1));

  return Math.ceil(quantity * multiplier);
}

function isStockEligible(item) {
  return (
    item.mappingStatus === "mapped" &&
    item.allowStockDeduction === true &&
    Boolean(item.productId) &&
    Boolean(item.variantCode)
  );
}

function getVariant(product, variantCode) {
  if (!Array.isArray(product.variants)) return null;

  return product.variants.find(
    (variant) => toText(variant.variantCode) === toText(variantCode),
  );
}

function validateEligibleItem(item) {
  if (item.mappingStatus !== "mapped" || !item.allowStockDeduction) {
    return;
  }

  if (!item.productId) {
    throw new Error(
      `Đơn Shopee thiếu productId tại mặt hàng ${item.itemName || item.itemId}`,
    );
  }

  if (!item.variantCode) {
    throw new Error(
      `Đơn Shopee thiếu variantCode tại mặt hàng ${item.itemName || item.itemId}`,
    );
  }

  if (getRequiredQty(item) <= 0) {
    throw new Error(
      `Số lượng không hợp lệ tại mặt hàng ${item.itemName || item.itemId}`,
    );
  }
}

function getOrderStockStatus(items) {
  const eligibleItems = items.filter(isStockEligible);

  if (eligibleItems.length === 0) {
    return items.some((item) => item.mappingStatus !== "mapped")
      ? "unmapped"
      : "pending";
  }

  const allDeducted = eligibleItems.every(
    (item) => toNumber(item.deductedQty) >= getRequiredQty(item),
  );

  if (allDeducted) return "deducted";

  const hasDeducted = eligibleItems.some(
    (item) => toNumber(item.deductedQty) > 0,
  );

  if (hasDeducted) return "partially_deducted";

  const allCovered = eligibleItems.every(
    (item) =>
      toNumber(item.reservedQty) + toNumber(item.deductedQty) >=
      getRequiredQty(item),
  );

  return allCovered ? "ready" : "pending";
}
function normalizeInventoryBatchEnums(batch) {
  if (!batch) return;

  const sourceAliases = {
    IMPORT: "IMPORT",
    MANUAL: "IMPORT",
    OPENING: "OPENING",
    ADJUSTMENT: "ADJUSTMENT",
    RETURN: "RETURN",
    OTHER: "OTHER",
    HISTORICAL: "OTHER",
  };

  const confidenceAliases = {
    high: "high",
    medium: "medium",
    low: "low",
    recorded: "high",
    inferred: "medium",
    unknown: "low",
  };

  const source = toText(batch.source).toUpperCase();

  batch.source = sourceAliases[source] || "OTHER";

  const confidence = toText(batch.sourceConfidence).toLowerCase();

  batch.sourceConfidence = confidenceAliases[confidence] || "low";
}
// =====================================================
// NORMALIZE SHOPEE ORDER
// =====================================================

function normalizeOrder(order) {
  const items = getShopeeItems(order);
  const recipient = order.recipient_address || {};

  return {
    orderSn: toText(order.order_sn || order.orderSn),

    orderStatus: normalizeShopeeStatus(order.order_status || order.orderStatus),

    buyerUserId: toText(order.buyer_user_id || order.buyerUserId),

    buyerUsername: toText(order.buyer_username || order.buyerUsername),

    recipientName: toText(recipient.name || order.recipientName),

    recipientPhone: toText(recipient.phone || order.recipientPhone),

    recipientAddress: toText(recipient.full_address || order.recipientAddress),

    paymentMethod: toText(order.payment_method || order.paymentMethod),

    totalAmount: toNumber(order.total_amount ?? order.totalAmount),

    shippingCarrier: toText(order.shipping_carrier || order.shippingCarrier),

    createTime: toShopeeDate(order.create_time ?? order.createTime),

    updateTime: toShopeeDate(order.update_time ?? order.updateTime),

    items: items.map((item) => {
      const quantity = Math.max(
        0,
        toNumber(item.model_quantity_purchased ?? item.quantity),
      );

      const unitPrice = toNumber(
        item.model_discounted_price ?? item.discounted_price ?? item.unitPrice,
      );

      return {
        itemId: toText(item.item_id || item.itemId),

        modelId: toText(item.model_id || item.modelId || "0"),

        itemName: toText(item.item_name || item.itemName),

        modelName: toText(item.model_name || item.modelName),

        itemSku: toText(item.item_sku || item.itemSku),

        variationSku: toText(
          item.model_sku || item.variation_sku || item.variationSku,
        ),

        quantity,
        unitPrice,
        totalPrice: unitPrice * quantity,
      };
    }),

    rawData: order,
  };
}

// =====================================================
// MONGOOSE TRANSACTION HELPERS
// =====================================================

async function startTransaction() {
  const session = await mongoose.startSession();
  session.startTransaction();
  return session;
}

async function abortTransaction(session) {
  if (!session) return;

  try {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
  } finally {
    await session.endSession();
  }
}

async function commitTransaction(session) {
  try {
    await session.commitTransaction();
  } finally {
    await session.endSession();
  }
}

// =====================================================
// SKU MAPPING
// =====================================================

async function findShopeeMapping(shopId, item) {
  return ShopeeSkuMapping.findOne({
    shopId: String(shopId),
    itemId: String(item.itemId),
    modelId: String(item.modelId || "0"),
    isActive: true,
  }).lean();
}

function applyMappingSnapshot(item, mapping) {
  if (!mapping) {
    return {
      ...item,
      productId: null,
      variantCode: "",
      variantName: "",
      quantityMultiplier: 1,
      allowStockDeduction: false,
      mappingStatus: "unmapped",
    };
  }

  const hasMapping = Boolean(mapping.productId && mapping.variantCode);

  return {
    ...item,

    productId: mapping.productId || null,
    variantCode: toText(mapping.variantCode),
    variantName: toText(mapping.variantName),

    quantityMultiplier: Math.max(
      0.000001,
      toNumber(mapping.quantityMultiplier, 1),
    ),

    allowStockDeduction: mapping.allowStockDeduction === true,

    mappingStatus: hasMapping ? "mapped" : "unmapped",
  };
}

// =====================================================
// ORDER UPSERT
// =====================================================

async function upsertShopeeOrder(shopId, normalized) {
  let existing = await ShopeeOrder.findOne({
    shopId: String(shopId),
    orderSn: normalized.orderSn,
  });

  const oldItems = existing?.items || [];
  const nextItems = [];

  for (const newItem of normalized.items) {
    const oldItem = oldItems.find(
      (item) => getItemKey(item) === getItemKey(newItem),
    );

    if (oldItem) {
      // Giữ nguyên mapping snapshot của đơn đã tồn tại.
      nextItems.push({
        ...newItem,

        productId: oldItem.productId,
        variantCode: oldItem.variantCode,
        variantName: oldItem.variantName,

        mappingStatus: oldItem.mappingStatus,

        quantityMultiplier: Math.max(
          0.000001,
          toNumber(oldItem.quantityMultiplier, 1),
        ),

        allowStockDeduction: oldItem.allowStockDeduction === true,

        reservedQty: toNumber(oldItem.reservedQty),
        deductedQty: toNumber(oldItem.deductedQty),
        returnedQty: toNumber(oldItem.returnedQty),
      });

      continue;
    }

    const mapping = await findShopeeMapping(shopId, newItem);

    nextItems.push({
      ...applyMappingSnapshot(newItem, mapping),
      reservedQty: 0,
      deductedQty: 0,
      returnedQty: 0,
    });
  }

  const update = {
    shopId: String(shopId),
    orderSn: normalized.orderSn,
    orderStatus: normalized.orderStatus,

    buyerUserId: normalized.buyerUserId,
    buyerUsername: normalized.buyerUsername,

    recipientName: normalized.recipientName,
    recipientPhone: normalized.recipientPhone,
    recipientAddress: normalized.recipientAddress,

    paymentMethod: normalized.paymentMethod,
    totalAmount: normalized.totalAmount,
    shippingCarrier: normalized.shippingCarrier,

    createTime: normalized.createTime,
    updateTime: normalized.updateTime,

    items: nextItems,
    rawData: normalized.rawData,
    lastSyncedAt: new Date(),
  };

  existing = await ShopeeOrder.findOneAndUpdate(
    {
      shopId: String(shopId),
      orderSn: normalized.orderSn,
    },
    { $set: update },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    },
  );

  return existing;
}

// =====================================================
// INVENTORY HELPERS
// =====================================================

async function loadProductVariant(productId, variantCode, session) {
  const product = await Product.findById(productId).session(session);

  if (!product) {
    throw new Error(`Không tìm thấy sản phẩm ${productId}`);
  }

  const variant = getVariant(product, variantCode);

  if (!variant) {
    throw new Error(
      `Không tìm thấy biến thể ${variantCode} của ${product.title}`,
    );
  }

  return { product, variant };
}

async function saveProduct(product, session) {
  await product.save({ session });
}

async function findStockTransaction(idempotencyKey, session) {
  return ShopeeStockTransaction.findOne({
    idempotencyKey,
  }).session(session);
}

async function createStockTransaction({
  session,
  idempotencyKey,
  shopId,
  orderSn,
  returnSn = "",
  kind,
  allocations = [],
  totalQty = 0,
  note = "",
}) {
  if (totalQty <= 0) return null;

  const transaction = new ShopeeStockTransaction({
    idempotencyKey,
    shopId: String(shopId),
    orderSn,
    returnSn,
    kind,
    allocations,
    totalQty,
    status: "completed",
    note,
  });

  await transaction.save({ session });

  return transaction;
}

// =====================================================
// RESERVE STOCK
// READY_TO_SHIP / PROCESSED / SHIPPED
// =====================================================

async function reserveShopeeOrder(order) {
  const shopId = String(order.shopId);
  const orderSn = String(order.orderSn);

  const idempotencyKey = `SHOPEE:ORDER:${shopId}:${orderSn}:RESERVE`;

  const session = await startTransaction();

  try {
    const existed = await findStockTransaction(idempotencyKey, session);

    const freshOrder = await ShopeeOrder.findById(order._id).session(session);

    if (!freshOrder) {
      throw new Error("Không tìm thấy đơn Shopee");
    }

    if (existed) {
      await commitTransaction(session);
      return freshOrder;
    }

    const allocations = [];
    let totalQty = 0;

    for (const item of freshOrder.items) {
      if (!isStockEligible(item)) continue;

      validateEligibleItem(item);

      const requiredQty = getRequiredQty(item);
      const alreadyReserved = toNumber(item.reservedQty);
      const alreadyDeducted = toNumber(item.deductedQty);

      const needReserve = Math.max(
        0,
        requiredQty - alreadyReserved - alreadyDeducted,
      );

      if (needReserve <= 0) continue;

      const { product, variant } = await loadProductVariant(
        item.productId,
        item.variantCode,
        session,
      );

      const physicalQty = toNumber(variant.qty);
      const currentReserved = toNumber(variant.reservedQty);
      const availableQty = physicalQty - currentReserved;

      if (availableQty < needReserve) {
        throw new Error(
          `Không đủ tồn kho để giữ hàng: ${product.title} - ` +
            `${item.variantName}. Cần giữ ${needReserve}, ` +
            `còn khả dụng ${availableQty}`,
        );
      }

      variant.reservedQty = currentReserved + needReserve;

      await saveProduct(product, session);

      item.reservedQty = alreadyReserved + needReserve;

      allocations.push({
        productId: product._id,
        variantCode: item.variantCode,
        variantName: item.variantName,
        qty: needReserve,
        unitCost: toNumber(variant.unitCost),
        beforeQty: physicalQty,
        afterQty: physicalQty,
      });

      totalQty += needReserve;
    }

    await createStockTransaction({
      session,
      idempotencyKey,
      shopId,
      orderSn,
      kind: "order_reserve",
      allocations,
      totalQty,
      note: `Giữ hàng đơn Shopee ${orderSn}`,
    });

    freshOrder.stockStatus = getOrderStockStatus(freshOrder.items);

    if (totalQty > 0 && !freshOrder.stockReservedAt) {
      freshOrder.stockReservedAt = new Date();
    }

    await freshOrder.save({ session });

    await commitTransaction(session);

    return freshOrder;
  } catch (error) {
    await abortTransaction(session);
    throw error;
  }
}

// =====================================================
// FIFO BATCH QUERY
// Ưu tiên variantCode, hỗ trợ lô cũ chỉ có variantName.
// =====================================================

async function findFifoBatches(productId, item, session) {
  const variantCode = toText(item.variantCode);
  const variantName = toText(item.variantName);

  const query = {
    productId,
    remainingQty: { $gt: 0 },
    isActive: true,
    $or: [
      { variantCode },
      {
        variantName,
        $or: [
          { variantCode: "" },
          { variantCode: null },
          { variantCode: { $exists: false } },
        ],
      },
    ],
  };

  return InventoryBatch.find(query)
    .sort({
      importDate: 1,
      createdAt: 1,
      _id: 1,
    })
    .session(session);
}

// =====================================================
// FIFO BATCH DEDUCTION
// =====================================================

async function deductFromBatches({
  product,
  item,
  qty,
  session,
  orderSn,
  orderId,
  beforeVariantQty,
}) {
  let remaining = qty;

  const batches = await findFifoBatches(product._id, item, session);

  const availableInBatches = batches.reduce(
    (sum, batch) => sum + toNumber(batch.remainingQty),
    0,
  );

  if (availableInBatches < qty) {
    throw new Error(
      `Không đủ tồn kho FIFO: ${product.title} - ` +
        `${item.variantName}. Cần ${qty}, tồn trong lô ${availableInBatches}`,
    );
  }

  const allocations = [];
  let remainingVariantQty = toNumber(beforeVariantQty);

  for (const batch of batches) {
    if (remaining <= 0) break;

    const beforeBatchQty = toNumber(batch.remainingQty);
    const deductQty = Math.min(beforeBatchQty, remaining);

    batch.remainingQty = beforeBatchQty - deductQty;

    if (batch.remainingQty <= 0) {
      batch.remainingQty = 0;
      batch.isActive = false;
    }
    // Chuẩn hóa enum của dữ liệu lô cũ trước khi save.
    normalizeInventoryBatchEnums(batch);

    await batch.save({ session });

    const afterVariantQty = remainingVariantQty - deductQty;

    const history = new InventoryHistory({
      type: "export",
      referenceType: "shopee_order",
      referenceId: orderId,
      referenceCode: orderSn,

      productId: product._id,
      productTitle: product.title || "",
      productCode: product.code || "",

      variantName: item.variantName,

      batchId: batch._id,
      batchCode: batch.batchCode || "",

      unitCost: toNumber(batch.unitCost),

      qty: -deductQty,
      beforeQty: remainingVariantQty,
      afterQty: afterVariantQty,

      note:
        `Xuất FIFO đơn Shopee ${orderSn} - ` + `Lô ${batch.batchCode || ""}`,
    });

    await history.save({ session });

    allocations.push({
      productId: product._id,
      variantCode: item.variantCode,
      variantName: item.variantName,

      batchId: batch._id,
      batchCode: batch.batchCode || "",

      qty: deductQty,
      unitCost: toNumber(batch.unitCost),

      beforeQty: beforeBatchQty,
      afterQty: toNumber(batch.remainingQty),
    });

    remainingVariantQty = afterVariantQty;
    remaining -= deductQty;
  }

  if (remaining > 0) {
    throw new Error(`Không thể phân bổ đủ FIFO cho đơn ${orderSn}`);
  }

  return allocations;
}

// =====================================================
// DEDUCT STOCK
// CHỈ KHI COMPLETED
// =====================================================

async function deductShopeeOrder(order) {
  const shopId = String(order.shopId);
  const orderSn = String(order.orderSn);

  // Giữ nguyên key SHIP để nhận diện giao dịch cũ,
  // tránh xuất kho lần hai với các đơn đã xử lý trước đây.
  const idempotencyKey = `SHOPEE:ORDER:${shopId}:${orderSn}:SHIP`;

  const session = await startTransaction();

  try {
    const existed = await findStockTransaction(idempotencyKey, session);

    const freshOrder = await ShopeeOrder.findById(order._id).session(session);

    if (!freshOrder) {
      throw new Error("Không tìm thấy đơn Shopee");
    }

    if (normalizeShopeeStatus(freshOrder.orderStatus) !== "COMPLETED") {
      throw new Error("Chỉ được xuất kho khi đơn Shopee đã COMPLETED.");
    }

    if (existed) {
      freshOrder.stockDeducted = true;
      freshOrder.stockDeductedAt =
        freshOrder.stockDeductedAt || existed.createdAt || new Date();

      freshOrder.stockStatus = "deducted";

      await freshOrder.save({ session });

      await commitTransaction(session);

      return freshOrder;
    }

    const allocations = [];
    let totalQty = 0;

    for (const item of freshOrder.items) {
      if (!isStockEligible(item)) continue;

      validateEligibleItem(item);

      const requiredQty = getRequiredQty(item);
      const alreadyDeducted = toNumber(item.deductedQty);

      const needDeduct = Math.max(0, requiredQty - alreadyDeducted);

      if (needDeduct <= 0) continue;

      const { product, variant } = await loadProductVariant(
        item.productId,
        item.variantCode,
        session,
      );

      const physicalQty = toNumber(variant.qty);
      const totalReserved = toNumber(variant.reservedQty);

      const ownReserved = Math.min(toNumber(item.reservedQty), needDeduct);

      if (totalReserved < ownReserved) {
        throw new Error(
          `Số lượng giữ kho không hợp lệ: ${product.title} - ${item.variantName}`,
        );
      }

      const availableForThisOrder = physicalQty - totalReserved + ownReserved;

      if (availableForThisOrder < needDeduct) {
        throw new Error(
          `Không đủ tồn kho để xuất: ${product.title} - ` +
            `${item.variantName}. Cần ${needDeduct}, ` +
            `khả dụng cho đơn ${availableForThisOrder}`,
        );
      }

      const itemAllocations = await deductFromBatches({
        product,
        item,
        qty: needDeduct,
        session,
        orderSn,
        orderId: freshOrder._id,
        beforeVariantQty: physicalQty,
      });

      allocations.push(...itemAllocations);

      variant.qty = physicalQty - needDeduct;
      variant.reservedQty = totalReserved - ownReserved;

      product.qty = Math.max(0, toNumber(product.qty) - needDeduct);

      // Chỉ tăng số lượng bán khi đơn COMPLETED.
      // Đây là doanh số gộp; hàng hoàn được theo dõi riêng.
      product.soldQty = toNumber(product.soldQty) + needDeduct;

      await saveProduct(product, session);

      item.deductedQty = alreadyDeducted + needDeduct;

      item.reservedQty = Math.max(0, toNumber(item.reservedQty) - ownReserved);

      totalQty += needDeduct;
    }

    await createStockTransaction({
      session,
      idempotencyKey,
      shopId,
      orderSn,
      kind: "order_export",
      allocations,
      totalQty,
      note: `Xuất kho FIFO đơn Shopee ${orderSn}`,
    });

    freshOrder.stockStatus = getOrderStockStatus(freshOrder.items);

    const eligibleItems = freshOrder.items.filter(isStockEligible);

    const allDeducted =
      eligibleItems.length > 0 &&
      eligibleItems.every(
        (item) => toNumber(item.deductedQty) >= getRequiredQty(item),
      );

    freshOrder.stockDeducted = allDeducted;

    if (allDeducted) {
      freshOrder.stockDeductedAt = new Date();
    }

    await freshOrder.save({ session });

    await commitTransaction(session);

    return freshOrder;
  } catch (error) {
    await abortTransaction(session);
    throw error;
  }
}

// =====================================================
// RELEASE RESERVED STOCK
// CANCELLED
// =====================================================

async function releaseShopeeOrder(order) {
  const shopId = String(order.shopId);
  const orderSn = String(order.orderSn);

  const idempotencyKey = `SHOPEE:ORDER:${shopId}:${orderSn}:RELEASE`;

  const session = await startTransaction();

  try {
    const existed = await findStockTransaction(idempotencyKey, session);

    const freshOrder = await ShopeeOrder.findById(order._id).session(session);

    if (!freshOrder) {
      throw new Error("Không tìm thấy đơn Shopee");
    }

    if (existed) {
      await commitTransaction(session);
      return freshOrder;
    }

    const allocations = [];
    let totalQty = 0;

    for (const item of freshOrder.items) {
      if (!isStockEligible(item)) continue;

      const itemReserved = toNumber(item.reservedQty);

      if (itemReserved <= 0) continue;

      const { product, variant } = await loadProductVariant(
        item.productId,
        item.variantCode,
        session,
      );

      const currentReserved = toNumber(variant.reservedQty);

      if (currentReserved < itemReserved) {
        throw new Error(
          `Dữ liệu giữ hàng không khớp: ${product.title} - ${item.variantName}`,
        );
      }

      variant.reservedQty = currentReserved - itemReserved;

      await saveProduct(product, session);

      allocations.push({
        productId: product._id,
        variantCode: item.variantCode,
        variantName: item.variantName,
        qty: itemReserved,
        unitCost: toNumber(variant.unitCost),
        beforeQty: toNumber(variant.qty),
        afterQty: toNumber(variant.qty),
      });

      totalQty += itemReserved;
      item.reservedQty = 0;
    }

    await createStockTransaction({
      session,
      idempotencyKey,
      shopId,
      orderSn,
      kind: "order_release",
      allocations,
      totalQty,
      note: `Giải phóng hàng giữ của đơn Shopee ${orderSn}`,
    });

    freshOrder.stockStatus = getOrderStockStatus(freshOrder.items);

    freshOrder.stockReleasedAt = new Date();

    await freshOrder.save({ session });

    await commitTransaction(session);

    return freshOrder;
  } catch (error) {
    await abortTransaction(session);
    throw error;
  }
}

// =====================================================
// PROCESS ORDER STATUS
// =====================================================

async function processShopeeOrderStock(order) {
  const status = normalizeShopeeStatus(order.orderStatus);

  if (status === "IN_CANCEL") {
    // Đang yêu cầu hủy: chưa thay đổi giữ hàng.
    return order;
  }

  if (status === "CANCELLED") {
    // Chỉ giải phóng hàng còn giữ.
    // Không nhập lại hàng đã xuất kho.
    return releaseShopeeOrder(order);
  }

  if (
    status === "READY_TO_SHIP" ||
    status === "PROCESSED" ||
    status === "SHIPPED"
  ) {
    // SHIPPED vẫn chỉ giữ hàng, không xuất kho.
    // Trường hợp lần đầu đồng bộ đã ở SHIPPED vẫn giữ hàng.
    return reserveShopeeOrder(order);
  }

  if (status === "COMPLETED") {
    return deductShopeeOrder(order);
  }

  return order;
}

// =====================================================
// SYNC ONE SHOP
// =====================================================

async function syncOneShop(shop) {
  const shopId = String(shop.shopId);

  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - LOOKBACK_DAYS * 24 * 60 * 60;

  let cursor = "";
  let page = 0;

  const result = {
    shopId,
    fetched: 0,
    saved: 0,
    reserved: 0,
    deducted: 0,
    released: 0,
    errors: [],
  };

  do {
    page += 1;

    if (page > MAX_PAGES) {
      result.errors.push("Đã đạt giới hạn số trang đồng bộ.");
      break;
    }

    const response = await getShopeeOrders({
      shopId,
      timeFrom,
      timeTo: now,
      pageSize: PAGE_SIZE,
      cursor,
      timeRangeField: "update_time",
    });

    const orders = response.orderList || [];

    result.fetched += orders.length;

    for (const rawOrder of orders) {
      try {
        const normalized = normalizeOrder(rawOrder);

        if (!normalized.orderSn) {
          throw new Error("Đơn Shopee không có order_sn");
        }

        const order = await upsertShopeeOrder(shopId, normalized);

        result.saved += 1;

        const previousStockStatus = order.stockStatus;
        const previousReservedQty = order.items.reduce(
          (sum, item) => sum + toNumber(item.reservedQty),
          0,
        );

        const processed = await processShopeeOrderStock(order);

        const currentReservedQty = processed.items.reduce(
          (sum, item) => sum + toNumber(item.reservedQty),
          0,
        );

        if (
          currentReservedQty > previousReservedQty ||
          (processed.stockStatus === "ready" && previousStockStatus !== "ready")
        ) {
          result.reserved += 1;
        }

        if (
          processed.stockStatus === "deducted" &&
          previousStockStatus !== "deducted"
        ) {
          result.deducted += 1;
        }

        if (normalized.orderStatus === "CANCELLED" && previousReservedQty > 0) {
          result.released += 1;
        }
      } catch (error) {
        result.errors.push({
          orderSn: rawOrder.order_sn || rawOrder.orderSn || "",
          message: error.message || String(error),
        });

        console.error(
          `[Shopee Auto Sync] Lỗi đơn ${rawOrder.order_sn || ""}:`,
          error,
        );
      }
    }

    cursor = response.more ? response.nextCursor || "" : "";

    if (!response.more) break;
  } while (cursor);

  return result;
}

// =====================================================
// SYNC ALL CONNECTED SHOPS
// =====================================================

async function syncAllShopeeOrders() {
  const shops = await ShopeeShop.find({
    status: "connected",
  }).lean();

  const results = [];

  for (const shop of shops) {
    try {
      const result = await syncOneShop(shop);
      results.push(result);
    } catch (error) {
      results.push({
        shopId: shop.shopId,
        error: error.message || String(error),
      });

      console.error(`[Shopee Auto Sync] Lỗi shop ${shop.shopId}:`, error);
    }
  }

  return results;
}

// =====================================================
// RECEIVE RETURNED STOCK
// Nhập lại đúng lô đã xuất.
// Mặc định tiếp nhận toàn bộ số lượng còn có thể hoàn.
// =====================================================

async function receiveShopeeReturn(order, options = {}) {
  const shopId = String(order.shopId);
  const orderSn = String(order.orderSn);

  const returnSn = toText(options.returnSn);

  const idempotencyKey = `SHOPEE:ORDER:${shopId}:${orderSn}:RETURN`;
  const session = await startTransaction();

  try {
    const existed = await findStockTransaction(idempotencyKey, session);

    const freshOrder = await ShopeeOrder.findById(order._id).session(session);

    if (!freshOrder) {
      throw new Error("Không tìm thấy đơn Shopee.");
    }

    if (existed) {
      await commitTransaction(session);

      return {
        alreadyProcessed: true,
        transaction: existed,
        order: freshOrder,
      };
    }

    const exportTransaction = await findStockTransaction(
      `SHOPEE:ORDER:${shopId}:${orderSn}:SHIP`,
      session,
    );

    if (!exportTransaction) {
      throw new Error("Không tìm thấy giao dịch xuất kho FIFO của đơn.");
    }

    const exportAllocations = exportTransaction.allocations || [];

    if (!exportAllocations.length) {
      throw new Error("Giao dịch xuất kho không có dữ liệu phân bổ lô.");
    }

    const allocationGroups = new Map();

    for (const allocation of exportAllocations) {
      const key =
        `${String(allocation.productId)}_` +
        `${String(allocation.variantCode)}`;

      if (!allocationGroups.has(key)) {
        allocationGroups.set(key, []);
      }

      allocationGroups.get(key).push({
        ...(allocation.toObject?.() || allocation),
        remainingQty: toNumber(allocation.qty),
      });
    }

    const returnAllocations = [];
    let totalQty = 0;

    for (const item of freshOrder.items) {
      if (!isStockEligible(item)) continue;

      const deductedQty = toNumber(item.deductedQty);
      const returnedQty = toNumber(item.returnedQty);
      const needReturn = deductedQty - returnedQty;

      if (needReturn <= 0) continue;

      const key = `${String(item.productId)}_${String(item.variantCode)}`;

      const group = allocationGroups.get(key) || [];

      const groupAvailable = group.reduce(
        (sum, allocation) => sum + allocation.remainingQty,
        0,
      );

      if (groupAvailable < needReturn) {
        throw new Error(
          `Không đủ dữ liệu lô đã xuất để hoàn lại: ${item.variantName}`,
        );
      }

      const { product, variant } = await loadProductVariant(
        item.productId,
        item.variantCode,
        session,
      );

      let remaining = needReturn;

      for (const allocation of group) {
        if (remaining <= 0) break;
        if (allocation.remainingQty <= 0) continue;

        const batchQty = Math.min(allocation.remainingQty, remaining);

        const batch = await InventoryBatch.findOne({
          _id: allocation.batchId,
          productId: product._id,
        }).session(session);

        if (!batch) {
          throw new Error(
            `Không tìm thấy lô ${allocation.batchCode || allocation.batchId} để nhập hàng hoàn.`,
          );
        }

        const beforeBatchQty = toNumber(batch.remainingQty);

        batch.remainingQty = beforeBatchQty + batchQty;
        batch.isActive = true;
        // Chuẩn hóa enum của dữ liệu lô cũ trước khi save.
        normalizeInventoryBatchEnums(batch);

        await batch.save({ session });

        const beforeVariantQty = toNumber(variant.qty);
        const afterVariantQty = beforeVariantQty + batchQty;

        const history = new InventoryHistory({
          type: "import",
          referenceType: "shopee_return",
          referenceId: freshOrder._id,
          referenceCode: returnSn || orderSn,

          productId: product._id,
          productTitle: product.title || "",
          productCode: product.code || "",

          variantName: item.variantName,

          batchId: batch._id,
          batchCode: batch.batchCode || "",

          unitCost: toNumber(batch.unitCost),

          qty: batchQty,
          beforeQty: beforeVariantQty,
          afterQty: afterVariantQty,

          note:
            `Nhập hàng hoàn đơn Shopee ${orderSn} - ` +
            `Lô ${batch.batchCode || ""}. ` +
            toText(options.note),
        });

        await history.save({ session });

        returnAllocations.push({
          productId: product._id,
          variantCode: item.variantCode,
          variantName: item.variantName,

          batchId: batch._id,
          batchCode: batch.batchCode || "",

          qty: batchQty,
          unitCost: toNumber(batch.unitCost),

          beforeQty: beforeBatchQty,
          afterQty: toNumber(batch.remainingQty),
        });

        allocation.remainingQty -= batchQty;
        remaining -= batchQty;
        totalQty += batchQty;
      }

      if (remaining > 0) {
        throw new Error(`Không thể phân bổ đủ hàng hoàn: ${item.variantName}`);
      }

      variant.qty = toNumber(variant.qty) + needReturn;

      item.returnedQty = returnedQty + needReturn;

      product.qty = toNumber(product.qty) + needReturn;

      // Không giảm soldQty: soldQty là doanh số gộp.
      // Số lượng hoàn được lưu riêng ở item.returnedQty.

      await saveProduct(product, session);
    }

    if (totalQty <= 0) {
      throw new Error("Đơn không còn số lượng nào cần tiếp nhận hoàn.");
    }

    const transaction = await createStockTransaction({
      session,
      idempotencyKey,
      shopId,
      orderSn,
      returnSn,
      kind: "return_import",
      allocations: returnAllocations,
      totalQty,
      note:
        `Nhập hàng hoàn đơn Shopee ${orderSn}` +
        (returnSn ? ` - Mã hoàn ${returnSn}` : ""),
    });

    const allReturned = freshOrder.items
      .filter(isStockEligible)
      .every(
        (item) => toNumber(item.returnedQty) >= toNumber(item.deductedQty),
      );

    freshOrder.returnedQty = toNumber(freshOrder.returnedQty) + totalQty;

    freshOrder.returnReceived = allReturned;
    freshOrder.stockReturnedAt = new Date();

    // Không dùng stockStatus "returned" vì enum hiện tại
    // chỉ quản lý trạng thái giữ/xuất kho.
    freshOrder.stockStatus = getOrderStockStatus(freshOrder.items);

    await freshOrder.save({ session });

    await commitTransaction(session);

    return {
      alreadyProcessed: false,
      totalQty,
      transaction,
      order: freshOrder,
    };
  } catch (error) {
    await abortTransaction(session);
    throw error;
  }
}

async function refreshShopeeOrderMappings(order) {
  if (!order || !Array.isArray(order.items) || !order.items.length) {
    return order;
  }

  const itemIds = [
    ...new Set(order.items.map((item) => toText(item.itemId)).filter(Boolean)),
  ];

  if (!itemIds.length) return order;

  const mappings = await ShopeeSkuMapping.find({
    shopId: toText(order.shopId),
    itemId: { $in: itemIds },
  }).lean();

  const mappingMap = new Map();

  for (const mapping of mappings) {
    const key = `${toText(mapping.itemId)}_${toText(mapping.modelId)}`;
    mappingMap.set(key, mapping);
  }

  let changed = false;

  for (const item of order.items) {
    const key = `${toText(item.itemId)}_${toText(item.modelId)}`;
    const mapping = mappingMap.get(key);

    // Không tìm thấy mapping mới thì giữ snapshot cũ.
    if (!mapping) continue;

    const isActive = mapping.isActive !== false;

    const valid =
      isActive &&
      Boolean(mapping.productId) &&
      Boolean(toText(mapping.variantCode));

    item.productId = mapping.productId || null;
    item.variantCode = toText(mapping.variantCode);
    item.variantName = toText(mapping.variantName);

    item.quantityMultiplier = Math.max(
      1,
      toNumber(mapping.quantityMultiplier || 1),
    );

    item.mappingStatus = valid ? "mapped" : "unmapped";

    item.allowStockDeduction = valid && mapping.allowStockDeduction === true;

    changed = true;
  }

  if (changed) {
    await order.save();
  }

  return order;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  syncAllShopeeOrders,
  syncOneShop,

  reserveShopeeOrder,
  deductShopeeOrder,
  releaseShopeeOrder,
  receiveShopeeReturn,
  processShopeeOrderStock,
  refreshShopeeOrderMappings,
};
