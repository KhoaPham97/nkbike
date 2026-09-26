const mongoose = require("mongoose");

const Order = require("../models/orders");
const Customer = require("../models/customer");
const { Product } = require("../models/products");

// inventoryHistory.js export trực tiếp model
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
           MERGE ITEM
        ================================================= */

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
          });
        }

        const current = mergedItems.get(key);

        current.qty += qty;
      }

      /* =================================================
           LOAD PRODUCTS
        ================================================= */

      const productCache = new Map();

      const orderItems = [];

      const inventoryHistories = [];

      let subtotal = 0;

      /* =================================================
           PROCESS ITEMS
        ================================================= */

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

        let variant = null;

        let price = toNumber(product.price);

        /* =================================================
             VARIANT
          ================================================= */

        if (variantName) {
          variant = findVariant(product, variantName);

          if (!variant) {
            throw new Error(
              `Không tìm thấy phân loại "${variantName}" của sản phẩm "${product.title}"`,
            );
          }

          price = toNumber(variant.price);
        }

        /* =================================================
             CHECK STOCK
          ================================================= */

        const stock = variant ? toNumber(variant.qty) : toNumber(product.qty);

        if (stock < item.qty) {
          throw new Error(
            `Sản phẩm "${product.title}"${
              variantName ? ` - ${variantName}` : ""
            } chỉ còn ${stock}, cần ${item.qty}`,
          );
        }

        /* =================================================
             ITEM TOTAL
          ================================================= */

        const itemTotal = price * item.qty;

        subtotal += itemTotal;

        /* =================================================
             DEDUCT STOCK
          ================================================= */

        if (variant) {
          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty - item.qty;

          if (afterVariantQty < 0) {
            throw new Error(`Tồn variant "${variantName}" không đủ`);
          }

          variant.qty = afterVariantQty;

          /* ---------------------------------------------
               PRODUCT TOTAL STOCK
            --------------------------------------------- */

          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty - item.qty;

          if (afterProductQty < 0) {
            throw new Error(`Tồn tổng sản phẩm "${product.title}" không đủ`);
          }

          product.qty = afterProductQty;

          /* ---------------------------------------------
               HISTORY
            --------------------------------------------- */

          inventoryHistories.push({
            product,
            variantName,
            qty: item.qty,
            beforeQty: beforeVariantQty,
            afterQty: afterVariantQty,
          });
        } else {
          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty - item.qty;

          if (afterProductQty < 0) {
            throw new Error(`Tồn sản phẩm "${product.title}" không đủ`);
          }

          product.qty = afterProductQty;

          /* ---------------------------------------------
               HISTORY
            --------------------------------------------- */

          inventoryHistories.push({
            product,
            variantName: "",
            qty: item.qty,
            beforeQty: beforeProductQty,
            afterQty: afterProductQty,
          });
        }

        /* =================================================
             SAVE PRODUCT
          ================================================= */

        product.updated_at = new Date();

        await product.save({
          session,
        });

        /* =================================================
             ORDER ITEM SNAPSHOT
          ================================================= */

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
         * TẠO ĐƠN ĐÃ TRỪ KHO
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
           CREATE INVENTORY HISTORY
        ================================================= */

      const historyDocuments = inventoryHistories.map((history) =>
        buildInventoryHistory({
          order,

          product: history.product,

          variantName: history.variantName,

          qty: history.qty,

          beforeQty: history.beforeQty,

          afterQty: history.afterQty,

          userId: req.user?._id || null,
        }),
      );

      if (historyDocuments.length > 0) {
        await InventoryHistory.insertMany(historyDocuments, {
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

    let result = {
      historyRecords: 0,
      restoredItems: 0,
      restoredQty: 0,
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
         
         Chỉ lấy lịch sử xuất kho của đơn này.
         Không lấy những history đã rollback trước đó.
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
             RESTORE VARIANT QTY
          --------------------------------------------- */

          const beforeVariantQty = toNumber(variant.qty);

          const afterVariantQty = beforeVariantQty + restoreQty;

          variant.qty = afterVariantQty;

          /* ---------------------------------------------
             RESTORE PRODUCT TOTAL QTY
          --------------------------------------------- */

          const beforeProductQty = toNumber(product.qty);

          const afterProductQty = beforeProductQty + restoreQty;

          product.qty = afterProductQty;

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

          product.updated_at = new Date();

          await product.save({
            session,
          });
        }

        result.historyRecords++;
        result.restoredItems++;
        result.restoredQty += restoreQty;
      }

      /* =================================================
         XÓA LỊCH SỬ XUẤT KHO
         
         Không dùng:
           history.rollback = true

         Vì yêu cầu là rollback xong thì
         lịch sử xuất kho của đơn phải biến mất.
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

      /* =================================================
         UPDATE RESULT
      ================================================= */

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
         UPDATE CUSTOMER
         
         Rollback đơn:
         - Không trừ totalOrders
         - Không trừ totalSpent
         - Công nợ phải được đồng bộ lại từ các đơn
         
         Vì Customer.debt có thể đã lệch.
      ================================================= */

      if (order.customerId) {
        const customer = await Customer.findById(order.customerId).session(
          session,
        );

        if (customer) {
          /* ---------------------------------------------
             TÍNH LẠI CÔNG NỢ TỪ TOÀN BỘ ĐƠN
          --------------------------------------------- */

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

    /* =====================================================
       RESPONSE
    ===================================================== */

    return res.status(200).json({
      success: true,

      message: "Rollback tồn kho thành công, đã xóa lịch sử xuất kho",

      historyRecords: result.historyRecords,

      restoredItems: result.restoredItems,

      restoredQty: result.restoredQty,
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
       ORDER ID
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

      for (const order of orders) {
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

        /* =================================================
             PASS 1 - CHECK ALL STOCK
          ================================================= */

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
              throw new Error(`Không tìm thấy sản phẩm ${item.productId}`);
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
            const stock = toNumber(product.qty);

            if (stock < qty) {
              throw new Error(
                `Sản phẩm "${product.title}" chỉ còn ${stock}, cần ${qty}`,
              );
            }
          }
        }

        /* =================================================
             PASS 2 - DEDUCT
          ================================================= */

        for (const item of order.items) {
          const product = productCache.get(String(item.productId));

          if (!product) {
            throw new Error("Không tìm thấy sản phẩm");
          }

          const qty = toNumber(item.qty);

          const variantName = String(item.variantName || "").trim();

          if (variantName) {
            const variant = findVariant(product, variantName);

            if (!variant) {
              throw new Error(`Không tìm thấy variant "${variantName}"`);
            }

            const beforeVariantQty = toNumber(variant.qty);

            const afterVariantQty = beforeVariantQty - qty;

            const beforeProductQty = toNumber(product.qty);

            const afterProductQty = beforeProductQty - qty;

            if (afterVariantQty < 0 || afterProductQty < 0) {
              throw new Error(
                `Tồn kho không đủ cho sản phẩm "${product.title}"`,
              );
            }

            variant.qty = afterVariantQty;

            product.qty = afterProductQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            await InventoryHistory.create(
              [
                buildInventoryHistory({
                  order,

                  product,

                  variantName,

                  qty,

                  beforeQty: beforeVariantQty,

                  afterQty: afterVariantQty,

                  userId: req.user?._id || null,
                }),
              ],
              {
                session,
              },
            );
          } else {
            const beforeQty = toNumber(product.qty);

            const afterQty = beforeQty - qty;

            if (afterQty < 0) {
              throw new Error(
                `Tồn kho không đủ cho sản phẩm "${product.title}"`,
              );
            }

            product.qty = afterQty;

            product.updated_at = new Date();

            await product.save({
              session,
            });

            await InventoryHistory.create(
              [
                buildInventoryHistory({
                  order,

                  product,

                  variantName: "",

                  qty,

                  beforeQty,

                  afterQty,

                  userId: req.user?._id || null,
                }),
              ],
              {
                session,
              },
            );
          }

          result.updatedItems++;

          result.historyRecords++;
        }

        /* =================================================
             MARK STOCK DEDUCTED
          ================================================= */

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

    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,

        message: "Không tìm thấy đơn hàng",
      });
    }

    /* ===================================================
         CANCEL ORDER
         
         KHÔNG TỰ ĐỘNG ROLLBACK Ở ĐÂY.
         Muốn hoàn kho phải gọi API rollback.
      =================================================== */

    if (newStatus === "cancelled" && order.stockDeducted === true) {
      return res.status(400).json({
        success: false,

        message: "Đơn hàng đã trừ kho. Hãy rollback tồn kho trước khi huỷ đơn.",
      });
    }

    /* ===================================================
         COMPLETED
         
         KHÔNG ĐỔI GIÁ.
         Giá trong order.items là giá đã chốt.
      =================================================== */

    if (newStatus === "completed" && order.status !== "completed") {
      calculateOrderTotal(order);

      /*
       * Khi hoàn thành:
       * chốt công nợ hiện tại.
       *
       * KHÔNG lấy giá sản phẩm
       * hiện tại để thay vào order.
       */

      order.paidAmount = Math.min(
        toNumber(order.paidAmount),
        toNumber(order.totalAmount),
      );

      order.debt = Math.max(
        0,
        toNumber(order.totalAmount) - toNumber(order.paidAmount),
      );
    }

    /* ===================================================
         UPDATE STATUS
      =================================================== */

    order.status = newStatus;

    order.updated_at = new Date();

    await order.save();

    return res.status(200).json({
      success: true,

      message: "Cập nhật trạng thái đơn hàng thành công",

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
};
