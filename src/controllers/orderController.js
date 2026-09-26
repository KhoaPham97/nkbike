const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/customer");
const { Product } = require("../models/products");

// =========================================================
// QUAN TRỌNG
// inventoryHistory.js export trực tiếp model
// Không dùng { InventoryHistory }
// =========================================================
const InventoryHistory = require("../models/inventoryHistory");

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

/**
 * Chuyển giá trị sang number an toàn
 */
const toNumber = (value) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
};

/**
 * Lấy mã sản phẩm
 */
const getProductCode = (product) => {
  return (
    product?.code ||
    product?.productCode ||
    product?.sku ||
    product?.product_code ||
    ""
  );
};

/**
 * Lấy variants an toàn
 */
const getVariants = (product) => {
  return Array.isArray(product?.variants) ? product.variants : [];
};

/**
 * Tìm variant
 */
const findVariant = (product, variantName = "") => {
  const cleanName = String(variantName || "").trim();

  if (!cleanName) {
    return null;
  }

  const variants = getVariants(product);

  return (
    variants.find((item) => String(item?.name || "").trim() === cleanName) ||
    null
  );
};

/* =========================================================
   SYNC ORDER STOCK
   DÙNG CHO ĐƠN CŨ CHƯA TRỪ KHO
========================================================= */

const syncOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    const filter = {
      stockDeducted: {
        $ne: true,
      },

      status: {
        $ne: "cancelled",
      },
    };

    /* =====================================================
       NẾU CÓ ORDER ID
    ===================================================== */

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
      updatedItems: 0,
      skippedOrders: 0,
      historyRecords: 0,
    };

    await session.withTransaction(async () => {
      const orders = await Order.find(filter)
        .sort({
          created_at: 1,
        })
        .session(session);

      result.totalOrders = orders.length;

      /* ===============================================
           LOOP ORDERS
        =============================================== */

      for (const order of orders) {
        /* =============================================
             KHÔNG CÓ ITEM
          ============================================= */

        if (!Array.isArray(order.items) || order.items.length === 0) {
          order.stockDeducted = true;
          order.updated_at = new Date();

          await order.save({
            session,
          });

          result.skippedOrders++;

          continue;
        }

        const productCache = new Map();

        /* =============================================
             PASS 1
             KIỂM TRA TOÀN BỘ TỒN
          ============================================= */

        for (const item of order.items) {
          if (!item?.productId) {
            throw new Error(
              `Đơn ${order.code || order._id} có sản phẩm không hợp lệ`,
            );
          }

          const productId = String(item.productId);

          let product = productCache.get(productId);

          if (!product) {
            product = await Product.findById(item.productId).session(session);

            if (!product) {
              throw new Error(
                `Không tìm thấy sản phẩm ${item.productId} trong đơn ${
                  order.code || order._id
                }`,
              );
            }

            productCache.set(productId, product);
          }

          const qty = toNumber(item.qty);

          if (qty <= 0) {
            throw new Error(
              `Số lượng không hợp lệ trong đơn ${order.code || order._id}`,
            );
          }

          const variantName = String(item.variantName || "").trim();

          /* =========================================
               CÓ VARIANT
            ========================================= */

          if (variantName) {
            const variant = findVariant(product, variantName);

            if (!variant) {
              throw new Error(
                `Không tìm thấy variant "${variantName}" của sản phẩm "${product.title}"`,
              );
            }

            const stock = toNumber(variant.qty);

            if (stock < qty) {
              throw new Error(
                `Sản phẩm "${product.title}" - "${variantName}" chỉ còn ${stock}, cần ${qty}`,
              );
            }
          } else {
            /* =========================================
               KHÔNG VARIANT
            ========================================= */
            const stock = toNumber(product.qty);

            if (stock < qty) {
              throw new Error(
                `Sản phẩm "${product.title}" chỉ còn ${stock}, cần ${qty}`,
              );
            }
          }
        }

        /* =============================================
             PASS 2
             TRỪ KHO + HISTORY
          ============================================= */

        for (const item of order.items) {
          const product = productCache.get(String(item.productId));

          if (!product) {
            throw new Error("Không tìm thấy sản phẩm");
          }

          const qty = toNumber(item.qty);

          const variantName = String(item.variantName || "").trim();

          /* =========================================
               CÓ VARIANT
            ========================================= */

          if (variantName) {
            const variant = findVariant(product, variantName);

            if (!variant) {
              throw new Error(
                `Không tìm thấy variant "${variantName}" của sản phẩm "${product.title}"`,
              );
            }

            const beforeVariantQty = toNumber(variant.qty);

            const afterVariantQty = beforeVariantQty - qty;

            variant.qty = afterVariantQty;

            const beforeProductQty = toNumber(product.qty);

            const afterProductQty = Math.max(0, beforeProductQty - qty);

            product.qty = afterProductQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            await InventoryHistory.create(
              [
                {
                  type: "order",

                  referenceType: "Order",

                  referenceId: order._id,

                  referenceCode: order.code || "",

                  productId: product._id,

                  productTitle: product.title || "",

                  productCode: getProductCode(product),

                  variantName,

                  qty: -qty,

                  beforeQty: beforeVariantQty,

                  afterQty: afterVariantQty,

                  note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

                  createdBy: req.user?._id || null,

                  rollback: false,

                  rollback_at: null,

                  rollbackBy: null,

                  created_at: new Date(),
                },
              ],
              {
                session,
              },
            );

            result.updatedItems++;
            result.historyRecords++;
          } else {
            /* =========================================
               KHÔNG VARIANT
            ========================================= */
            const beforeQty = toNumber(product.qty);

            const afterQty = Math.max(0, beforeQty - qty);

            product.qty = afterQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            await InventoryHistory.create(
              [
                {
                  type: "order",

                  referenceType: "Order",

                  referenceId: order._id,

                  referenceCode: order.code || "",

                  productId: product._id,

                  productTitle: product.title || "",

                  productCode: getProductCode(product),

                  variantName: "",

                  qty: -qty,

                  beforeQty,

                  afterQty,

                  note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

                  createdBy: req.user?._id || null,

                  rollback: false,

                  rollback_at: null,

                  rollbackBy: null,

                  created_at: new Date(),
                },
              ],
              {
                session,
              },
            );

            result.updatedItems++;
            result.historyRecords++;
          }
        }

        /* =============================================
             ĐÁNH DẤU ĐÃ TRỪ KHO
             
             KHÔNG ĐỔI STATUS
          ============================================= */

        order.stockDeducted = true;

        order.updated_at = new Date();

        await order.save({
          session,
        });

        result.updatedOrders++;
      }
    });

    return res.status(200).json({
      success: true,

      message: "Đồng bộ tồn kho thành công",

      totalOrders: result.totalOrders,

      updatedOrders: result.updatedOrders,

      updatedItems: result.updatedItems,

      historyRecords: result.historyRecords,

      skippedOrders: result.skippedOrders,
    });
  } catch (error) {
    console.error("syncOrderStockAsync:", error);

    return res.status(400).json({
      success: false,

      message: error?.message || "Không thể đồng bộ tồn kho",
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

    const result = {
      historyRecords: 0,
      restoredItems: 0,
    };

    await session.withTransaction(async () => {
      /* ===============================================
           1. TÌM ORDER
        =============================================== */

      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.stockDeducted !== true) {
        throw new Error("Đơn hàng này chưa được trừ tồn kho");
      }

      /* ===============================================
           2. TÌM HISTORY
        =============================================== */

      const histories = await InventoryHistory.find({
        referenceType: "Order",

        referenceId: order._id,

        type: "order",

        rollback: {
          $ne: true,
        },
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

      /* ===============================================
           3. CACHE PRODUCT
        =============================================== */

      const productCache = new Map();

      /* ===============================================
           4. ROLLBACK HISTORY
        =============================================== */

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

        /* =============================================
             HISTORY QTY
          ============================================= */

        const historyQty = Number(history.qty || 0);

        const restoreQty = Math.abs(historyQty);

        if (!Number.isFinite(restoreQty) || restoreQty <= 0) {
          continue;
        }

        const variantName = String(history.variantName || "").trim();

        /* =============================================
             CÓ VARIANT
          ============================================= */

        if (variantName) {
          const variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Không tìm thấy variant "${variantName}" của sản phẩm "${product.title}"`,
            );
          }

          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty + restoreQty;

          variant.qty = afterVariantQty;

          /* -------------------------------------------
               TĂNG TỒN TỔNG
            ------------------------------------------- */

          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty + restoreQty;

          product.qty = afterProductQty;

          product.updated_at = new Date();

          await product.save({
            session,
          });
        } else {
          /* =============================================
             KHÔNG VARIANT
          ============================================= */
          const beforeQty = toNumber(product.qty);

          const afterQty = beforeQty + restoreQty;

          product.qty = afterQty;

          product.updated_at = new Date();

          await product.save({
            session,
          });
        }

        /* =============================================
             ĐÁNH DẤU HISTORY ROLLBACK
          ============================================= */

        history.rollback = true;

        history.rollback_at = new Date();

        history.rollbackBy = req.user?._id || null;

        await history.save({
          session,
        });

        result.historyRecords++;

        result.restoredItems++;
      }

      /* ===============================================
           5. ĐÁNH DẤU ORDER KHÔNG CÒN TRỪ KHO
           
           KHÔNG ĐỔI STATUS
        =============================================== */

      order.stockDeducted = false;

      order.updated_at = new Date();

      await order.save({
        session,
      });
    });

    return res.status(200).json({
      success: true,

      message: "Rollback tồn kho thành công",

      historyRecords: result.historyRecords,

      restoredItems: result.restoredItems,
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
   GET PRODUCT PRICE
========================================================= */

const getProductPrice = (product, variantName = "") => {
  const name = String(variantName || "").trim();

  /* =====================================================
     KHÔNG CÓ VARIANT
  ===================================================== */

  if (!name) {
    return {
      price: toNumber(product?.price),

      variant: null,
    };
  }

  /* =====================================================
     CÓ VARIANT
  ===================================================== */

  const variant = findVariant(product, name);

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

  const price = toNumber(newPrice);

  const cleanVariantName = String(variantName || "").trim();

  const orders = await Order.find({
    status: {
      $in: UNCOMPLETED_STATUSES,
    },

    "items.productId": productId,
  });

  let updatedOrders = 0;

  for (const order of orders) {
    let changed = false;

    if (Array.isArray(order.items)) {
      for (const item of order.items) {
        if (String(item.productId) !== String(productId)) {
          continue;
        }

        const itemVariantName = String(item.variantName || "").trim();

        /* =============================================
             KHÔNG VARIANT
          ============================================= */

        if (!cleanVariantName && !itemVariantName) {
          item.price = price;

          item.total = toNumber(item.qty) * price;

          changed = true;

          continue;
        }

        /* =============================================
             CÓ VARIANT
          ============================================= */

        if (cleanVariantName && itemVariantName === cleanVariantName) {
          item.price = price;

          item.total = toNumber(item.qty) * price;

          changed = true;
        }
      }
    }

    if (!changed) {
      continue;
    }

    calculateOrderTotal(order);

    await order.save();

    updatedOrders++;
  }

  return updatedOrders;
};

/* =========================================================
   SYNC ALL PRODUCT VARIANT PRICES
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
      let orderChanged = false;

      if (!Array.isArray(order.items)) {
        continue;
      }

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

        /* =============================================
             SNAPSHOT PRODUCT
          ============================================= */

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
    const lastNumber = Number(lastOrder.code.split("-")[1]) || 0;

    sequence = lastNumber + 1;
  }

  return `${prefix}-` + `${String(sequence).padStart(4, "0")}`;
};

/* =========================================================
   CREATE ORDER
   TẠO ĐƠN = TỰ ĐỘNG TRỪ KHO + HISTORY
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

    /* =====================================================
       VALIDATE ITEMS
    ===================================================== */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,

        message: "Đơn hàng chưa có sản phẩm",
      });
    }

    /* =====================================================
       VALIDATE CUSTOMER
    ===================================================== */

    if (customerId && !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,

        message: "customerId không hợp lệ",
      });
    }

    /* =====================================================
       MONEY
    ===================================================== */

    const discountNumber = Math.max(0, toNumber(discount));

    const shippingNumber = Math.max(0, toNumber(shippingFee));

    const paidNumber = Math.max(0, toNumber(paidAmount));

    /* =====================================================
       PAYMENT
    ===================================================== */

    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,

        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    let createdOrder = null;

    await session.withTransaction(async () => {
      /* =================================================
           CUSTOMER
        ================================================= */

      let customer = null;

      if (customerId) {
        customer = await Customer.findById(customerId).session(session);

        if (!customer) {
          throw new Error("Không tìm thấy khách hàng");
        }
      }

      /* =================================================
           MERGE PRODUCT + VARIANT
        ================================================= */

      const mergedItems = {};

      for (const item of items) {
        if (
          !item?.productId ||
          !mongoose.Types.ObjectId.isValid(item.productId)
        ) {
          throw new Error("productId không hợp lệ");
        }

        const qty = toNumber(item.qty);

        if (qty <= 0) {
          throw new Error("Số lượng sản phẩm phải lớn hơn 0");
        }

        const variantName = String(item.variantName || "").trim();

        const key = `${item.productId}_${variantName}`;

        if (!mergedItems[key]) {
          mergedItems[key] = {
            productId: item.productId,

            variantName,

            qty: 0,
          };
        }

        mergedItems[key].qty += qty;
      }

      /* =================================================
           PROCESS PRODUCTS
        ================================================= */

      const orderItems = [];

      const inventoryHistories = [];

      const productCache = new Map();

      let subtotal = 0;

      for (const item of Object.values(mergedItems)) {
        /* ===============================================
             GET PRODUCT
          =============================================== */

        let product = productCache.get(String(item.productId));

        if (!product) {
          product = await Product.findById(item.productId).session(session);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
          }

          productCache.set(String(item.productId), product);
        }

        /* ===============================================
             PRICE
          =============================================== */

        let price = toNumber(product.price);

        let variant = null;

        const variantName = String(item.variantName || "").trim();

        /* ===============================================
             VARIANT
          =============================================== */

        if (variantName) {
          variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${variantName}" của sản phẩm "${product.title}"`,
            );
          }

          price = toNumber(variant.price);
        }

        /* ===============================================
             STOCK
          =============================================== */

        const stock = variant ? toNumber(variant.qty) : toNumber(product.qty);

        if (stock < item.qty) {
          throw new Error(
            `Sản phẩm "${product.title}"${
              variantName ? ` - ${variantName}` : ""
            } chỉ còn ${stock}, cần ${item.qty}`,
          );
        }

        /* ===============================================
             TOTAL ITEM
          =============================================== */

        const itemTotal = price * item.qty;

        subtotal += itemTotal;

        /* ===============================================
             BEFORE STOCK
          =============================================== */

        const beforeProductQty = toNumber(product.qty);

        /* =================================================
             CÓ VARIANT
          ================================================= */

        if (variant) {
          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty - item.qty;

          const afterProductQty = Math.max(0, beforeProductQty - item.qty);

          /* -----------------------------------------------
               TRỪ VARIANT
            ----------------------------------------------- */

          variant.qty = afterVariantQty;

          /* -----------------------------------------------
               TRỪ TỔNG PRODUCT
            ----------------------------------------------- */

          product.qty = afterProductQty;

          /* -----------------------------------------------
               HISTORY
            ----------------------------------------------- */

          inventoryHistories.push({
            type: "order",

            referenceType: "Order",

            referenceId: null,

            referenceCode: "",

            productId: product._id,

            productTitle: product.title || "",

            productCode: getProductCode(product),

            variantName,

            qty: -Math.abs(item.qty),

            beforeQty: beforeVariantQty,

            afterQty: afterVariantQty,

            note: "",

            createdBy: req.user?._id || null,

            rollback: false,

            rollback_at: null,

            rollbackBy: null,

            created_at: new Date(),
          });
        } else {
          /* =================================================
             KHÔNG CÓ VARIANT
          ================================================= */
          const afterProductQty = Math.max(0, beforeProductQty - item.qty);

          product.qty = afterProductQty;

          /* -----------------------------------------------
               HISTORY
            ----------------------------------------------- */

          inventoryHistories.push({
            type: "order",

            referenceType: "Order",

            referenceId: null,

            referenceCode: "",

            productId: product._id,

            productTitle: product.title || "",

            productCode: getProductCode(product),

            variantName: "",

            qty: -Math.abs(item.qty),

            beforeQty: beforeProductQty,

            afterQty: afterProductQty,

            note: "",

            createdBy: req.user?._id || null,

            rollback: false,

            rollback_at: null,

            rollbackBy: null,

            created_at: new Date(),
          });
        }

        /* ===============================================
             SAVE PRODUCT
          =============================================== */

        product.updated_at = new Date();

        await product.save({
          session,
        });

        /* ===============================================
             ORDER ITEM
          =============================================== */

        orderItems.push({
          productId: product._id,

          productTitle: product.title || "",

          productCode: getProductCode(product),

          variantName,

          price,

          qty: item.qty,

          total: itemTotal,

          thumbnail: product.thumbnail || "",
        });
      }

      /* =================================================
           TOTAL
        ================================================= */

      const totalAmount = Math.max(
        0,
        subtotal - discountNumber + shippingNumber,
      );

      if (paidNumber > totalAmount) {
        throw new Error("Số tiền khách trả không được lớn hơn tổng tiền");
      }

      const debt = Math.max(0, totalAmount - paidNumber);

      /* =================================================
           ORDER CODE
        ================================================= */

      const code = await generateOrderCode();

      /* =================================================
           CREATE ORDER
        ================================================= */

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

        /*
         * QUAN TRỌNG:
         * Tạo đơn đã trừ kho
         */
        stockDeducted: true,

        note: String(note || "").trim(),

        created_at: new Date(),

        updated_at: new Date(),
      });

      await order.save({
        session,
      });

      /* =================================================
           UPDATE INVENTORY HISTORY
        ================================================= */

      for (const history of inventoryHistories) {
        history.referenceId = order._id;

        history.referenceCode = order.code;

        history.note = `Xuất kho theo đơn hàng ${order.code}`;
      }

      /* =================================================
           INSERT HISTORY
        ================================================= */

      if (inventoryHistories.length > 0) {
        await InventoryHistory.insertMany(inventoryHistories, {
          session,

          ordered: true,
        });
      }

      /* =================================================
           CUSTOMER
        ================================================= */

      if (customer) {
        customer.totalOrders = toNumber(customer.totalOrders) + 1;

        customer.totalSpent = toNumber(customer.totalSpent) + paidNumber;

        customer.debt = toNumber(customer.debt) + debt;

        customer.updated_at = new Date();

        await customer.save({
          session,
        });
      }

      createdOrder = order;
    });

    /* =====================================================
       RESPONSE
    ===================================================== */

    return res.status(201).json({
      success: true,

      message: "Tạo đơn hàng thành công và đã trừ tồn kho",

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

    const filter = {};

    if (status) {
      filter.status = status;
    }

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
========================================================= */

const updateOrderStatusAsync = async (req, res) => {
  try {
    const { id } = req.params;

    const { status: newStatus } = req.body;

    console.log("update order status:", id, newStatus);

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

    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,

        message: "Không tìm thấy đơn hàng",
      });
    }

    /* ===================================================
         HOÀN THÀNH ĐƠN
      =================================================== */

    if (newStatus === "completed" && order.status !== "completed") {
      const productCache = new Map();

      for (const item of order.items || []) {
        if (!item?.productId) {
          continue;
        }

        const productId = String(item.productId);

        let product = productCache.get(productId);

        if (!product) {
          product = await Product.findById(item.productId).lean();

          productCache.set(productId, product || null);
        }

        if (!product) {
          continue;
        }

        /* ===============================================
             LẤY GIÁ HIỆN TẠI
          =============================================== */

        const { price: sellingPrice } = getProductPrice(
          product,
          item.variantName || "",
        );

        if (sellingPrice === null) {
          continue;
        }

        item.price = sellingPrice;

        item.total = sellingPrice * toNumber(item.qty);
      }

      /* ===============================================
           CALCULATE TOTAL
        =============================================== */

      calculateOrderTotal(order);

      /*
       * Khi hoàn thành:
       * thanh toán đủ
       */
      order.paidAmount = order.totalAmount;

      order.debt = 0;
    }

    /* ===================================================
         UPDATE STATUS
      =================================================== */

    order.status = newStatus;

    order.updated_at = new Date();

    await order.save();

    return res.status(200).json({
      success: true,

      message:
        newStatus === "completed"
          ? "Đơn hàng đã hoàn thành và đã chốt giá thanh toán"
          : "Cập nhật trạng thái đơn hàng thành công",

      order,
    });
  } catch (error) {
    console.error("updateOrderStatusAsync:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Không thể cập nhật trạng thái đơn hàng",
    });
  }
};

/* =========================================================
   SYNC PRODUCT PRICE API
========================================================= */

const syncProductPriceAsync = async (req, res) => {
  try {
    const { productId, variantName = "", newPrice } = req.body;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,

        message: "productId không hợp lệ",
      });
    }

    const price = Number(newPrice);

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,

        message: "Giá mới không hợp lệ",
      });
    }

    const updatedOrders = await syncProductPriceToOrders({
      productId,

      variantName,

      newPrice: price,
    });

    return res.status(200).json({
      success: true,

      message: "Đã đồng bộ giá mới vào đơn hàng chưa hoàn thành",

      updatedOrders,

      productId,

      variantName: String(variantName || "").trim(),

      newPrice: price,
    });
  } catch (error) {
    console.error("syncProductPriceAsync:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Không thể đồng bộ giá sản phẩm",
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
};
