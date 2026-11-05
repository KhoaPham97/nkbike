const mongoose = require("mongoose");

const { Product } = require("../models/products");
const InventoryBatch = require("../models/InventoryBatch");
const InventoryHistory = require("../models/inventoryHistory");

const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");
const ShopeeSkuMapping = require("../models/ShopeeSkuMapping");

// =====================================================
// 1. HELPERS
// =====================================================

function validateQty(qty, fieldName = "Số lượng") {
  const value = Number(qty);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} phải là số nguyên lớn hơn 0`);
  }

  return value;
}

function validateNonNegativeQty(qty, fieldName = "Số lượng") {
  const value = Number(qty);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} phải là số nguyên không âm`);
  }

  return value;
}

function makeItemKey(itemId, modelId) {
  return `${String(itemId)}_${String(modelId || "0")}`;
}

function getVariant(product, variantCode) {
  const code = String(variantCode || "").trim();

  const matches = (product.variants || []).filter(
    (variant) => String(variant.code || "").trim() === code,
  );

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Không tìm thấy biến thể có mã ${code}`
        : `Mã biến thể ${code} bị trùng trong sản phẩm`,
    );
  }

  return matches[0];
}

function recalculateProductQty(product) {
  product.qty = (product.variants || []).reduce(
    (sum, variant) => sum + Number(variant.qty || 0),
    0,
  );
}

function validateMultiplier(value) {
  const multiplier = Number(value || 1);

  if (!Number.isInteger(multiplier) || multiplier <= 0) {
    throw new Error("quantityMultiplier phải là số nguyên dương");
  }

  return multiplier;
}

async function getProductAndVariant({ productId, variantCode, session }) {
  if (!mongoose.isValidObjectId(productId)) {
    throw new Error("productId không hợp lệ");
  }

  const product = await Product.findById(productId).session(session);

  if (!product) {
    throw new Error("Không tìm thấy sản phẩm trong kho");
  }

  const variant = getVariant(product, variantCode);

  return { product, variant };
}

async function findExistingTransaction(idempotencyKey, session = null) {
  let query = ShopeeStockTransaction.findOne({ idempotencyKey });

  if (session) {
    query = query.session(session);
  }

  return query.lean();
}

async function saveHistory({
  session,
  type,
  referenceType,
  referenceId,
  referenceCode,
  product,
  variant,
  batch,
  qty,
  beforeQty,
  afterQty,
  note,
  createdBy,
}) {
  await InventoryHistory.create(
    [
      {
        type,
        referenceType,
        referenceId,
        referenceCode,

        productId: product._id,
        productTitle: product.title || "",
        productCode: variant.code || "",

        variantName: variant.name || "",

        batchId: batch?._id || null,
        batchCode: batch?.batchCode || "",

        unitCost: Number(batch?.unitCost || variant.unitCost || 0),

        qty,
        beforeQty,
        afterQty,

        note: note || "",
        createdBy: createdBy || null,
      },
    ],
    { session },
  );
}

function getOrderItem(order, itemKey) {
  return (order.items || []).find(
    (item) => makeItemKey(item.itemId, item.modelId) === String(itemKey),
  );
}

function getReturnItem(returnDoc, itemKey) {
  return (returnDoc.items || []).find(
    (item) => makeItemKey(item.itemId, item.modelId) === String(itemKey),
  );
}

// =====================================================
// 2. LẤY MAPPING SKU ĐANG HOẠT ĐỘNG
// =====================================================

async function getActiveShopeeMapping({ shopId, itemId, modelId, session }) {
  const mapping = await ShopeeSkuMapping.findOne({
    shopId: String(shopId),
    itemId: String(itemId),
    modelId: String(modelId || "0"),
    isActive: true,
  })
    .session(session)
    .lean();

  if (!mapping) {
    throw new Error("Không tìm thấy SKU mapping đang hoạt động");
  }

  if (!mapping.productId || !mapping.variantCode) {
    throw new Error("SKU mapping chưa liên kết sản phẩm và biến thể trong kho");
  }

  return {
    mapping,
    multiplier: validateMultiplier(mapping.quantityMultiplier),
  };
}

// =====================================================
// 3. LẤY HỆ SỐ QUY ĐỔI CHO ĐƠN HÀNG
//
// Nếu đã xuất một phần:
// - Ưu tiên snapshot trên đơn.
// - Không để việc đổi mapping làm thay đổi số lượng còn lại.
//
// Nếu chưa xuất:
// - Phải có mapping đang hoạt động.
// - Mapping phải khớp với dòng đơn.
// =====================================================

async function resolveOrderItemMapping({
  shopId,
  orderItem,
  productId,
  variantCode,
  session,
}) {
  const deductedQty = Number(orderItem.deductedQty || 0);

  const savedProductId = String(orderItem.productId || "");
  const savedVariantCode = String(orderItem.variantCode || "");

  const hasSnapshot =
    orderItem.quantityMultiplier !== undefined &&
    orderItem.quantityMultiplier !== null;

  const savedMultiplier = hasSnapshot
    ? validateMultiplier(orderItem.quantityMultiplier)
    : null;

  if (deductedQty > 0) {
    if (
      !savedMultiplier ||
      savedProductId !== String(productId) ||
      savedVariantCode !== String(variantCode)
    ) {
      throw new Error(
        "Đơn đã xuất một phần nhưng snapshot SKU không đầy đủ hoặc không khớp. Cần kiểm tra dữ liệu trước khi xuất tiếp.",
      );
    }

    return {
      multiplier: savedMultiplier,
      mapping: null,
    };
  }

  const { mapping, multiplier } = await getActiveShopeeMapping({
    shopId,
    itemId: orderItem.itemId,
    modelId: orderItem.modelId,
    session,
  });

  if (
    String(mapping.productId) !== String(productId) ||
    String(mapping.variantCode) !== String(variantCode)
  ) {
    throw new Error("SKU mapping hiện tại không khớp với sản phẩm xuất kho");
  }

  if (hasSnapshot && savedMultiplier !== multiplier) {
    throw new Error(
      "Hệ số quy đổi SKU đã thay đổi so với snapshot trên đơn. Vui lòng kiểm tra mapping.",
    );
  }

  return {
    multiplier,
    mapping,
  };
}

// =====================================================
// 4. CẬP NHẬT TRẠNG THÁI XUẤT KHO ĐƠN
//
// deductedQty: đơn vị kho thực tế.
// quantity: số lượng mua trên Shopee.
// quantityMultiplier: hệ số quy đổi đã snapshot.
// =====================================================

async function updateOrderStockStatus({ order, session, createdBy }) {
  const items = order.items || [];

  if (!items.length) {
    order.stockStatus = "blocked";
    await order.save({ session });
    return;
  }

  if (order.stockStatus === "blocked") {
    await order.save({ session });
    return;
  }

  let totalOrderedStockQty = 0;
  let totalDeductedStockQty = 0;

  let allMapped = true;
  let allDeducted = true;

  for (const item of items) {
    const quantity = validateNonNegativeQty(
      item.quantity || 0,
      "Số lượng Shopee",
    );

    const multiplier = validateMultiplier(item.quantityMultiplier || 1);

    const deductedQty = validateNonNegativeQty(
      item.deductedQty || 0,
      "Số lượng đã xuất",
    );

    const requiredQty = quantity * multiplier;

    if (deductedQty > requiredQty) {
      throw new Error(
        `Số lượng đã xuất vượt số lượng đặt của SKU ${item.itemId}`,
      );
    }

    totalOrderedStockQty += requiredQty;
    totalDeductedStockQty += deductedQty;

    const mapped = Boolean(
      item.mappingStatus === "mapped" && item.productId && item.variantCode,
    );

    if (!mapped) {
      allMapped = false;
      allDeducted = false;
    }

    if (deductedQty < requiredQty) {
      allDeducted = false;
    }
  }

  if (allMapped && allDeducted && totalOrderedStockQty > 0) {
    order.stockStatus = "deducted";

    if (!order.stockDeductedAt) {
      order.stockDeductedAt = new Date();
      order.stockDeductedBy = createdBy || null;
    }
  } else if (totalDeductedStockQty > 0) {
    order.stockStatus = "partially_deducted";
  } else {
    order.stockStatus = allMapped ? "ready" : "unmapped";
  }

  await order.save({ session });
}

// =====================================================
// 5. XUẤT KHO ĐƠN SHOPEE - FIFO
//
// qty: số lượng kho thực tế cần xuất.
// Không phải số lượng Shopee.
// =====================================================

async function exportShopeeOrderItem({
  shopId,
  orderSn,
  itemKey,
  productId,
  variantCode,
  qty,
  idempotencyKey,
  createdBy,
  note = "",
}) {
  qty = validateQty(qty, "Số lượng xuất");

  if (
    !shopId ||
    !orderSn ||
    !itemKey ||
    !productId ||
    !variantCode ||
    !idempotencyKey
  ) {
    throw new Error("Thiếu thông tin giao dịch xuất kho Shopee");
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      // 1. Kiểm tra giao dịch trùng.
      const existing = await findExistingTransaction(idempotencyKey, session);

      if (existing) {
        result = {
          alreadyProcessed: true,
          transaction: existing,
        };
        return;
      }

      // 2. Tìm đơn.
      const order = await ShopeeOrder.findOne({
        shopId: String(shopId),
        orderSn: String(orderSn),
      }).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn Shopee");
      }

      const orderStatus = String(order.orderStatus || "").toUpperCase();

      if (["CANCELLED", "IN_CANCEL"].includes(orderStatus)) {
        throw new Error(
          "Đơn Shopee đã hủy hoặc đang chờ hủy, không thể xuất kho",
        );
      }

      // 3. Tìm dòng sản phẩm.
      const orderItem = getOrderItem(order, itemKey);

      if (!orderItem) {
        throw new Error("Không tìm thấy sản phẩm trong đơn Shopee");
      }

      if (
        orderItem.mappingStatus !== "mapped" ||
        String(orderItem.productId) !== String(productId) ||
        String(orderItem.variantCode) !== String(variantCode)
      ) {
        throw new Error("Ánh xạ SKU của đơn không khớp với sản phẩm xuất kho");
      }

      // 4. Lấy snapshot hệ số quy đổi.
      const { multiplier } = await resolveOrderItemMapping({
        shopId,
        orderItem,
        productId,
        variantCode,
        session,
      });

      // Nếu đơn cũ chưa có snapshot, lưu lại ở lần xuất đầu tiên.
      if (
        orderItem.quantityMultiplier === undefined ||
        orderItem.quantityMultiplier === null
      ) {
        orderItem.quantityMultiplier = multiplier;
      }

      const orderedShopeeQty = validateQty(
        orderItem.quantity,
        "Số lượng đặt Shopee",
      );

      const orderedStockQty = orderedShopeeQty * multiplier;

      const alreadyDeducted = validateNonNegativeQty(
        orderItem.deductedQty || 0,
        "Số lượng đã xuất",
      );

      const remainingOrderQty = orderedStockQty - alreadyDeducted;

      if (remainingOrderQty <= 0) {
        throw new Error("Dòng sản phẩm này đã xuất đủ số lượng");
      }

      if (qty > remainingOrderQty) {
        throw new Error(
          `Số lượng xuất vượt số lượng còn phải xuất. Còn lại: ${remainingOrderQty}`,
        );
      }

      // 5. Tìm sản phẩm và biến thể.
      const { product, variant } = await getProductAndVariant({
        productId,
        variantCode,
        session,
      });

      const currentQty = validateNonNegativeQty(
        variant.qty || 0,
        "Tồn kho hiện tại",
      );

      if (currentQty < qty) {
        throw new Error(
          `Không đủ tồn kho. Hiện có ${currentQty}, cần xuất ${qty}`,
        );
      }

      // 6. Lấy các lô theo FIFO.
      const batches = await InventoryBatch.find({
        productId: product._id,
        variantName: variant.name,
        isActive: true,
        remainingQty: { $gt: 0 },
      })
        .sort({
          importDate: 1,
          createdAt: 1,
          _id: 1,
        })
        .session(session);

      const batchTotal = batches.reduce(
        (sum, batch) => sum + Number(batch.remainingQty || 0),
        0,
      );

      if (batchTotal < qty) {
        throw new Error(
          `Tổng tồn lô không đủ xuất FIFO. Tồn biến thể: ${currentQty}, tồn lô: ${batchTotal}, cần xuất: ${qty}. Vui lòng kiểm tra lại các lô kho.`,
        );
      }

      // 7. Phân bổ FIFO.
      let remaining = qty;
      let currentVariantQty = currentQty;

      const allocations = [];

      for (const batch of batches) {
        if (remaining <= 0) break;

        const available = Number(batch.remainingQty || 0);
        const allocated = Math.min(available, remaining);

        if (allocated <= 0) continue;

        const beforeBatchQty = available;

        batch.remainingQty = available - allocated;

        if (batch.remainingQty === 0) {
          batch.isActive = false;
        }

        await batch.save({ session });

        const beforeQty = currentVariantQty;
        const afterQty = beforeQty - allocated;

        currentVariantQty = afterQty;

        allocations.push({
          productId: product._id,
          variantCode: variant.code || "",
          variantName: variant.name,

          batchId: batch._id,
          batchCode: batch.batchCode,

          qty: allocated,
          unitCost: Number(batch.unitCost || variant.unitCost || 0),

          beforeQty: beforeBatchQty,
          afterQty: batch.remainingQty,
        });

        await saveHistory({
          session,
          type: "export",
          referenceType: "ShopeeOrder",
          referenceId: order._id,
          referenceCode: orderSn,

          product,
          variant,
          batch,

          qty: -allocated,
          beforeQty,
          afterQty,

          note: note || `Xuất kho đơn Shopee ${orderSn}`,

          createdBy,
        });

        remaining -= allocated;
      }

      if (remaining !== 0) {
        throw new Error("Không thể phân bổ đủ số lượng theo FIFO");
      }

      // 8. Cập nhật tồn kho.
      variant.qty = currentQty - qty;

      recalculateProductQty(product);

      await product.save({ session });

      // 9. Cập nhật dòng đơn.
      orderItem.deductedQty = alreadyDeducted + qty;

      // 10. Cập nhật trạng thái toàn đơn.
      await updateOrderStockStatus({
        order,
        session,
        createdBy,
      });

      // 11. Lưu giao dịch.
      const transactions = await ShopeeStockTransaction.create(
        [
          {
            idempotencyKey,
            shopId: String(shopId),
            kind: "order_export",
            orderSn: String(orderSn),
            itemKey: String(itemKey),
            allocations,
            totalQty: qty,
            status: "completed",
            note,
            createdBy: createdBy || null,
          },
        ],
        { session },
      );

      result = {
        alreadyProcessed: false,
        transaction: transactions[0],

        orderStockStatus: order.stockStatus,

        orderedShopeeQty,
        quantityMultiplier: multiplier,
        orderedStockQty,

        deductedQty: orderItem.deductedQty,

        remainingOrderQty: orderedStockQty - orderItem.deductedQty,

        remainingQty: variant.qty,
      };
    });

    return result;
  } catch (error) {
    if (error.code === 11000) {
      const existing = await findExistingTransaction(idempotencyKey);

      if (existing) {
        return {
          alreadyProcessed: true,
          transaction: existing,
        };
      }
    }

    throw error;
  } finally {
    await session.endSession();
  }
}

// =====================================================
// 6. TÍNH TRẠNG THÁI KHO CỦA PHIẾU HOÀN
// =====================================================

function updateReturnWarehouseStatus(returnDoc) {
  const items = returnDoc.items || [];

  if (!items.length) {
    returnDoc.warehouseStatus = "waiting";
    return;
  }

  const allReceived = items.every((item) => {
    const requested = Number(item.requestedQty || 0);
    const received = Number(item.receivedQty || 0);

    return requested > 0 && received >= requested;
  });

  const anyReceived = items.some((item) => Number(item.receivedQty || 0) > 0);

  const allInspected = items.every((item) => {
    const received = Number(item.receivedQty || 0);
    const good = Number(item.goodQty || 0);
    const damaged = Number(item.damagedQty || 0);

    return good + damaged === received;
  });

  const allRestocked = items.every((item) => {
    const good = Number(item.goodQty || 0);
    const restocked = Number(item.restockedQty || 0);

    return restocked >= good;
  });

  const anyRestocked = items.some((item) => Number(item.restockedQty || 0) > 0);

  if (allReceived && allInspected && allRestocked) {
    returnDoc.warehouseStatus = "restocked";
    return;
  }

  if (anyRestocked) {
    returnDoc.warehouseStatus = "partially_restocked";
    return;
  }

  if (allReceived && allInspected) {
    returnDoc.warehouseStatus = "inspected";
    return;
  }

  if (anyReceived) {
    returnDoc.warehouseStatus = "received";
    return;
  }

  if (returnDoc.warehouseStatus !== "closed") {
    returnDoc.warehouseStatus = "waiting";
  }
}

// =====================================================
// 7. NHẬN VÀ KIỂM TRA HÀNG HOÀN
//
// Tất cả số lượng đầu vào đều là đơn vị kho thực tế.
//
// receivedQty: tổng hàng thực nhận.
// goodQty: hàng tốt.
// damagedQty: hàng hỏng.
//
// Chỉ goodQty được cộng vào tồn kho.
// returnedQty tăng theo goodQty + damagedQty.
// =====================================================

async function restockShopeeReturnItem({
  shopId,
  returnSn,
  itemKey,
  receivedQty,
  goodQty,
  damagedQty,
  idempotencyKey,
  createdBy,
  note = "",
}) {
  receivedQty = validateQty(receivedQty, "Số lượng thực nhận");

  goodQty = validateNonNegativeQty(goodQty, "Số lượng hàng tốt");

  damagedQty = validateNonNegativeQty(damagedQty, "Số lượng hàng hỏng");

  if (goodQty + damagedQty !== receivedQty) {
    throw new Error(
      "Số lượng hàng tốt và hàng hỏng phải bằng số lượng thực nhận",
    );
  }

  if (!shopId || !returnSn || !itemKey || !idempotencyKey) {
    throw new Error("Thiếu thông tin xử lý hàng hoàn Shopee");
  }

  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      // 1. Chống xử lý giao dịch trùng.
      const existing = await findExistingTransaction(idempotencyKey, session);

      if (existing) {
        result = {
          alreadyProcessed: true,
          transaction: existing,
        };
        return;
      }

      // 2. Tìm phiếu trả hàng.
      const returnDoc = await ShopeeReturn.findOne({
        shopId: String(shopId),
        returnSn: String(returnSn),
      }).session(session);

      if (!returnDoc) {
        throw new Error("Không tìm thấy yêu cầu trả hàng Shopee");
      }

      if (returnDoc.warehouseStatus === "closed") {
        throw new Error("Phiếu hoàn đã đóng, không thể tiếp tục nhận hàng");
      }

      const returnItem = getReturnItem(returnDoc, itemKey);

      if (!returnItem) {
        throw new Error("Không tìm thấy sản phẩm trong phiếu hoàn");
      }

      // 3. Kiểm tra số lượng yêu cầu.
      // requestedQty phải là đơn vị kho thực tế.
      const requestedQty = validateQty(
        returnItem.requestedQty,
        "Số lượng yêu cầu hoàn",
      );

      const oldReceivedQty = validateNonNegativeQty(
        returnItem.receivedQty || 0,
        "Số lượng đã nhận",
      );

      const oldGoodQty = validateNonNegativeQty(
        returnItem.goodQty || 0,
        "Số lượng hàng tốt đã nhận",
      );

      const oldDamagedQty = validateNonNegativeQty(
        returnItem.damagedQty || 0,
        "Số lượng hàng hỏng đã nhận",
      );

      const oldRestockedQty = validateNonNegativeQty(
        returnItem.restockedQty || 0,
        "Số lượng đã nhập lại kho",
      );

      if (oldReceivedQty + receivedQty > requestedQty) {
        throw new Error(
          `Số lượng nhận vượt yêu cầu hoàn. Còn được nhận: ${
            requestedQty - oldReceivedQty
          }`,
        );
      }

      // 4. Tìm đơn hàng gốc.
      if (!returnDoc.orderSn) {
        throw new Error(
          "Phiếu hoàn chưa có orderSn, không thể liên kết đơn gốc",
        );
      }

      const order = await ShopeeOrder.findOne({
        shopId: String(shopId),
        orderSn: String(returnDoc.orderSn),
      }).session(session);

      if (!order) {
        throw new Error(`Không tìm thấy đơn gốc ${returnDoc.orderSn}`);
      }

      const orderItemKey =
        returnItem.orderItemKey ||
        makeItemKey(returnItem.itemId, returnItem.modelId);

      const orderItem = getOrderItem(order, orderItemKey);

      if (!orderItem) {
        throw new Error("Không tìm thấy sản phẩm tương ứng trong đơn gốc");
      }

      // 5. Kiểm tra hệ số snapshot.
      // Không nhân lại goodQty/damagedQty vì đầu vào đã là đơn vị kho.
      const multiplier = validateMultiplier(
        returnItem.quantityMultiplier || orderItem.quantityMultiplier || 1,
      );

      if (
        orderItem.quantityMultiplier &&
        validateMultiplier(orderItem.quantityMultiplier) !== multiplier
      ) {
        throw new Error(
          "Hệ số quy đổi trên phiếu hoàn không khớp snapshot của đơn hàng",
        );
      }

      // 6. Không cho hoàn vượt số lượng đã xuất.
      const returnedStockQty = goodQty + damagedQty;

      const oldReturnedQty = validateNonNegativeQty(
        orderItem.returnedQty || 0,
        "Số lượng đã hoàn",
      );

      const deductedQty = validateNonNegativeQty(
        orderItem.deductedQty || 0,
        "Số lượng đã xuất",
      );

      const newReturnedQty = oldReturnedQty + returnedStockQty;

      if (newReturnedQty > deductedQty) {
        throw new Error(
          `Số lượng hoàn vượt số lượng đã xuất. Đã xuất: ${deductedQty}, đã hoàn: ${oldReturnedQty}, lần này: ${returnedStockQty}`,
        );
      }

      // 7. Chỉ hàng tốt mới được nhập kho.
      let product = null;
      let variant = null;
      let batch = null;

      let beforeQty = null;
      let afterQty = null;

      const allocations = [];

      if (goodQty > 0) {
        if (
          returnItem.mappingStatus !== "mapped" ||
          !returnItem.productId ||
          !returnItem.variantCode
        ) {
          throw new Error(
            "Sản phẩm hoàn chưa được ánh xạ SKU chính xác. Không thể nhập hàng tốt vào kho",
          );
        }

        // Đảm bảo mapping của phiếu hoàn khớp đơn gốc.
        if (
          String(returnItem.productId) !== String(orderItem.productId) ||
          String(returnItem.variantCode) !== String(orderItem.variantCode)
        ) {
          throw new Error(
            "SKU của phiếu hoàn không khớp SKU đã xuất trong đơn gốc",
          );
        }

        const found = await getProductAndVariant({
          productId: returnItem.productId,
          variantCode: returnItem.variantCode,
          session,
        });

        product = found.product;
        variant = found.variant;

        beforeQty = validateNonNegativeQty(
          variant.qty || 0,
          "Tồn kho hiện tại",
        );

        afterQty = beforeQty + goodQty;

        // Tạo lô riêng cho hàng hoàn.
        const batchCode = `SHOPEE-RETURN-${new mongoose.Types.ObjectId().toString()}`;

        batch = new InventoryBatch({
          batchCode,

          productId: product._id,
          productTitle: product.title || "",
          productCode: variant.code || "",
          variantName: variant.name,

          importDate: new Date(),

          importQty: goodQty,
          remainingQty: goodQty,

          unitCost: Number(variant.unitCost || 0),

          source: "manual",
          sourceConfidence: "recorded",

          note: note || `Nhập hàng tốt hoàn Shopee ${returnSn}`,

          createdBy: createdBy || null,
          isActive: true,
        });

        await batch.save({ session });

        variant.qty = afterQty;

        recalculateProductQty(product);

        await product.save({ session });

        await saveHistory({
          session,
          type: "import",
          referenceType: "ShopeeReturn",
          referenceId: returnDoc._id,
          referenceCode: returnSn,

          product,
          variant,
          batch,

          qty: goodQty,
          beforeQty,
          afterQty,

          note: note || `Nhập lại hàng tốt hoàn Shopee ${returnSn}`,

          createdBy,
        });

        allocations.push({
          productId: product._id,
          variantCode: variant.code || "",
          variantName: variant.name,

          batchId: batch._id,
          batchCode: batch.batchCode,

          qty: goodQty,
          unitCost: Number(batch.unitCost || 0),

          beforeQty,
          afterQty,
        });
      }

      // 8. Cập nhật tiến trình phiếu hoàn.
      returnItem.receivedQty = oldReceivedQty + receivedQty;

      returnItem.goodQty = oldGoodQty + goodQty;

      returnItem.damagedQty = oldDamagedQty + damagedQty;

      returnItem.restockedQty = oldRestockedQty + goodQty;

      // 9. Cập nhật số lượng đã hoàn của đơn gốc.
      // Tính cả hàng tốt và hàng hỏng đã nhận thực tế.
      orderItem.returnedQty = newReturnedQty;

      await order.save({ session });

      // 10. Lưu thời gian nhận/kiểm hàng lần đầu.
      if (!returnDoc.receivedAt) {
        returnDoc.receivedAt = new Date();
        returnDoc.receivedBy = createdBy || null;
      }

      if (!returnDoc.inspectedAt) {
        returnDoc.inspectedAt = new Date();
        returnDoc.inspectedBy = createdBy || null;
      }

      // 11. Cập nhật trạng thái kho.
      updateReturnWarehouseStatus(returnDoc);

      await returnDoc.save({ session });

      // 12. Ghi giao dịch.
      const transactions = await ShopeeStockTransaction.create(
        [
          {
            idempotencyKey,
            shopId: String(shopId),

            kind: goodQty > 0 ? "return_import" : "return_adjustment",

            returnSn: String(returnSn),
            orderSn: String(returnDoc.orderSn || ""),

            itemKey: String(itemKey),

            allocations,

            // totalQty là số lượng thực tế được cộng vào kho.
            totalQty: goodQty,

            status: "completed",

            note:
              note || `Nhận ${receivedQty}, tốt ${goodQty}, hỏng ${damagedQty}`,

            createdBy: createdBy || null,
          },
        ],
        { session },
      );

      result = {
        alreadyProcessed: false,

        transaction: transactions[0],

        batch,

        orderSn: order.orderSn,
        returnSn: returnDoc.returnSn,

        receivedQty,
        goodQty,
        damagedQty,

        returnedStockQty,
        returnedQty: orderItem.returnedQty,

        quantityMultiplier: multiplier,

        remainingQty: variant ? variant.qty : null,

        warehouseStatus: returnDoc.warehouseStatus,
      };
    });

    return result;
  } catch (error) {
    if (error.code === 11000) {
      const existing = await findExistingTransaction(idempotencyKey);

      if (existing) {
        return {
          alreadyProcessed: true,
          transaction: existing,
        };
      }
    }

    throw error;
  } finally {
    await session.endSession();
  }
}

// =====================================================
// 8. EXPORT
// =====================================================

module.exports = {
  exportShopeeOrderItem,
  restockShopeeReturnItem,
};
