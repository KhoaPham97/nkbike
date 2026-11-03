const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/customer");
const { Product } = require("../models/products");
const {
  emitStockNotification,
} = require("../services/stockNotificationService");
// inventoryHistory.js export trực tiếp model
const InventoryHistory = require("../models/inventoryHistory");
const InventoryBatch = require("../models/InventoryBatch");

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
   HELPER
========================================================= */
/* =========================================================
   REBUILD SOLD QTY
   TÍNH LẠI SỐ LƯỢNG ĐÃ BÁN TỪ CÁC ĐƠN COMPLETED

   POST /api/order/rebuild-sold-qty
========================================================= */

const rebuildProductSoldQtyAsync = async (req, res) => {
  try {
    /* =====================================================
       1. RESET TẤT CẢ soldQty VỀ 0
    ===================================================== */

    await Product.updateMany(
      {},
      {
        $set: {
          soldQty: 0,
        },
      },
    );

    /* =====================================================
       2. LẤY TỔNG QTY TỪ CÁC ORDER COMPLETED
    ===================================================== */

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

      {
        $sort: {
          soldQty: -1,
        },
      },
    ]);

    /* =====================================================
       3. UPDATE PRODUCT
    ===================================================== */

    if (soldData.length > 0) {
      const bulkOperations = soldData
        .filter((item) => mongoose.Types.ObjectId.isValid(item._id))
        .map((item) => ({
          updateOne: {
            filter: {
              _id: item._id,
            },

            update: {
              $set: {
                soldQty: Number(item.soldQty) || 0,
                updated_at: new Date(),
              },
            },
          },
        }));

      if (bulkOperations.length > 0) {
        await Product.bulkWrite(bulkOperations);
      }
    }

    /* =====================================================
       4. LẤY TOP BÁN CHẠY ĐỂ RESPONSE
    ===================================================== */

    const topProducts = await Product.find({
      soldQty: {
        $gt: 0,
      },
    })
      .sort({
        soldQty: -1,
      })
      .limit(20)
      .select("_id title code soldQty qty thumbnail")
      .lean();

    /* =====================================================
       5. RESPONSE
    ===================================================== */

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
const toNumber = (value) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
};

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

const findVariant = (product, variantName = "") => {
  const cleanName = String(variantName || "").trim();

  if (!cleanName) {
    return null;
  }

  return (
    getVariants(product).find(
      (item) => String(item?.name || "").trim() === cleanName,
    ) || null
  );
};

const getProductPrice = (product, variantName = "") => {
  const cleanVariantName = String(variantName || "").trim();

  if (!cleanVariantName) {
    return {
      price: toNumber(product?.price),
      variant: null,
    };
  }

  const variant = findVariant(product, cleanVariantName);

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
   CALCULATE ORDER TOTAL
========================================================= */

const calculateOrderTotal = (order) => {
  let subtotal = 0;

  if (Array.isArray(order.items)) {
    for (const item of order.items) {
      const qty = toNumber(item.qty);
      const price = toNumber(item.price);

      const total = price * qty;

      item.total = total;

      subtotal += total;
    }
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
    .sort({
      code: -1,
    })
    .lean();

  let sequence = 1;

  if (lastOrder?.code) {
    const parts = String(lastOrder.code).split("-");

    const lastNumber = Number(parts[1]) || 0;

    sequence = lastNumber + 1;
  }

  return `${prefix}-${String(sequence).padStart(4, "0")}`;
};

/* =========================================================
   CREATE INVENTORY HISTORY
========================================================= */

const buildInventoryHistory = ({
  order,
  product,
  variantName,
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

    variantName: String(variantName || "").trim(),

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
   FIFO: PHÂN BỔ LÔ VÀ TRỪ KHO
========================================================= */

const deductOrderStockFIFO = async ({ order, session, userId }) => {
  const productCache = new Map();
  const historyDocuments = [];

  for (const item of order.items || []) {
    const qty = toNumber(item.qty);
    const variantName = String(item.variantName || "").trim();

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

    if (variantName) {
      variant = findVariant(product, variantName);

      if (!variant) {
        throw new Error(
          `Không tìm thấy phân loại "${variantName}" của sản phẩm "${product.title}"`,
        );
      }

      if (toNumber(variant.qty) < qty) {
        throw new Error(
          `Phân loại "${variantName}" chỉ còn ${variant.qty}, cần xuất ${qty}`,
        );
      }
    } else if (getVariants(product).length > 0) {
      throw new Error(
        `Sản phẩm "${product.title}" có phân loại nhưng đơn hàng chưa chọn phân loại`,
      );
    }

    if (toNumber(product.qty) < qty) {
      throw new Error(
        `Sản phẩm "${product.title}" chỉ còn ${product.qty}, cần xuất ${qty}`,
      );
    }

    // Tìm các lô còn hàng theo FIFO.
    const batches = await InventoryBatch.find({
      productId: item.productId,
      variantName,
      isActive: { $ne: false },
      remainingQty: { $gt: 0 },
    })
      .sort({
        importDate: 1,
        created_at: 1,
        _id: 1,
      })
      .session(session);

    const availableQty = batches.reduce(
      (sum, batch) => sum + Math.max(0, toNumber(batch.remainingQty)),
      0,
    );

    if (availableQty < qty) {
      throw new Error(
        `Không đủ hàng trong các lô của "${product.title}" - ` +
          `${variantName || "Không phân loại"}. ` +
          `Tồn lô: ${availableQty}, cần xuất: ${qty}`,
      );
    }

    let remainingToDeduct = qty;
    const allocations = [];

    // Trừ lần lượt từ lô cũ nhất.
    for (const batch of batches) {
      if (remainingToDeduct <= 0) break;

      const batchBeforeQty = toNumber(batch.remainingQty);
      const deductQty = Math.min(batchBeforeQty, remainingToDeduct);

      if (deductQty <= 0) continue;

      batch.remainingQty = batchBeforeQty - deductQty;

      await batch.save({ session });

      allocations.push({
        batchId: batch._id,
        batchCode: batch.batchCode || "",
        qty: deductQty,
        unitCost: toNumber(batch.unitCost),
      });

      historyDocuments.push({
        type: "order",
        referenceType: "Order",
        referenceId: order._id,
        referenceCode: order.code || "",

        productId: product._id,
        productTitle: product.title || "",
        productCode: getProductCode(product),
        variantName,

        qty: -deductQty,
        beforeQty: batchBeforeQty,
        afterQty: toNumber(batch.remainingQty),

        batchId: batch._id,
        batchCode: batch.batchCode || "",
        unitCost: toNumber(batch.unitCost),

        note: `Xuất FIFO theo đơn ${order.code || order._id}`,

        createdBy: userId || null,
        rollback: false,
        rollback_at: null,
        rollbackBy: null,
        created_at: new Date(),
      });

      remainingToDeduct -= deductQty;
    }

    if (remainingToDeduct > 0) {
      throw new Error(
        `Không thể phân bổ đủ lô cho sản phẩm "${product.title}"`,
      );
    }

    // Lưu phân bổ lô vào từng dòng sản phẩm của đơn.
    item.batchAllocations = allocations;

    // Trừ tồn kho tổng và tồn kho phân loại.
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
   FIFO: HOÀN KHO VỀ ĐÚNG LÔ ĐÃ XUẤT
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
      `Không tìm thấy lịch sử xuất kho của đơn ${order.code || order._id}`,
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
          `Không tìm thấy sản phẩm ${history.productId} để hoàn kho`,
        );
      }

      productCache.set(productId, product);
    }

    // Hoàn đúng số lượng vào đúng lô.
    if (history.batchId) {
      const batch = await InventoryBatch.findById(history.batchId).session(
        session,
      );

      if (!batch) {
        throw new Error(
          `Không tìm thấy lô ${history.batchCode || history.batchId} để hoàn kho`,
        );
      }

      batch.remainingQty = toNumber(batch.remainingQty) + qty;

      await batch.save({ session });
    }

    const variantName = String(history.variantName || "").trim();

    if (variantName) {
      const variant = findVariant(product, variantName);

      if (!variant) {
        throw new Error(
          `Không tìm thấy phân loại "${variantName}" khi hoàn kho`,
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

  // Xóa lịch sử xuất của đơn sau khi đã hoàn kho thành công.
  await InventoryHistory.deleteMany(
    {
      referenceType: "Order",
      referenceId: order._id,
      type: "order",
    },
    { session },
  );

  order.stockDeducted = false;
  order.markModified("items");

  return {
    historyRecords: histories.length,
    restoredQty,
  };
};

/* =========================================================
   SYNC ORDER STOCK
   - Chỉ đồng bộ đơn chưa trừ kho
   - Tự phân bổ FIFO
========================================================= */

const syncOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    const filter = {
      stockDeducted: { $ne: true },
      status: { $ne: "cancelled" },
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
      message: "Đồng bộ tồn kho theo FIFO thành công",
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
   TẠO ĐƠN = TRỪ KHO NGAY
========================================================= */

const createOrderAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      customerId,
      items = [],
      discount = 0,
      shippingFee = 0,
      paidAmount = 0,
      paymentMethod = "cash",
      note = "",
    } = req.body || {};

    // VALIDATE ITEMS
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Đơn hàng chưa có sản phẩm",
      });
    }

    // VALIDATE CUSTOMER
    if (customerId && !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: "customerId không hợp lệ",
      });
    }

    // MONEY
    const discountNumber = Math.max(0, toNumber(discount));
    const shippingNumber = Math.max(0, toNumber(shippingFee));
    const paidNumber = Math.max(0, toNumber(paidAmount));

    // PAYMENT
    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    let createdOrder = null;

    await session.withTransaction(async () => {
      // CUSTOMER
      let customer = null;

      if (customerId) {
        customer = await Customer.findById(customerId).session(session);

        if (!customer) {
          throw new Error("Không tìm thấy khách hàng");
        }
      }

      // MERGE ITEMS
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

        const variantName = String(rawItem.variantName || "").trim();

        const key = `${String(rawItem.productId)}_${variantName}`;

        if (!mergedItems.has(key)) {
          mergedItems.set(key, {
            productId: rawItem.productId,
            variantName,
            qty: 0,
            batchAllocations: [],
          });
        }

        mergedItems.get(key).qty += qty;
        if (Array.isArray(rawItem.batchAllocations)) {
          mergedItems
            .get(key)
            .batchAllocations.push(...rawItem.batchAllocations);
        }
      }

      // PROCESS ITEMS - KHÔNG TRỪ KHO
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

        const variantName = String(item.variantName || "").trim();

        let price = toNumber(product.price);
        let defaultPrice = toNumber(product.defaultPrice);

        // VARIANT
        if (variantName) {
          const variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${variantName}" của sản phẩm "${product.title}"`,
            );
          }

          price = toNumber(variant.price);
          defaultPrice = toNumber(variant.defaultPrice);
        }

        // ITEM TOTAL
        const itemTotal = price * item.qty;
        subtotal += itemTotal;

        // ORDER ITEM SNAPSHOT
        orderItems.push({
          productId: product._id,
          productTitle: product.title || "",
          productCode: getProductCode(product),
          variantName,
          price,
          defaultPrice,
          qty: item.qty,
          total: itemTotal,
          thumbnail: product.thumbnail || "",
          batchAllocations: (item.batchAllocations || []).map((a) => ({
            batchId: a.batchId,
            batchCode: a.batchCode || "",
            qty: toNumber(a.qty),
            unitCost: toNumber(a.unitCost),
          })),
        });
      }

      // TOTAL
      const totalAmount = Math.max(
        0,
        subtotal - discountNumber + shippingNumber,
      );

      if (paidNumber > totalAmount) {
        throw new Error("Số tiền khách trả không được lớn hơn tổng tiền");
      }

      const debt = Math.max(0, totalAmount - paidNumber);

      // ORDER CODE
      const code = await generateOrderCode();

      // CREATE ORDER - CHƯA TRỪ KHO
      const order = new Order({
        code,
        customerId: customer?._id || null,
        customerName: customer?.name || "Khách lẻ",
        customerPhone: customer?.phone || "",
        customerAddress: customer?.address || "",
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

      // CUSTOMER
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

/* =========================================================
   ROLLBACK ORDER STOCK
   HOÀN KHO + GIẢM SOLD QTY
========================================================= */

const rollbackOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    /* =====================================================
       VALIDATE
    ===================================================== */

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

    let result = {
      historyRecords: 0,
      restoredItems: 0,
      restoredQty: 0,
      restoredSoldQty: 0,
    };

    await session.withTransaction(async () => {
      /* =================================================
           FIND ORDER
        ================================================= */

      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.stockDeducted !== true) {
        throw new Error("Đơn hàng này hiện không còn tồn kho đã bị trừ");
      }

      /* =================================================
           FIND ACTIVE HISTORY
        ================================================= */

      const histories = await InventoryHistory.find({
        referenceType: "Order",

        referenceId: order._id,

        type: "order",

        $or: [
          {
            rollback: {
              $exists: false,
            },
          },

          {
            rollback: false,
          },
        ],
      })
        .sort({
          created_at: 1,
        })
        .session(session);

      if (!histories.length) {
        throw new Error(
          `Không tìm thấy lịch sử xuất kho của đơn ${order.code || order._id}`,
        );
      }

      /* =================================================
           PRODUCT CACHE
        ================================================= */

      const productCache = new Map();

      /* =================================================
           RESTORE STOCK
        ================================================= */

      for (const history of histories) {
        const productId = String(history.productId);

        let product = productCache.get(productId);

        if (!product) {
          product = await Product.findById(history.productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${history.productId}`);
          }

          productCache.set(productId, product);
        }

        const restoreQty = Math.abs(toNumber(history.qty));

        // Hoàn số lượng về đúng lô đã xuất. Lịch sử cũ không có batchId thì bỏ qua.
        if (restoreQty > 0 && history.batchId) {
          const batch = await InventoryBatch.findById(history.batchId).session(
            session,
          );
          if (!batch) {
            throw new Error(
              `Không tìm thấy lô ${history.batchCode || history.batchId} khi rollback`,
            );
          }
          batch.remainingQty = toNumber(batch.remainingQty) + restoreQty;
          await batch.save({ session });
        }

        if (restoreQty <= 0) {
          continue;
        }

        const variantName = String(history.variantName || "").trim();

        /* =================================================
             VARIANT
          ================================================= */

        if (variantName) {
          const variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Không tìm thấy variant "${variantName}" của sản phẩm "${product.title}"`,
            );
          }

          /* ---------------------------------------------
               RESTORE VARIANT
            --------------------------------------------- */

          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty + restoreQty;

          variant.qty = afterVariantQty;

          /* ---------------------------------------------
               RESTORE PRODUCT QTY
            --------------------------------------------- */

          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty + restoreQty;

          product.qty = afterProductQty;

          /* ---------------------------------------------
               REDUCE SOLD QTY
            --------------------------------------------- */

          const beforeSoldQty = toNumber(product.soldQty);

          const afterSoldQty = Math.max(0, beforeSoldQty - restoreQty);

          product.soldQty = afterSoldQty;

          result.restoredSoldQty += Math.min(restoreQty, beforeSoldQty);

          product.updated_at = new Date();

          await product.save({
            session,
          });
        } else {
          /* =================================================
               NO VARIANT
            ================================================= */

          const beforeQty = toNumber(product.qty);

          const afterQty = beforeQty + restoreQty;

          product.qty = afterQty;

          /* ---------------------------------------------
               REDUCE SOLD QTY
            --------------------------------------------- */

          const beforeSoldQty = toNumber(product.soldQty);

          const afterSoldQty = Math.max(0, beforeSoldQty - restoreQty);

          product.soldQty = afterSoldQty;

          result.restoredSoldQty += Math.min(restoreQty, beforeSoldQty);

          product.updated_at = new Date();

          await product.save({
            session,
          });
        }

        result.restoredItems++;

        result.restoredQty += restoreQty;
      }

      /* =================================================
           DELETE INVENTORY HISTORY
        ================================================= */

      const deleteResult = await InventoryHistory.deleteMany(
        {
          referenceType: "Order",

          referenceId: order._id,

          type: "order",

          $or: [
            {
              rollback: {
                $exists: false,
              },
            },

            {
              rollback: false,
            },
          ],
        },
        {
          session,
        },
      );

      result.historyRecords = deleteResult.deletedCount || 0;

      /* =================================================
           UPDATE ORDER
        ================================================= */

      order.stockDeducted = false;

      order.updated_at = new Date();

      await order.save({
        session,
      });

      /* =================================================
           UPDATE CUSTOMER DEBT
        ================================================= */

      if (order.customerId) {
        const customer = await Customer.findById(order.customerId).session(
          session,
        );

        if (customer) {
          const customerOrders = await Order.find({
            customerId: customer._id,

            status: {
              $ne: "cancelled",
            },
          })
            .select("debt")
            .session(session)
            .lean();

          const totalDebt = customerOrders.reduce((sum, item) => {
            return sum + Math.max(0, toNumber(item.debt));
          }, 0);

          customer.debt = totalDebt;

          customer.updated_at = new Date();

          await customer.save({
            session,
          });
        }
      }
    });

    return res.status(200).json({
      success: true,

      message: "Rollback tồn kho thành công, đã giảm soldQty",

      historyRecords: result.historyRecords,

      restoredItems: result.restoredItems,

      restoredQty: result.restoredQty,

      restoredSoldQty: result.restoredSoldQty,
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
   SYNC ONE PRODUCT PRICE
========================================================= */

const syncProductPriceToOrders = async ({
  productId,
  variantName = "",
  newPrice,
}) => {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    throw new Error("productId không hợp lệ");
  }

  const price = Number(newPrice);

  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Giá mới không hợp lệ");
  }

  const cleanVariantName = String(variantName || "").trim();

  const orders = await Order.find({
    status: {
      $in: UNCOMPLETED_STATUSES,
    },

    "items.productId": productId,
  });

  let updatedOrders = 0;

  let updatedItems = 0;

  for (const order of orders) {
    let changed = false;

    if (Array.isArray(order.items)) {
      for (const item of order.items) {
        if (String(item.productId) !== String(productId)) {
          continue;
        }

        const itemVariantName = String(item.variantName || "").trim();

        /* ===============================================
             NO VARIANT
          =============================================== */

        if (!cleanVariantName && !itemVariantName) {
          const oldPrice = toNumber(item.price);

          if (oldPrice !== price) {
            item.price = price;

            item.total = toNumber(item.qty) * price;

            changed = true;

            updatedItems++;
          }

          continue;
        }

        /* ===============================================
             VARIANT
          =============================================== */

        if (cleanVariantName && itemVariantName === cleanVariantName) {
          const oldPrice = toNumber(item.price);

          if (oldPrice !== price) {
            item.price = price;

            item.total = toNumber(item.qty) * price;

            changed = true;

            updatedItems++;
          }
        }
      }
    }

    if (!changed) {
      continue;
    }

    /*
     * QUAN TRỌNG:
     * Giữ nguyên paidAmount.
     * Chỉ tính lại tổng và debt.
     */
    calculateOrderTotal(order);

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
      status: {
        $in: UNCOMPLETED_STATUSES,
      },
    });

    let updatedOrders = 0;

    let updatedItems = 0;

    for (const order of orders) {
      if (!Array.isArray(order.items)) {
        continue;
      }

      let orderChanged = false;

      for (const item of order.items) {
        if (
          !item.productId ||
          !mongoose.Types.ObjectId.isValid(item.productId)
        ) {
          continue;
        }

        const product = await Product.findById(item.productId).lean();

        if (!product) {
          continue;
        }

        const { price, variant } = getProductPrice(product, item.variantName);

        if (price === null) {
          continue;
        }

        const oldPrice = toNumber(item.price);

        if (oldPrice !== price) {
          item.price = price;

          item.total = toNumber(item.qty) * price;

          orderChanged = true;

          updatedItems++;
        }

        /* ===============================================
             SNAPSHOT
          =============================================== */

        if (product.title) {
          item.productTitle = product.title;
        }

        const productCode = getProductCode(product);

        if (productCode) {
          item.productCode = productCode;
        }

        if (variant) {
          item.variantName = String(variant.name || "").trim();
        }
      }

      if (!orderChanged) {
        continue;
      }

      calculateOrderTotal(order);

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

    return res.status(200).json({
      success: true,

      order,
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

    // Filter thời gian
    const fromDate = String(req.query.fromDate || "").trim();

    const toDate = String(req.query.toDate || "").trim();

    const filter = {};

    // =========================
    // FILTER STATUS
    // =========================
    if (status) {
      filter.status = status;
    }

    // =========================
    // FILTER SEARCH
    // =========================
    if (search) {
      filter.$or = [
        {
          code: {
            $regex: search,
            $options: "i",
          },
        },
        {
          customerName: {
            $regex: search,
            $options: "i",
          },
        },
        {
          customerPhone: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    // =========================
    // FILTER DATE
    // =========================
    if (fromDate || toDate) {
      const createdAtFilter = {};

      // Từ ngày
      if (fromDate) {
        const startDate = new Date(`${fromDate}T00:00:00+07:00`);

        if (!Number.isNaN(startDate.getTime())) {
          createdAtFilter.$gte = startDate;
        }
      }

      // Đến hết ngày
      if (toDate) {
        const endDate = new Date(`${toDate}T23:59:59.999+07:00`);

        if (!Number.isNaN(endDate.getTime())) {
          createdAtFilter.$lte = endDate;
        }
      }

      // Chỉ thêm filter nếu có ngày hợp lệ
      if (Object.keys(createdAtFilter).length > 0) {
        filter.created_at = createdAtFilter;
      }
    }

    // =========================
    // QUERY
    // =========================
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({
          created_at: -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      Order.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,

      orders,

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
   - completed: xuất kho theo FIFO
   - cancelled: hoàn kho về đúng lô
   - pending / confirmed / shipping: không trừ kho
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

      // Chỉ xuất kho khi chuyển sang completed.
      if (newStatus === "completed" && order.stockDeducted !== true) {
        stockResult = await deductOrderStockFIFO({
          order,
          session,
          userId: req.user?._id || null,
        });
      }

      // Hủy đơn đã xuất: hoàn kho về đúng lô.
      if (newStatus === "cancelled" && order.stockDeducted === true) {
        stockResult = await restoreOrderStockFIFO({
          order,
          session,
        });
      }

      // Giữ nguyên giá đã chốt, không lấy giá mới từ Product.
      if (newStatus === "completed") {
        calculateOrderTotal(order);

        order.paidAmount = Math.min(
          toNumber(order.paidAmount),
          toNumber(order.totalAmount),
        );

        order.debt = Math.max(
          0,
          toNumber(order.totalAmount) - toNumber(order.paidAmount),
        );
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
          ? "Xác nhận xuất kho thành công theo FIFO"
          : newStatus === "cancelled"
            ? "Hủy đơn hàng và hoàn kho thành công"
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
========================================================= */

const syncProductPriceAsync = async (req, res) => {
  try {
    const { productId, variantName } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu productId",
      });
    }

    // =====================================================
    // 1. LẤY PRODUCT
    // =====================================================
    const product = await Product.findById(productId).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    // =====================================================
    // 2. LẤY GIÁ THEO VARIANT
    // =====================================================
    let newPrice = 0;

    const normalizedVariantName = String(variantName || "").trim();

    if (normalizedVariantName) {
      const variant = (product.variants || []).find(
        (v) => String(v.name || "").trim() === normalizedVariantName,
      );

      if (!variant) {
        return res.status(404).json({
          success: false,
          message: `Không tìm thấy variant "${variantName}"`,
        });
      }

      newPrice = Number(variant.price);

      if (!Number.isFinite(newPrice)) {
        return res.status(400).json({
          success: false,
          message: `Giá variant "${variantName}" không hợp lệ`,
        });
      }
    } else {
      newPrice = Number(product.price);

      if (!Number.isFinite(newPrice)) {
        return res.status(400).json({
          success: false,
          message: "Giá sản phẩm không hợp lệ",
        });
      }
    }

    // =====================================================
    // 3. TÌM CÁC ORDER CHƯA HOÀN TẤT
    // =====================================================
    const orders = await Order.find({
      status: {
        $in: ["pending", "confirmed", "shipping"],
      },
      "items.productId": productId,
    });

    let updatedOrders = 0;
    let updatedItems = 0;

    // =====================================================
    // 4. UPDATE ITEM PRICE
    // =====================================================
    for (const order of orders) {
      let orderChanged = false;

      for (const item of order.items) {
        // -----------------------------------------------
        // PRODUCT ID
        // -----------------------------------------------
        if (String(item.productId) !== String(productId)) {
          continue;
        }

        // -----------------------------------------------
        // VARIANT
        // -----------------------------------------------
        const itemVariantName = String(item.variantName || "").trim();

        if (normalizedVariantName) {
          if (itemVariantName !== normalizedVariantName) {
            continue;
          }
        } else {
          // Sản phẩm không có variant
          if (itemVariantName) {
            continue;
          }
        }

        // -----------------------------------------------
        // UPDATE PRICE
        // -----------------------------------------------
        const qty = Number(item.qty) || 0;

        item.price = newPrice;
        item.total = newPrice * qty;

        orderChanged = true;
        updatedItems++;
      }

      // =================================================
      // 5. TÍNH LẠI ORDER
      // =================================================
      if (orderChanged) {
        calculateOrderTotal(order);

        // Quan trọng
        order.markModified("items");

        await order.save();

        updatedOrders++;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Đồng bộ giá thành công",
      data: {
        productId,
        variantName: normalizedVariantName || null,
        newPrice,
        updatedOrders,
        updatedItems,
      },
    });
  } catch (error) {
    console.error("syncProductPriceAsync error:", error);

    return res.status(500).json({
      success: false,
      message: "Lỗi đồng bộ giá",
      error: error.message,
    });
  }
};
const payOrderDebtAsync = async (req, res) => {
  try {
    const { orderId, amount } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu orderId",
      });
    }

    const paymentAmount = Number(amount);

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Số tiền thanh toán không hợp lệ",
      });
    }

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    const totalAmount = Number(order.totalAmount) || 0;
    const paidAmount = Number(order.paidAmount) || 0;

    const currentDebt = Math.max(totalAmount - paidAmount, 0);

    if (currentDebt <= 0) {
      return res.status(400).json({
        success: false,
        message: "Đơn hàng không còn công nợ",
      });
    }

    if (paymentAmount > currentDebt) {
      return res.status(400).json({
        success: false,
        message: "Số tiền thanh toán lớn hơn công nợ",
        data: {
          debt: currentDebt,
          maxPayment: currentDebt,
        },
      });
    }

    // =====================================================
    // CẬP NHẬT THANH TOÁN
    // =====================================================
    order.paidAmount = paidAmount + paymentAmount;

    order.debt = Math.max(totalAmount - order.paidAmount, 0);

    // =====================================================
    // ĐÃ TRẢ ĐỦ
    // =====================================================
    if (order.debt === 0) {
      order.paymentStatus = "paid";
    } else {
      order.paymentStatus = "partial";
    }

    await order.save();

    // =====================================================
    // CẬP NHẬT CÔNG NỢ CUSTOMER
    // =====================================================
    if (order.customerId) {
      const customer = await Customer.findById(order.customerId);

      if (customer) {
        const oldDebt = Number(customer.debt) || 0;

        customer.debt = Math.max(oldDebt - paymentAmount, 0);

        await customer.save();
      }
    }

    return res.status(200).json({
      success: true,
      message:
        order.debt === 0
          ? "Đã hoàn thành công nợ"
          : "Đã thanh toán một phần công nợ",

      data: {
        orderId: order._id,
        totalAmount,
        paidAmount: order.paidAmount,
        debt: order.debt,
        paymentStatus: order.paymentStatus,
      },
    });
  } catch (error) {
    console.error("payOrderDebtAsync error:", error);

    return res.status(500).json({
      success: false,
      message: "Lỗi thanh toán công nợ",
      error: error.message,
    });
  }
};
const syncOrderVariantsAsync = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu orderId",
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

    for (const item of order.items) {
      if (!item.productId) {
        skippedItems++;
        continue;
      }

      const variantName = String(
        item.variantName.length === 0 ? "Mặc định" : item.variantName || "",
      ).trim();

      if (!variantName) {
        skippedItems++;
        continue;
      }

      const product = await Product.findById(item.productId).lean();

      if (!product) {
        skippedItems++;
        continue;
      }

      const variant = (product.variants || []).find(
        (v) =>
          String(v.name || "")
            .trim()
            .toLowerCase() === variantName.toLowerCase(),
      );

      if (!variant) {
        skippedItems++;
        continue;
      }

      // Lấy defaultPrice và convert sang Number
      const defaultPrice = Number(variant.defaultPrice);
      const price = Number(variant.price);

      if (!Number.isFinite(defaultPrice)) {
        skippedItems++;
        continue;
      }

      // ADD defaultPrice vào order item
      item.defaultPrice = defaultPrice;
      item.price = price ?? 0;

      updatedItems++;
    }

    if (updatedItems > 0) {
      order.markModified("items");
      await order.save();
    }

    return res.status(200).json({
      success: true,
      message: "Đã thêm defaultPrice vào order items",
      data: {
        orderId,
        updatedItems,
        skippedItems,
        order,
      },
    });
  } catch (error) {
    console.error("syncOrderVariantsAsync error:", error);

    return res.status(500).json({
      success: false,
      message: "Lỗi thêm defaultPrice",
      error: error.message,
    });
  }
};

/* =========================================================
   CUSTOMER PURCHASE STATISTICS
   GET /api/orders/customer-purchase-stats

   - Nhóm theo customerName
   - Loại trừ đơn cancelled
   - Có lọc ngày, tìm kiếm và phân trang khách hàng
========================================================= */

const getCustomerPurchaseStatsAsync = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    // Loại bỏ đơn hàng đã hủy
    const orders = await Order.find({
      status: { $ne: "cancelled" },
    })
      .sort({ created_at: -1 })
      .lean();

    const customersMap = new Map();

    for (const order of orders) {
      const customerName = String(order.customerName || "Khách lẻ").trim();
      const customerPhone = String(order.customerPhone || "").trim();

      // Ưu tiên số điện thoại để phân biệt khách trùng tên
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

      customer.orderCount += 1;
      customer.totalSpent += Number(order.totalAmount) || 0;
      customer.totalPaid += Number(order.paidAmount) || 0;
      customer.totalDebt += Number(order.debt) || 0;

      const orderDate = order.created_at || order.createdAt;
      if (
        orderDate &&
        (!customer.lastOrderAt ||
          new Date(orderDate) > new Date(customer.lastOrderAt))
      ) {
        customer.lastOrderAt = orderDate;
      }

      // Tổng hợp các sản phẩm trong từng đơn hàng
      for (const item of order.items || []) {
        const qty = Number(item.qty) || 0;
        const price = Number(item.price) || 0;
        const productTitle = item.productTitle || item.title || "Sản phẩm";
        const productCode = item.productCode || "";
        const variantName = item.variantName || "";

        const productKey = [
          String(item.productId || ""),
          productCode,
          productTitle,
          variantName,
        ].join("|");

        if (!customer.productsMap.has(productKey)) {
          customer.productsMap.set(productKey, {
            productId: item.productId || null,
            productTitle,
            productCode,
            variantName,
            totalQty: 0,
            totalAmount: 0,
            orderCount: 0,
          });
        }

        const product = customer.productsMap.get(productKey);
        product.totalQty += qty;
        product.totalAmount += Number(item.total) || price * qty;
        product.orderCount += 1;

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

        // FE sử dụng trường này để hiển thị sản phẩm
        products,

        // Có thể dùng nếu FE đang đọc productDetails
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
    console.error("getCustomerPurchaseStatsAsync error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể thống kê sản phẩm khách hàng đã mua",
      error: error.message,
    });
  }
};
// Dán hàm này vào orderController.js, phía trên module.exports cuối cùng.
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
    const match = { stockDeducted: true, status: { $ne: "cancelled" } };
    const validDate = /^\d{4}-\d{2}-\d{2}$/;
    if (
      (fromDate && !validDate.test(fromDate)) ||
      (toDate && !validDate.test(toDate))
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Ngày phải có định dạng YYYY-MM-DD" });
    }
    if (fromDate || toDate) {
      match.created_at = {};
      if (fromDate)
        match.created_at.$gte = new Date(`${fromDate}T00:00:00+07:00`);
      if (toDate)
        match.created_at.$lte = new Date(`${toDate}T23:59:59.999+07:00`);
      if (
        Object.values(match.created_at).some((d) => Number.isNaN(d.getTime()))
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Ngày không hợp lệ" });
      }
    }
    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res
        .status(400)
        .json({ success: false, message: "categoryId không hợp lệ" });
    }
    const numeric = (field) => ({
      $convert: { input: field, to: "double", onError: 0, onNull: 0 },
    });
    const pipeline = [
      { $match: match },
      { $unwind: "$items" },
      { $match: { "items.productId": { $ne: null } } },
      {
        $addFields: {
          itemQty: numeric("$items.qty"),
          itemRevenue: {
            $multiply: [numeric("$items.qty"), numeric("$items.price")],
          },
        },
      },
      { $match: { itemQty: { $gt: 0 } } },
      {
        $group: {
          _id: {
            productId: "$items.productId",
            variantName: { $ifNull: ["$items.variantName", ""] },
          },
          productTitle: { $last: "$items.productTitle" },
          productCode: { $last: "$items.productCode" },
          thumbnail: { $last: "$items.thumbnail" },
          soldQty: { $sum: "$itemQty" },
          revenue: { $sum: "$itemRevenue" },
          orderIds: { $addToSet: "$_id" },
        },
      },
      {
        $group: {
          _id: "$_id.productId",
          productTitle: { $last: "$productTitle" },
          productCode: { $last: "$productCode" },
          thumbnail: { $last: "$thumbnail" },
          soldQty: { $sum: "$soldQty" },
          revenue: { $sum: "$revenue" },
          orderIdArrays: { $push: "$orderIds" },
          variants: {
            $push: {
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
                in: { $setUnion: ["$$value", "$$this"] },
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
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          productTitle: { $ifNull: ["$product.title", "$productTitle"] },
          productCode: { $ifNull: ["$product.code", "$productCode"] },
          thumbnail: { $ifNull: ["$product.thumbnail", "$thumbnail"] },
          stockQty: { $ifNull: ["$product.qty", 0] },
          type: "$product.type",
          categoryId: "$product.categoryId",
          variants: {
            $map: {
              input: "$variants",
              as: "v",
              in: {
                name: "$$v.name",
                soldQty: "$$v.soldQty",
                revenue: "$$v.revenue",
                stockQty: {
                  $let: {
                    vars: {
                      matching: {
                        $filter: {
                          input: { $ifNull: ["$product.variants", []] },
                          as: "pv",
                          cond: { $eq: ["$$pv.name", "$$v.name"] },
                        },
                      },
                    },
                    in: {
                      $ifNull: [{ $arrayElemAt: ["$$matching.qty", 0] }, 0],
                    },
                  },
                },
              },
            },
          },
        },
      },
      ...(type ? [{ $match: { type } }] : []),
      ...(categoryId
        ? [{ $match: { categoryId: new mongoose.Types.ObjectId(categoryId) } }]
        : []),
      ...(search
        ? [
            {
              $match: {
                $or: [
                  {
                    productTitle: {
                      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                      $options: "i",
                    },
                  },
                  {
                    productCode: {
                      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),
      { $project: { product: 0, orderIdArrays: 0 } },
      { $sort: { [sortBy === "revenue" ? "revenue" : "soldQty"]: -1, _id: 1 } },
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
            { $project: { productTitle: 1, soldQty: 1, revenue: 1 } },
          ],
        },
      },
    ];
    const [result] = await Order.aggregate(pipeline).allowDiskUse(true);
    const summary = result.summary[0] || {
      totalProducts: 0,
      totalSold: 0,
      totalRevenue: 0,
    };
    return res.json({
      success: true,
      data: result.rows,
      summary,
      top10: result.top10,
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
      message: error.message || "Không thể thống kê sản phẩm bán chạy",
    });
  }
};

module.exports = {
  // Giữ nguyên các hàm export hiện có
  getCustomerPurchaseStatsAsync,
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

  // Thống kê mua hàng khách hàng
  getCustomerPurchaseStatsAsync,
  getBestSellingProductsAsync,
};
