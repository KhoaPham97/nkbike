const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/customer");
const { Product } = require("../models/products");
const { InventoryHistory } = require("../models/inventoryHistory");
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
const syncOrderStockAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orderId } = req.body || {};

    const filter = {
      stockDeducted: {
        $ne: true,
      },

      // Không đồng bộ đơn đã hủy
      status: {
        $ne: "cancelled",
      },
    };

    // Nếu FE truyền orderId thì chỉ đồng bộ đơn đó
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

      for (const order of orders) {
        // =====================================================
        // KIỂM TRA ĐƠN KHÔNG CÓ SẢN PHẨM
        // =====================================================
        if (!Array.isArray(order.items) || order.items.length === 0) {
          // Chỉ đánh dấu đã kiểm tra tồn kho
          // KHÔNG thay đổi trạng thái đơn
          order.stockDeducted = true;
          order.updated_at = new Date();

          await order.save({
            session,
          });

          result.skippedOrders++;

          continue;
        }

        // Cache product để tránh query Mongo nhiều lần
        const productCache = new Map();

        // =====================================================
        // PASS 1
        // KIỂM TRA TOÀN BỘ TỒN KHO TRƯỚC
        // =====================================================
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
                `Không tìm thấy sản phẩm ${item.productId} trong đơn ${order.code || order._id}`,
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

          // ===================================================
          // CÓ VARIANT
          // ===================================================
          if (variantName) {
            const variant = product.variants?.find(
              (v) => String(v?.name || "").trim() === variantName,
            );

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
          }

          // ===================================================
          // KHÔNG CÓ VARIANT
          // ===================================================
          else {
            const stock = toNumber(product.qty);

            if (stock < qty) {
              throw new Error(
                `Sản phẩm "${product.title}" chỉ còn ${stock}, cần ${qty}`,
              );
            }
          }
        }

        // =====================================================
        // PASS 2
        // TRỪ TỒN + GHI LỊCH SỬ
        // =====================================================
        for (const item of order.items) {
          const product = productCache.get(String(item.productId));

          if (!product) {
            throw new Error("Không tìm thấy sản phẩm");
          }

          const qty = toNumber(item.qty);

          const variantName = String(item.variantName || "").trim();

          // ===================================================
          // CÓ VARIANT
          // ===================================================
          if (variantName) {
            const variant = product.variants?.find(
              (v) => String(v?.name || "").trim() === variantName,
            );

            if (!variant) {
              throw new Error(
                `Không tìm thấy variant "${variantName}" của sản phẩm "${product.title}"`,
              );
            }

            const beforeVariantQty = toNumber(variant.qty);

            const afterVariantQty = beforeVariantQty - qty;

            // -----------------------------------------------
            // Trừ tồn variant
            // -----------------------------------------------
            variant.qty = afterVariantQty;

            // -----------------------------------------------
            // Trừ tồn tổng sản phẩm
            // Giữ nguyên logic createOrderAsync hiện tại
            // -----------------------------------------------
            const beforeProductQty = toNumber(product.qty);

            const afterProductQty = Math.max(0, beforeProductQty - qty);

            product.qty = afterProductQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            // -----------------------------------------------
            // Lưu lịch sử kho
            // -----------------------------------------------
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

                  // Xuất kho = số âm
                  qty: -qty,

                  // Tồn của variant
                  beforeQty: beforeVariantQty,

                  afterQty: afterVariantQty,

                  note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

                  createdBy: req.user?._id || null,

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

          // ===================================================
          // KHÔNG CÓ VARIANT
          // ===================================================
          else {
            const beforeQty = toNumber(product.qty);

            const afterQty = Math.max(0, beforeQty - qty);

            product.qty = afterQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            // -----------------------------------------------
            // Lưu lịch sử kho
            // -----------------------------------------------
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

                  // Xuất kho = số âm
                  qty: -qty,

                  beforeQty,

                  afterQty,

                  note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

                  createdBy: req.user?._id || null,

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

        // =====================================================
        // ĐÁNH DẤU ĐÃ ĐỒNG BỘ TỒN KHO
        //
        // QUAN TRỌNG:
        // KHÔNG thay đổi status của order
        // =====================================================
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

    let result = {
      historyRecords: 0,
      restoredItems: 0,
    };

    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);

      if (!order) {
        throw new Error("Không tìm thấy đơn hàng");
      }

      if (order.stockDeducted !== true) {
        throw new Error("Đơn hàng này chưa được đồng bộ tồn kho");
      }

      const histories = await InventoryHistory.find({
        referenceType: "Order",
        referenceId: order._id,
        type: "order",
        rollback: {
          $ne: true,
        },
      }).session(session);

      if (!histories.length) {
        throw new Error("Không tìm thấy lịch sử xuất kho để rollback");
      }

      for (const history of histories) {
        const product = await Product.findById(history.productId).session(
          session,
        );

        if (!product) {
          throw new Error(`Không tìm thấy sản phẩm ${history.productId}`);
        }

        const restoreQty = Math.abs(Number(history.qty || 0));

        if (restoreQty <= 0) {
          continue;
        }

        // ==========================================
        // CÓ VARIANT
        // ==========================================
        if (history.variantName) {
          const variant = product.variants?.find(
            (item) =>
              String(item?.name || "").trim() ===
              String(history.variantName).trim(),
          );

          if (!variant) {
            throw new Error(`Không tìm thấy variant "${history.variantName}"`);
          }

          variant.qty = Number(variant.qty || 0) + restoreQty;

          // Tồn tổng sản phẩm
          product.qty = Number(product.qty || 0) + restoreQty;
        }

        // ==========================================
        // KHÔNG CÓ VARIANT
        // ==========================================
        else {
          product.qty = Number(product.qty || 0) + restoreQty;
        }

        product.updated_at = new Date();

        await product.save({
          session,
        });

        // Đánh dấu history đã rollback
        history.rollback = true;
        history.rollback_at = new Date();
        history.rollbackBy = req.user?._id || null;

        await history.save({
          session,
        });

        result.historyRecords++;
        result.restoredItems++;
      }

      // Đơn không còn được đánh dấu đã trừ kho
      order.stockDeducted = false;
      order.updated_at = new Date();

      await order.save({
        session,
      });
    });

    return res.status(200).json({
      success: true,
      message: "Rollback tồn kho thành công",
      ...result,
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

  if (!name) {
    return {
      price: toNumber(product?.price),
      variant: null,
    };
  }

  const variant = product?.variants?.find(
    (item) => String(item?.name || "").trim() === name,
  );

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
   TO UNCOMPLETED ORDERS
========================================================= */

/**
 * Khi Product hoặc Variant thay đổi giá,
 * gọi hàm này để cập nhật các đơn:
 *
 * pending
 * confirmed
 * shipping
 *
 * Không cập nhật:
 *
 * completed
 * cancelled
 *
 * productId:
 * ID sản phẩm
 *
 * variantName:
 * tên variant, nếu sản phẩm có variant
 *
 * newPrice:
 * giá mới
 */
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

        /*
         * Sản phẩm không có variant
         */
        if (!cleanVariantName && !itemVariantName) {
          item.price = price;

          item.total = toNumber(item.qty) * price;

          changed = true;

          continue;
        }

        /*
         * Sản phẩm có variant
         */
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

/**
 * Đồng bộ toàn bộ giá hiện tại của Product
 * vào các đơn chưa hoàn thành.
 *
 * Dùng trong trường hợp muốn chạy thủ công
 * hoặc đồng bộ lại toàn bộ dữ liệu.
 */
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

        /*
         * Cập nhật thêm thông tin snapshot
         * nếu sản phẩm đã thay đổi tên/mã.
         *
         * Không bắt buộc nhưng hữu ích.
         */
        if (product.title) {
          item.productTitle = product.title;
        }

        const productCode = getProductCode(product);

        if (productCode) {
          item.productCode = productCode;
        }

        /*
         * Nếu variant tồn tại thì giữ variantName
         */
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

      message: "Không thể đồng bộ giá đơn hàng",
    });
  }
};

/* =========================================================
   GENERATE ORDER CODE
   DH20260923-0001
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
    } = req.body;

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
       PAYMENT METHOD
    ===================================================== */

    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,

        message: "Phương thức thanh toán không hợp lệ",
      });
    }

    let createdOrder = null;

    await session.withTransaction(async () => {
      /* ================================================
           CUSTOMER
        ================================================ */

      let customer = null;

      if (customerId) {
        customer = await Customer.findById(customerId).session(session);

        if (!customer) {
          throw new Error("Không tìm thấy khách hàng");
        }
      }

      /* ================================================
           MERGE SAME PRODUCT + VARIANT
        ================================================ */

      const mergedItems = {};

      for (const item of items) {
        if (
          !item.productId ||
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

      /* ================================================
           PROCESS PRODUCTS
        ================================================ */

      const orderItems = [];

      let subtotal = 0;

      for (const item of Object.values(mergedItems)) {
        const product = await Product.findById(item.productId).session(session);

        if (!product) {
          throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
        }

        let price = toNumber(product.price);

        let stock = toNumber(product.qty);

        let variant = null;

        /* ==============================================
             VARIANT
          ============================================== */

        if (item.variantName) {
          variant = product.variants?.find(
            (v) => String(v.name || "").trim() === item.variantName,
          );

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${item.variantName}" của sản phẩm "${product.title}"`,
            );
          }

          price = toNumber(variant.price);

          stock = toNumber(variant.qty);
        }

        /* ==============================================
             CHECK STOCK
          ============================================== */

        if (stock < item.qty) {
          throw new Error(
            `Sản phẩm "${product.title}" ${
              item.variantName ? `- ${item.variantName} ` : ""
            }chỉ còn ${stock}`,
          );
        }

        /* ==============================================
             TOTAL
          ============================================== */

        const itemTotal = price * item.qty;

        subtotal += itemTotal;

        /* ==============================================
             STOCK
          ============================================== */

        if (variant) {
          variant.qty = toNumber(variant.qty) - item.qty;

          product.qty = Math.max(0, toNumber(product.qty) - item.qty);
        } else {
          product.qty = Math.max(0, toNumber(product.qty) - item.qty);
        }

        product.updated_at = new Date();

        await product.save({
          session,
        });

        /* ==============================================
             ORDER ITEM SNAPSHOT
          ============================================== */

        orderItems.push({
          productId: product._id,

          productTitle: product.title || "",

          productCode: getProductCode(product),

          variantName: item.variantName,

          price,

          qty: item.qty,

          total: itemTotal,

          thumbnail: product.thumbnail || "",
        });
      }

      /* ================================================
           TOTAL
        ================================================ */

      const totalAmount = Math.max(
        0,
        subtotal - discountNumber + shippingNumber,
      );

      if (paidNumber > totalAmount) {
        throw new Error("Số tiền khách trả không được lớn hơn tổng tiền");
      }

      const debt = Math.max(0, totalAmount - paidNumber);

      /* ================================================
           ORDER CODE
        ================================================ */

      const code = await generateOrderCode();

      /* ================================================
           CREATE ORDER
        ================================================ */

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

        note: String(note || "").trim(),

        created_at: new Date(),

        updated_at: new Date(),
      });

      await order.save({
        session,
      });

      /* ================================================
           CUSTOMER
        ================================================ */

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

    return res.status(201).json({
      success: true,

      message: "Tạo đơn hàng thành công",

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
   GET ORDER
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
   UPDATE STATUS
========================================================= */

const updateOrderStatusAsync = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("id", id);
    const { status: newStatus } = req.body;

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

    // ========================================================
    // KHI HOÀN THÀNH ĐƠN
    // LẤY GIÁ BÁN HIỆN TẠI LÀM GIÁ THANH TOÁN
    // ========================================================

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

        // ----------------------------------------------------
        // LẤY GIÁ BÁN HIỆN TẠI
        // ----------------------------------------------------

        const { price: sellingPrice } = getProductPrice(
          product,
          item.variantName || "",
        );

        // ----------------------------------------------------
        // CHỐT GIÁ BÁN
        // ----------------------------------------------------

        item.price = sellingPrice;

        item.total = sellingPrice * toNumber(item.qty);
      }

      // ------------------------------------------------------
      // TÍNH LẠI TỔNG ĐƠN
      // ------------------------------------------------------

      calculateOrderTotal(order);

      // ------------------------------------------------------
      // KHI HOÀN THÀNH:
      //
      // SỐ TIỀN THANH TOÁN = TỔNG ĐƠN
      // CÔNG NỢ = 0
      // ------------------------------------------------------

      order.paidAmount = order.totalAmount;
      order.debt = 0;
    }

    // ========================================================
    // CẬP NHẬT STATUS
    // ========================================================

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

/**
 * PATCH
 * /orders/sync-product-price
 *
 * Body:
 *
 * {
 *   "productId": "...",
 *   "variantName": "",
 *   "newPrice": 35000
 * }
 *
 * Dùng sau khi Product/Variant được cập nhật giá.
 */
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
